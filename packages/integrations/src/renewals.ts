import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { MoneyError, RenewalSettings, TaxRule, computeQuote, determineSupplyType } from '@ooc/shared';
import { addIsoDuration } from './provisioning/engine';
import type { ScheduledChange } from './subscriptions';

/**
 * Customer-paid renewals (used until Cashfree Subscriptions mandates are enabled and verified).
 *
 *  T − noticeDays   renewal order created for the next period (at the downgraded plan if one is scheduled),
 *                   reminder emailed. Payment uses the normal hosted checkout and issues a tax invoice.
 *  T (period end)   unpaid → subscription `past_due`; access continues until graceEndsAt.
 *  T + graceDays    unpaid → suspension requested (reason non_payment); the lifecycle worker switches access off.
 *  T + lapseDays    unpaid → renewal order expires and the subscription ends (data retained).
 *
 * Paying at any point before the lapse extends the subscription from the old period end (continuous service)
 * and restores access if it was suspended for non-payment. One RenewalRun per subscription and period start
 * (unique) guarantees one renewal order and one extension per period.
 */

const DAY = 86_400_000;
type Tx = Prisma.TransactionClient;

export type RenewalStage = 'upcoming' | 'due_tomorrow' | 'overdue' | 'suspension_warning' | 'suspended';
const STAGES: RenewalStage[] = ['upcoming', 'due_tomorrow', 'overdue', 'suspension_warning', 'suspended'];

const runKey = (subscriptionId: string, periodStart: Date) => `renewal:${subscriptionId}:${periodStart.toISOString()}`;

// ───────────────────────────── Order creation ─────────────────────────────

async function taxRules(db: PrismaClient | Tx, now: Date): Promise<TaxRule[]> {
  const rows = await db.taxRule.findMany({ where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } });
  return rows.map((r) => ({ id: r.id, taxCategory: r.taxCategory, supplyType: r.supplyType, components: r.components as unknown as TaxRule['components'], reviewed: r.reviewed }));
}

const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * Creates renewal runs for subscriptions whose period ends within the notice window, and (re)creates the
 * renewal order for pending runs that have none. Problems (missing billing details, unreviewed tax rule)
 * are recorded on the run and retried on the next sweep.
 */
export async function prepareRenewals(db: PrismaClient, settings: RenewalSettings, sellerStateCode: string | undefined, now = new Date()) {
  const horizon = new Date(now.getTime() + settings.noticeDays * DAY);
  const due = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT s.id FROM "Subscription" s
    WHERE s.status IN ('active', 'trialing') AND NOT s."cancelAtPeriodEnd" AND s."pendingAction" IS NULL
      AND s."currentPeriodEnd" IS NOT NULL AND s."currentPeriodEnd" <= ${horizon}
      AND NOT EXISTS (SELECT 1 FROM "RenewalRun" r WHERE r."subscriptionId" = s.id AND r."periodStart" = s."currentPeriodEnd")
    ORDER BY s."currentPeriodEnd" LIMIT 100`);
  for (const { id } of due) {
    const sub = await db.subscription.findUniqueOrThrow({ where: { id } });
    await db.renewalRun.createMany({ data: [{ subscriptionId: id, periodStart: sub.currentPeriodEnd!, status: 'pending' }], skipDuplicates: true });
  }

  const open = await db.renewalRun.findMany({ where: { status: 'pending', orderId: null }, include: { subscription: true }, take: 100, orderBy: { periodStart: 'asc' } });
  const created: { runId: string; orderId: string }[] = [];
  const blocked: { runId: string; error: string }[] = [];
  for (const run of open) {
    const sub = run.subscription;
    if (sub.status === 'cancelled' || sub.cancelAtPeriodEnd || sub.currentPeriodEnd?.getTime() !== run.periodStart.getTime()) {
      await db.renewalRun.updateMany({ where: { id: run.id, status: 'pending', orderId: null }, data: { status: 'cancelled', lastError: 'subscription_changed' } });
      continue;
    }
    try {
      const orderId = await createRenewalOrder(db, run.id, sellerStateCode, settings, now);
      if (orderId) created.push({ runId: run.id, orderId });
    } catch (e) {
      const error = e instanceof MoneyError || e instanceof RenewalError ? e.message : `unexpected: ${(e as Error).message}`;
      await db.renewalRun.update({ where: { id: run.id }, data: { lastError: error.slice(0, 500) } });
      blocked.push({ runId: run.id, error });
    }
  }
  return { created, blocked };
}

export class RenewalError extends Error {}

async function createRenewalOrder(db: PrismaClient, runId: string, sellerStateCode: string | undefined, settings: RenewalSettings, now: Date) {
  return db.$transaction(async (tx) => {
    const run = await tx.renewalRun.findUniqueOrThrow({ where: { id: runId }, include: { subscription: { include: { org: true } } } });
    if (run.status !== 'pending' || run.orderId) return null;
    const sub = run.subscription;
    const org = sub.org;
    const change = sub.scheduledChange as unknown as ScheduledChange | null;
    const priceVersionId = change?.priceVersionId ?? sub.priceVersionId;
    const quantity = change?.quantity ?? sub.quantity;
    const price = await tx.priceVersion.findUniqueOrThrow({ where: { id: priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } });
    const periodEnd = addIsoDuration(run.periodStart, price.billingInterval);

    let supplyType;
    try {
      supplyType = determineSupplyType({ sellerStateCode: sellerStateCode ?? null, buyerStateCode: org.stateCode, buyerCountry: org.country });
    } catch {
      throw new RenewalError('billing_details_required: organisation or seller state code missing');
    }
    // Existing customers keep their plan's price version (grandfathered) until they change plan.
    const totals = computeQuote(
      [{
        planPriceVersionId: price.id,
        description: `${price.planVersion.plan.product.name} — ${price.planVersion.plan.name}, renewal ${fmt(run.periodStart)} – ${fmt(periodEnd)}`,
        unitAmountMinor: minorFromDb(price.amountMinor),
        quantity,
        taxCategory: price.planVersion.plan.product.taxCategory,
        billingInterval: price.billingInterval,
        currency: 'INR',
      }],
      supplyType,
      await taxRules(tx, now),
    );
    const line = totals.lines[0]!;
    const payableUntil = new Date(run.periodStart.getTime() + settings.lapseDays * DAY);
    const quote = await tx.quote.create({
      data: {
        orgId: sub.orgId,
        status: 'converted',
        supplyType,
        subtotalMinor: BigInt(totals.subtotalMinor),
        discountMinor: BigInt(totals.discountMinor),
        taxMinor: BigInt(totals.taxMinor),
        totalMinor: BigInt(totals.totalMinor),
        snapshot: { ...totals, checkoutGroups: 1, renewal: { subscriptionId: sub.id, periodStart: run.periodStart, periodEnd }, sellerStateCode, buyerStateCode: org.stateCode } as unknown as Prisma.InputJsonValue,
        expiresAt: payableUntil,
        acceptedAt: now,
        lines: {
          create: [{
            priceVersionId: price.id,
            description: line.description,
            quantity,
            unitAmountMinor: BigInt(line.unitAmountMinor),
            setupFeeMinor: 0n,
            discountMinor: BigInt(line.discountMinor),
            taxMinor: BigInt(line.tax.totalTaxMinor),
            totalMinor: BigInt(line.totalMinor),
            costMinor: price.costMinor,
            billingInterval: price.billingInterval,
          }],
        },
      },
    });
    // A previous order for this run may have been invalidated (plan change); give each attempt its own key.
    const attempt = await tx.order.count({ where: { subscriptionId: sub.id, kind: 'renewal', idempotencyKey: { startsWith: runKey(sub.id, run.periodStart) } } });
    const order = await tx.order.create({
      data: {
        orgId: sub.orgId,
        quoteId: quote.id,
        kind: 'renewal',
        subscriptionId: sub.id,
        status: 'awaiting_payment',
        totalMinor: BigInt(totals.totalMinor),
        idempotencyKey: `${runKey(sub.id, run.periodStart)}#${attempt + 1}`,
        items: { create: [{ priceVersionId: price.id, quantity, totalMinor: BigInt(totals.totalMinor) }] },
      },
    });
    await tx.renewalRun.update({ where: { id: run.id }, data: { orderId: order.id, lastError: null } });
    await tx.auditEvent.create({ data: { actorType: 'system', orgId: sub.orgId, action: 'renewal.order_created', targetType: 'subscription', targetId: sub.id, metadata: { orderId: order.id, periodStart: run.periodStart.toISOString(), totalMinor: totals.totalMinor } } });
    return order.id;
  });
}

/**
 * Cancels the unpaid renewal order of a subscription's pending run (plan changed, or renewal cancelled).
 * `reopen` leaves the run pending so a fresh order is created at the new terms; otherwise the run is cancelled.
 * Orders with a payment in flight are left alone (a payment arriving later is flagged for review, never lost).
 */
export async function invalidateRenewalOrder(tx: Tx, subscriptionId: string, mode: 'reopen' | 'cancel') {
  const run = await tx.renewalRun.findFirst({ where: { subscriptionId, status: 'pending' }, orderBy: { periodStart: 'desc' } });
  if (!run) return;
  if (run.orderId) {
    const cancelled = await tx.order.updateMany({ where: { id: run.orderId, status: 'awaiting_payment', paymentOrders: { none: { status: 'paid' } } }, data: { status: 'cancelled' } });
    if (cancelled.count === 0) return;
  }
  await tx.renewalRun.update({ where: { id: run.id }, data: mode === 'reopen' ? { orderId: null } : { orderId: null, status: 'cancelled' } });
}

/** Re-opens a renewal run cancelled by "cancel at period end" when the customer keeps the subscription. */
export async function reopenCancelledRenewal(tx: Tx, subscriptionId: string, periodStart: Date | null) {
  if (!periodStart) return;
  await tx.renewalRun.updateMany({ where: { subscriptionId, periodStart, status: 'cancelled' }, data: { status: 'pending', orderId: null, lastError: null } });
}

// ───────────────────────────── Payment ─────────────────────────────

export type RenewalPaymentResult = 'extended' | 'already_applied' | 'subscription_ended' | 'period_mismatch';

/** Applies a confirmed renewal payment inside the payment transaction. Exactly once per run. */
export async function applyRenewalPayment(tx: Tx, orderId: string, now = new Date()): Promise<RenewalPaymentResult> {
  const run = await tx.renewalRun.findUnique({ where: { orderId }, include: { subscription: true } });
  if (!run) return 'period_mismatch';
  const claimed = await tx.renewalRun.updateMany({ where: { id: run.id, status: 'pending' }, data: { status: 'paid', paymentRef: orderId } });
  if (claimed.count === 0) return run.status === 'paid' ? 'already_applied' : 'subscription_ended';
  const sub = run.subscription;
  if (sub.status === 'cancelled') return 'subscription_ended';
  if (sub.currentPeriodEnd?.getTime() !== run.periodStart.getTime()) return 'period_mismatch';

  const item = await tx.orderItem.findFirstOrThrow({ where: { orderId } });
  const price = await tx.priceVersion.findUniqueOrThrow({ where: { id: item.priceVersionId } });
  const periodEnd = addIsoDuration(run.periodStart, price.billingInterval);
  const resumeNeeded = sub.status === 'suspended' && sub.suspensionReason === 'non_payment';
  const status = sub.status === 'suspended' ? 'suspended' : 'active';
  const updated = await tx.subscription.updateMany({
    where: { id: sub.id, lifecycleVersion: sub.lifecycleVersion, currentPeriodEnd: run.periodStart },
    data: {
      currentPeriodStart: run.periodStart,
      currentPeriodEnd: periodEnd,
      status,
      graceEndsAt: null,
      ...(resumeNeeded ? { pendingAction: 'resume', pendingActionReason: 'renewal_paid', nextLifecycleAttemptAt: null } : {}),
      // A suspension still waiting to run for non-payment is no longer wanted.
      ...(sub.pendingAction === 'suspend' && sub.pendingActionReason === 'non_payment' ? { pendingAction: null, pendingActionReason: null } : {}),
    },
  });
  if (updated.count !== 1) return 'period_mismatch';
  await tx.order.update({ where: { id: orderId }, data: { status: 'active' } });
  await tx.auditEvent.create({
    data: { actorType: 'system', orgId: sub.orgId, action: 'renewal.paid', targetType: 'subscription', targetId: sub.id, metadata: { orderId, periodStart: run.periodStart.toISOString(), periodEnd: periodEnd.toISOString(), resume: resumeNeeded } },
  });
  return 'extended';
}

// ───────────────────────────── Overdue handling ─────────────────────────────

/** Moves unpaid renewals through past_due → suspension → lapse. Idempotent; safe to run every minute. */
export async function advanceOverdueRenewals(db: PrismaClient, settings: RenewalSettings, now = new Date()) {
  const out = { pastDue: 0, suspensionsRequested: 0, lapsed: 0 };
  const runs = await db.renewalRun.findMany({ where: { status: 'pending', periodStart: { lte: now } }, include: { subscription: true }, take: 200, orderBy: { periodStart: 'asc' } });
  for (const run of runs) {
    const sub = run.subscription;
    if (sub.currentPeriodEnd?.getTime() !== run.periodStart.getTime()) continue;
    const graceEndsAt = new Date(run.periodStart.getTime() + settings.graceDays * DAY);
    const lapseAt = new Date(run.periodStart.getTime() + settings.lapseDays * DAY);

    if (now >= lapseAt) {
      const done = await db.$transaction(async (tx) => {
        const r = await tx.renewalRun.updateMany({ where: { id: run.id, status: 'pending' }, data: { status: 'lapsed' } });
        if (r.count !== 1) return false;
        if (run.orderId) await tx.order.updateMany({ where: { id: run.orderId, status: 'awaiting_payment' }, data: { status: 'expired' } });
        // The lifecycle worker ends it (switches access off through the adapters, keeps data).
        await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
        await tx.auditEvent.create({ data: { actorType: 'system', orgId: sub.orgId, action: 'renewal.lapsed', targetType: 'subscription', targetId: sub.id, metadata: { periodStart: run.periodStart.toISOString() } } });
        return true;
      });
      if (done) out.lapsed++;
      continue;
    }
    if (sub.status === 'active' || sub.status === 'trialing') {
      const r = await db.subscription.updateMany({ where: { id: sub.id, status: sub.status, currentPeriodEnd: run.periodStart }, data: { status: 'past_due', graceEndsAt } });
      if (r.count === 1) {
        out.pastDue++;
        await db.auditEvent.create({ data: { actorType: 'system', orgId: sub.orgId, action: 'renewal.past_due', targetType: 'subscription', targetId: sub.id, metadata: { graceEndsAt: graceEndsAt.toISOString() } } });
      }
      continue;
    }
    if ((sub.status === 'past_due' || sub.status === 'grace') && now >= (sub.graceEndsAt ?? graceEndsAt) && !sub.pendingAction) {
      const r = await db.subscription.updateMany({ where: { id: sub.id, status: sub.status, pendingAction: null }, data: { pendingAction: 'suspend', pendingActionReason: 'non_payment', nextLifecycleAttemptAt: null } });
      if (r.count === 1) out.suspensionsRequested++;
    }
  }
  return out;
}

// ───────────────────────────── Reminders ─────────────────────────────

export interface RenewalReminder {
  runId: string;
  stage: RenewalStage;
  to: string[];
  subject: string;
  text: string;
}

function stageFor(run: { periodStart: Date }, sub: { status: string; suspensionReason: string | null; graceEndsAt: Date | null }, now: Date): RenewalStage {
  if (sub.status === 'suspended' && sub.suspensionReason === 'non_payment') return 'suspended';
  if (sub.graceEndsAt && now.getTime() >= sub.graceEndsAt.getTime() - 2 * DAY) return 'suspension_warning';
  if (now >= run.periodStart) return 'overdue';
  if (run.periodStart.getTime() - now.getTime() <= DAY) return 'due_tomorrow';
  return 'upcoming';
}

/**
 * Claims the next reminder for each unpaid renewal (at most once per stage, never several at once after
 * downtime: earlier stages are marked as sent). The caller sends the returned messages.
 */
export async function claimRenewalReminders(db: PrismaClient, appUrl: string, now = new Date()): Promise<RenewalReminder[]> {
  const runs = await db.renewalRun.findMany({
    where: { status: 'pending', orderId: { not: null } },
    include: { subscription: { include: { org: { include: { memberships: { where: { role: { in: ['owner', 'billing'] } }, include: { user: { select: { email: true } } } } } } } } },
    take: 200,
  });
  const out: RenewalReminder[] = [];
  for (const run of runs) {
    const sub = run.subscription;
    const stage = stageFor(run, sub, now);
    if (run.remindersSent.includes(stage)) continue;
    const upTo = STAGES.slice(0, STAGES.indexOf(stage) + 1);
    const claimed = await db.$executeRaw(Prisma.sql`
      UPDATE "RenewalRun" SET "remindersSent" = (SELECT ARRAY(SELECT DISTINCT unnest("remindersSent" || ${upTo}::text[]))), "updatedAt" = now()
      WHERE id = ${run.id}::uuid AND status = 'pending' AND NOT (${stage} = ANY("remindersSent"))`);
    if (claimed !== 1) continue;
    const order = await db.order.findUnique({ where: { id: run.orderId! }, select: { totalMinor: true, items: { select: { priceVersionId: true }, take: 1 } } });
    const price = order?.items[0] && (await db.priceVersion.findUnique({ where: { id: order.items[0].priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } }));
    const to = [...new Set([sub.org.billingEmail, ...sub.org.memberships.map((m) => m.user.email)].filter((e): e is string => !!e))];
    if (to.length === 0 || !order || !price) continue;
    const name = `${price.planVersion.plan.product.name} (${price.planVersion.plan.name})`;
    const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minorFromDb(order.totalMinor) / 100);
    const link = `${appUrl}/dashboard/orgs/${sub.orgId}/subscriptions`;
    const grace = sub.graceEndsAt ? fmt(sub.graceEndsAt) : null;
    const lines: Record<RenewalStage, [string, string]> = {
      upcoming: [`Renewal due on ${fmt(run.periodStart)}: ${name}`, `Your ${name} subscription for ${sub.org.name} renews on ${fmt(run.periodStart)}. Amount due: ${amount} (incl. GST).`],
      due_tomorrow: [`Renewal due tomorrow: ${name}`, `Your ${name} subscription for ${sub.org.name} renews on ${fmt(run.periodStart)}. Amount due: ${amount} (incl. GST).`],
      overdue: [`Payment overdue: ${name}`, `The renewal of ${name} for ${sub.org.name} was due on ${fmt(run.periodStart)} and has not been paid. Access continues${grace ? ` until ${grace}` : ' for a short grace period'}. Amount due: ${amount}.`],
      suspension_warning: [`Access will be suspended soon: ${name}`, `${name} for ${sub.org.name} is unpaid since ${fmt(run.periodStart)}. Access will be suspended${grace ? ` on ${grace}` : ' soon'} unless the renewal (${amount}) is paid. Your data is kept.`],
      suspended: [`Access suspended for non-payment: ${name}`, `Access to ${name} for ${sub.org.name} is suspended because the renewal (${amount}) is unpaid. Your data is kept; paying the renewal restores access.`],
    };
    const [subject, body] = lines[stage];
    out.push({ runId: run.id, stage, to, subject, text: `${body}\n\nPay or manage the subscription: ${link}\n\nIf you do not want to renew, you can cancel there; nothing more will be charged.` });
  }
  return out;
}
