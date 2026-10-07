import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { MoneyError, TaxRule, computeQuote, determineSupplyType, divideRoundHalfUp } from '@ooc/shared';
import { invalidateRenewalOrder } from './renewals';
import type { ScheduledChange } from './subscriptions';

/**
 * Upgrades: a move to a more expensive plan (or more units) of the same product and billing term, effective
 * immediately, paid as a prorated difference for the rest of the current period:
 *
 *     charge = (newPrice × newQty − oldPrice × oldQty) × remaining ÷ periodLength   (+ GST, minimum ₹1)
 *
 * The customer pays an `upgrade` order through hosted checkout (prorated as of quote time; the order expires
 * after 24 hours). On confirmed payment the plan change is handed to the lifecycle worker, which applies it
 * through the app adapter with evidence; renewals then use the new plan. Nothing is provisioned again.
 */

export class UpgradeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MIN_CHARGE_MINOR = 100;
export const UPGRADE_ORDER_TTL_MS = 24 * 3600_000;

const priceInclude = { planVersion: { include: { plan: { include: { product: true } } } } } as const;

export interface UpgradePreview {
  subscriptionId: string;
  fromPriceVersionId: string;
  toPriceVersionId: string;
  toPlanVersionId: string;
  planName: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
  remainingRatio: number;
  differencePerPeriodMinor: number;
  proratedMinor: number;
}

async function loadSubscription(db: PrismaClient | Prisma.TransactionClient, orgId: string, subscriptionId: string) {
  const sub = await db.subscription.findFirst({ where: { id: subscriptionId, orgId } });
  if (!sub) throw new UpgradeError('not_found', 'Subscription not found');
  if (sub.status !== 'active' && sub.status !== 'trialing') throw new UpgradeError('not_active', 'Only active subscriptions can be upgraded');
  if (sub.cancelAtPeriodEnd) throw new UpgradeError('cancellation_scheduled', 'Keep the subscription before upgrading');
  if (sub.scheduledChange || sub.pendingAction) throw new UpgradeError('change_pending', 'Another plan change is pending; withdraw it first');
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) throw new UpgradeError('no_period', 'The subscription has no billing period');
  return sub;
}

/** Prices the upgrade without writing anything. */
export async function previewUpgrade(db: PrismaClient | Prisma.TransactionClient, input: { orgId: string; subscriptionId: string; priceVersionId: string; quantity: number }, now = new Date()): Promise<UpgradePreview> {
  const sub = await loadSubscription(db, input.orgId, input.subscriptionId);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new UpgradeError('invalid_quantity', 'Quantity must be at least 1');
  const [current, target] = await Promise.all([
    db.priceVersion.findUniqueOrThrow({ where: { id: sub.priceVersionId }, include: priceInclude }),
    db.priceVersion.findUnique({ where: { id: input.priceVersionId }, include: priceInclude }),
  ]);
  if (!target || target.kind !== 'subscription' || !target.planVersion.publishedAt || target.planVersion.retiredAt || target.planVersion.plan.product.status !== 'active' || (target.effectiveTo && target.effectiveTo <= now) || target.effectiveFrom > now) {
    throw new UpgradeError('price_not_available', 'That plan is not available');
  }
  if (target.planVersion.plan.productId !== current.planVersion.plan.productId) throw new UpgradeError('different_product', 'Upgrades stay within the same product');
  if (target.billingInterval !== current.billingInterval || target.currency !== current.currency) throw new UpgradeError('different_term', 'Changing the billing term is not supported');
  const diff = minorFromDb(target.amountMinor) * input.quantity - minorFromDb(current.amountMinor) * sub.quantity;
  if (diff <= 0) throw new UpgradeError('not_an_upgrade', 'This plan costs the same or less; schedule it for renewal instead');

  const start = sub.currentPeriodStart!.getTime();
  const end = sub.currentPeriodEnd!.getTime();
  const remainingMs = Math.min(Math.max(end - now.getTime(), 0), end - start);
  if (remainingMs <= 0) throw new UpgradeError('period_ended', 'The current period has ended; upgrade after renewal');
  // Integer arithmetic on seconds keeps the proration exact and reproducible.
  const prorated = Math.max(MIN_CHARGE_MINOR, divideRoundHalfUp(diff * Math.floor(remainingMs / 1000), Math.floor((end - start) / 1000)));
  return {
    subscriptionId: sub.id,
    fromPriceVersionId: current.id,
    toPriceVersionId: target.id,
    toPlanVersionId: target.planVersionId,
    planName: `${target.planVersion.plan.product.name} — ${target.planVersion.plan.name}`,
    quantity: input.quantity,
    periodStart: sub.currentPeriodStart!.toISOString(),
    periodEnd: sub.currentPeriodEnd!.toISOString(),
    remainingRatio: Math.round((remainingMs / (end - start)) * 10_000) / 10_000,
    differencePerPeriodMinor: diff,
    proratedMinor: prorated,
  };
}

/** Creates the quote and the `upgrade` order for the customer to pay; replaces any earlier unpaid upgrade order. */
export async function createUpgradeOrder(db: PrismaClient, input: { orgId: string; subscriptionId: string; priceVersionId: string; quantity: number; actorId: string; sellerStateCode?: string }, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Subscription" WHERE id = ${input.subscriptionId}::uuid FOR UPDATE`);
    const p = await previewUpgrade(tx, input, now);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: input.orgId } });
    const target = await tx.priceVersion.findUniqueOrThrow({ where: { id: p.toPriceVersionId }, include: priceInclude });
    let supplyType;
    try {
      supplyType = determineSupplyType({ sellerStateCode: input.sellerStateCode ?? null, buyerStateCode: org.stateCode, buyerCountry: org.country });
    } catch {
      throw new UpgradeError('billing_details_required', 'Add your GST state code in billing details first');
    }
    const rules = (await tx.taxRule.findMany({ where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } }))
      .map((r) => ({ id: r.id, taxCategory: r.taxCategory, supplyType: r.supplyType, components: r.components as unknown as TaxRule['components'], reviewed: r.reviewed }));
    const fmt = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    let totals;
    try {
      totals = computeQuote(
        [{ planPriceVersionId: target.id, description: `Upgrade to ${p.planName}${p.quantity > 1 ? ` × ${p.quantity}` : ''}, prorated ${fmt(now.toISOString())} – ${fmt(p.periodEnd)}`, unitAmountMinor: p.proratedMinor, quantity: 1, taxCategory: target.planVersion.plan.product.taxCategory, billingInterval: target.billingInterval, currency: 'INR' }],
        supplyType,
        rules,
      );
    } catch (e) {
      if (e instanceof MoneyError) throw new UpgradeError('pricing_failed', e.message);
      throw e;
    }
    // One open upgrade order per subscription.
    await tx.order.updateMany({ where: { subscriptionId: p.subscriptionId, kind: 'upgrade', status: 'awaiting_payment', paymentOrders: { none: { status: { in: ['paid', 'created'] } } } }, data: { status: 'cancelled' } });
    const line = totals.lines[0]!;
    const quote = await tx.quote.create({
      data: {
        orgId: input.orgId,
        status: 'converted',
        supplyType,
        subtotalMinor: BigInt(totals.subtotalMinor),
        discountMinor: 0n,
        taxMinor: BigInt(totals.taxMinor),
        totalMinor: BigInt(totals.totalMinor),
        snapshot: { ...totals, checkoutGroups: 1, upgrade: p } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + UPGRADE_ORDER_TTL_MS),
        acceptedAt: now,
        createdById: input.actorId,
        lines: { create: [{ priceVersionId: target.id, description: line.description, quantity: 1, unitAmountMinor: BigInt(p.proratedMinor), taxMinor: BigInt(line.tax.totalTaxMinor), totalMinor: BigInt(line.totalMinor), billingInterval: target.billingInterval }] },
      },
    });
    const order = await tx.order.create({
      data: {
        orgId: input.orgId,
        quoteId: quote.id,
        kind: 'upgrade',
        subscriptionId: p.subscriptionId,
        status: 'awaiting_payment',
        totalMinor: BigInt(totals.totalMinor),
        idempotencyKey: `upgrade:${p.subscriptionId}:${quote.id}`,
        items: { create: [{ priceVersionId: target.id, quantity: p.quantity, totalMinor: BigInt(totals.totalMinor) }] },
      },
    });
    await tx.auditEvent.create({ data: { actorId: input.actorId, actorType: 'user', orgId: input.orgId, action: 'subscription.upgrade_ordered', targetType: 'subscription', targetId: p.subscriptionId, metadata: { orderId: order.id, ...p } as unknown as Prisma.InputJsonValue } });
    return { orderId: order.id, totalMinor: totals.totalMinor, taxMinor: totals.taxMinor, preview: p };
  });
}

export type UpgradePaymentResult = 'scheduled' | 'subscription_changed';

/** Inside the payment transaction: hands the paid upgrade to the lifecycle worker (applies now, via adapters). */
export async function applyUpgradePayment(tx: Prisma.TransactionClient, orderId: string, now = new Date()): Promise<UpgradePaymentResult> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { quote: true } });
  const p = (order.quote?.snapshot as unknown as { upgrade?: UpgradePreview } | null)?.upgrade;
  if (!p || !order.subscriptionId) return 'subscription_changed';
  const change: ScheduledChange = { planVersionId: p.toPlanVersionId, priceVersionId: p.toPriceVersionId, quantity: p.quantity, effectiveAt: now.toISOString(), requestedAt: now.toISOString() };
  // Only if the subscription is still exactly as quoted (same price, period and nothing else pending).
  const r = await tx.subscription.updateMany({
    where: { id: order.subscriptionId, priceVersionId: p.fromPriceVersionId, currentPeriodEnd: new Date(p.periodEnd), status: { in: ['active', 'trialing'] }, cancelAtPeriodEnd: false, scheduledChange: { equals: Prisma.DbNull }, pendingAction: null },
    data: { scheduledChange: change as unknown as Prisma.InputJsonValue, scheduledChangeDueAt: now, nextLifecycleAttemptAt: null },
  });
  if (r.count !== 1) return 'subscription_changed';
  // A renewal order already issued at the old price is replaced by one at the new price.
  await invalidateRenewalOrder(tx, order.subscriptionId, 'reopen');
  await tx.order.update({ where: { id: orderId }, data: { status: 'active' } });
  await tx.auditEvent.create({ data: { actorType: 'system', orgId: order.orgId, action: 'subscription.upgrade_paid', targetType: 'subscription', targetId: order.subscriptionId, metadata: { orderId } } });
  return 'scheduled';
}

/** Unpaid upgrade orders expire after 24 hours (the proration is only valid around the quote time). */
export async function expireStaleUpgradeOrders(db: PrismaClient, now = new Date()) {
  const r = await db.order.updateMany({
    // A payment that still arrives later is flagged for review (received for an inactive order), never applied.
    where: { kind: 'upgrade', status: 'awaiting_payment', createdAt: { lt: new Date(now.getTime() - UPGRADE_ORDER_TTL_MS) }, paymentOrders: { none: { status: 'paid' } } },
    data: { status: 'expired' },
  });
  return r.count;
}
