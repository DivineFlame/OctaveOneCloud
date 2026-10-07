import { Prisma, PrismaClient, Subscription, SubscriptionStatus } from '@ooc/db';
import { subscriptionMachine } from '@ooc/shared';
import { AdapterRegistry, AdapterResult, AppAdapter, EntitlementPayload } from './adapters/contract';
import { invalidateRenewalOrder, reopenCancelledRenewal } from './renewals';

/**
 * Subscription lifecycle.
 *
 * Customers and operators record *intents* in the database (cancel at period end, scheduled downgrade,
 * suspend/resume request). The worker carries them out through the app adapters and only changes the
 * subscription once every adapter returned evidence. Nothing here deletes customer data, collects money
 * or refunds: cancellations take effect at the end of the paid period, downgrades at renewal, and upgrades
 * need a prorated quote and confirmed payment (not part of this module).
 */

export class SubscriptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface ScheduledChange {
  planVersionId: string;
  priceVersionId: string;
  quantity: number;
  effectiveAt: string;
  requestedBy?: string;
  requestedAt: string;
}

const RETRY_AFTER_MS = 5 * 60_000;
const LIVE: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'grace', 'cancel_scheduled'];

// ───────────────────────────── Customer and operator intents ─────────────────────────────

async function load(db: PrismaClient | Prisma.TransactionClient, orgId: string | null, subscriptionId: string) {
  const sub = await db.subscription.findFirst({ where: { id: subscriptionId, ...(orgId ? { orgId } : {}) } });
  if (!sub) throw new SubscriptionError('not_found', 'Subscription not found');
  return sub;
}

/** Stops renewal; access continues until the end of the paid period. Idempotent. */
export async function scheduleCancellation(db: PrismaClient, orgId: string, subscriptionId: string) {
  const sub = await load(db, orgId, subscriptionId);
  if (sub.status === 'cancelled') throw new SubscriptionError('already_cancelled', 'This subscription has already ended');
  if (sub.status === 'pending_activation') throw new SubscriptionError('not_active', 'This subscription is not active yet');
  if (sub.cancelAtPeriodEnd) return sub;
  const next: SubscriptionStatus = sub.status === 'active' || sub.status === 'trialing' ? 'cancel_scheduled' : sub.status;
  await db.$transaction(async (tx) => {
    const r = await tx.subscription.updateMany({
      where: { id: sub.id, status: sub.status, cancelAtPeriodEnd: false },
      data: { status: next, cancelAtPeriodEnd: true, scheduledChange: Prisma.DbNull, scheduledChangeDueAt: null },
    });
    if (r.count !== 1) throw new SubscriptionError('conflict', 'The subscription changed; reload and try again');
    await invalidateRenewalOrder(tx, sub.id, 'cancel');
  });
  return load(db, orgId, subscriptionId);
}

/** Keeps the subscription after a scheduled cancellation, as long as the period has not ended. */
export async function withdrawCancellation(db: PrismaClient, orgId: string, subscriptionId: string, now = new Date()) {
  const sub = await load(db, orgId, subscriptionId);
  if (!sub.cancelAtPeriodEnd) return sub;
  if (sub.status === 'cancelled' || (sub.currentPeriodEnd && sub.currentPeriodEnd <= now)) throw new SubscriptionError('period_ended', 'The paid period has ended; please purchase again');
  const next: SubscriptionStatus = sub.status === 'cancel_scheduled' ? 'active' : sub.status;
  await db.$transaction(async (tx) => {
    const r = await tx.subscription.updateMany({ where: { id: sub.id, status: sub.status, cancelAtPeriodEnd: true }, data: { status: next, cancelAtPeriodEnd: false } });
    if (r.count !== 1) throw new SubscriptionError('conflict', 'The subscription changed; reload and try again');
    await reopenCancelledRenewal(tx, sub.id, sub.currentPeriodEnd);
  });
  return load(db, orgId, subscriptionId);
}

interface PriceWithProduct {
  id: string;
  planVersionId: string;
  kind: string;
  currency: string;
  billingInterval: string;
  amountMinor: bigint;
  effectiveTo: Date | null;
  planVersion: { id: string; publishedAt: Date | null; retiredAt: Date | null; plan: { name: string; tier: string; productId: string; product: { key: string; fulfillment: string } } };
}

const priceInclude = { planVersion: { include: { plan: { include: { product: true } } } } } as const;

/** Lower-priced plans of the same product and billing interval that a subscription can move to at renewal. */
export async function downgradeOptions(db: PrismaClient, sub: Pick<Subscription, 'priceVersionId' | 'quantity'>, now = new Date()) {
  const current = (await db.priceVersion.findUniqueOrThrow({ where: { id: sub.priceVersionId }, include: priceInclude })) as PriceWithProduct;
  const candidates = (await db.priceVersion.findMany({
    where: {
      kind: 'subscription',
      currency: current.currency,
      billingInterval: current.billingInterval,
      id: { not: current.id },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      effectiveFrom: { lte: now },
      planVersion: { publishedAt: { not: null }, retiredAt: null, plan: { productId: current.planVersion.plan.productId } },
    },
    include: priceInclude,
    orderBy: { amountMinor: 'asc' },
  })) as PriceWithProduct[];
  return candidates
    .filter((p) => p.amountMinor < current.amountMinor)
    .map((p) => ({ priceVersionId: p.id, planVersionId: p.planVersionId, planName: p.planVersion.plan.name, tier: p.planVersion.plan.tier, amountMinor: Number(p.amountMinor), billingInterval: p.billingInterval }));
}

/**
 * Schedules a move to a cheaper plan (or fewer units) at the end of the current period. Moves that cost
 * more are upgrades and need a prorated quote and payment instead.
 */
export async function scheduleDowngrade(db: PrismaClient, input: { orgId: string; subscriptionId: string; priceVersionId: string; quantity: number; actorId?: string }, now = new Date()) {
  const sub = await load(db, input.orgId, input.subscriptionId);
  if (sub.status !== 'active' && sub.status !== 'trialing') {
    throw new SubscriptionError(sub.cancelAtPeriodEnd ? 'cancellation_scheduled' : 'not_active', 'Only active subscriptions can be changed');
  }
  if (!sub.currentPeriodEnd) throw new SubscriptionError('no_period', 'The subscription has no billing period');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new SubscriptionError('invalid_quantity', 'Quantity must be at least 1');

  const current = (await db.priceVersion.findUniqueOrThrow({ where: { id: sub.priceVersionId }, include: priceInclude })) as PriceWithProduct;
  const target = (await db.priceVersion.findUnique({ where: { id: input.priceVersionId }, include: priceInclude })) as PriceWithProduct | null;
  if (!target || target.kind !== 'subscription' || !target.planVersion.publishedAt || target.planVersion.retiredAt || (target.effectiveTo && target.effectiveTo <= now)) {
    throw new SubscriptionError('price_not_available', 'That plan is not available');
  }
  if (target.planVersion.plan.productId !== current.planVersion.plan.productId) throw new SubscriptionError('different_product', 'Plans can only change within the same product');
  if (target.billingInterval !== current.billingInterval || target.currency !== current.currency) {
    throw new SubscriptionError('different_term', 'Changing the billing term is not supported as a scheduled change');
  }
  const currentTotal = current.amountMinor * BigInt(sub.quantity);
  const targetTotal = target.amountMinor * BigInt(input.quantity);
  if (targetTotal >= currentTotal) throw new SubscriptionError('upgrade_requires_quote', 'This change costs the same or more; upgrades need a prorated quote and payment');

  // Bundles may change component plans but not which apps they include (that would provision or remove apps).
  const [from, to] = await Promise.all([subscriptionComponents(db, current.planVersionId), subscriptionComponents(db, target.planVersionId)]);
  const keys = (cs: Component[]) => cs.map((c) => c.productKey).sort().join(',');
  if (keys(from) !== keys(to)) throw new SubscriptionError('bundle_composition_change', 'This plan includes different apps; contact support to change it');

  const change: ScheduledChange = {
    planVersionId: target.planVersionId,
    priceVersionId: target.id,
    quantity: input.quantity,
    effectiveAt: sub.currentPeriodEnd.toISOString(),
    requestedBy: input.actorId,
    requestedAt: now.toISOString(),
  };
  await db.$transaction(async (tx) => {
    const r = await tx.subscription.updateMany({
      where: { id: sub.id, status: sub.status, cancelAtPeriodEnd: false },
      data: { scheduledChange: change as unknown as Prisma.InputJsonValue, scheduledChangeDueAt: sub.currentPeriodEnd },
    });
    if (r.count !== 1) throw new SubscriptionError('conflict', 'The subscription changed; reload and try again');
    // An unpaid renewal order at the old price is replaced by one at the new price.
    await invalidateRenewalOrder(tx, sub.id, 'reopen');
  });
  return load(db, input.orgId, input.subscriptionId);
}

export async function withdrawScheduledChange(db: PrismaClient, orgId: string, subscriptionId: string) {
  const sub = await load(db, orgId, subscriptionId);
  if (sub.scheduledChange === null) return sub;
  await db.$transaction(async (tx) => {
    await tx.subscription.updateMany({ where: { id: sub.id, lifecycleVersion: sub.lifecycleVersion }, data: { scheduledChange: Prisma.DbNull, scheduledChangeDueAt: null } });
    await invalidateRenewalOrder(tx, sub.id, 'reopen');
  });
  return load(db, orgId, subscriptionId);
}

/** Operator request; the worker performs it through the adapters (usually within a minute). */
export async function requestOperatorAction(db: PrismaClient, subscriptionId: string, action: 'suspend' | 'resume', reason: string) {
  const sub = await load(db, null, subscriptionId);
  if (action === 'suspend' && !subscriptionMachine.canTransition(sub.status, 'suspended')) throw new SubscriptionError('invalid_state', `Cannot suspend a ${sub.status} subscription`);
  if (action === 'resume' && sub.status !== 'suspended') throw new SubscriptionError('invalid_state', 'Only suspended subscriptions can be resumed');
  await db.subscription.update({ where: { id: sub.id }, data: { pendingAction: action, pendingActionReason: reason, nextLifecycleAttemptAt: null, lastLifecycleError: null } });
  return load(db, null, subscriptionId);
}

// ───────────────────────────── Worker: carry out due lifecycle work ─────────────────────────────

interface Component {
  productKey: string;
  adapterKey: string | null;
  fulfillment: string;
  planVersionId: string;
}

export async function subscriptionComponents(db: PrismaClient | Prisma.TransactionClient, planVersionId: string): Promise<Component[]> {
  const pv = await db.planVersion.findUniqueOrThrow({ where: { id: planVersionId }, include: { plan: { include: { product: true } } } });
  const product = pv.plan.product;
  if (product.fulfillment !== 'bundle') return [{ productKey: product.key, adapterKey: product.adapterKey, fulfillment: product.fulfillment, planVersionId }];
  const comps = await db.bundleComponent.findMany({ where: { bundleVersionId: planVersionId }, orderBy: { provisionOrder: 'asc' }, include: { componentVersion: { include: { plan: { include: { product: true } } } } } });
  return comps.map((c) => ({ productKey: c.componentVersion.plan.product.key, adapterKey: c.componentVersion.plan.product.adapterKey, fulfillment: c.componentVersion.plan.product.fulfillment, planVersionId: c.componentVersionId }));
}

/** Entitlement source ids follow the provisioning engine: `<orderItemId>:<componentPlanVersionId>`. */
const sourceKey = (sub: Subscription) => `${sub.sourceOrderItemId ?? sub.id}:`;

export type LifecycleOutcome = { subscriptionId: string; action: 'suspend' | 'resume' | 'cancel' | 'plan_change' | 'none'; result: 'done' | 'retry_later' | 'raced' | 'skipped'; error?: string };

/** Subscriptions with lifecycle work due now. */
export async function dueLifecycleWork(db: PrismaClient, now = new Date(), limit = 50) {
  return db.subscription.findMany({
    where: {
      AND: [
        { OR: [{ nextLifecycleAttemptAt: null }, { nextLifecycleAttemptAt: { lte: now } }] },
        {
          OR: [
            { pendingAction: { not: null } },
            { cancelAtPeriodEnd: true, status: { not: 'cancelled' }, currentPeriodEnd: { lte: now } },
            { scheduledChangeDueAt: { lte: now }, status: { in: ['active', 'trialing'] } },
          ],
        },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
}

export async function processSubscriptionLifecycle(db: PrismaClient, adapters: AdapterRegistry, now = new Date()) {
  const out: LifecycleOutcome[] = [];
  for (const { id } of await dueLifecycleWork(db, now)) out.push(await runLifecycle(db, adapters, id, now));
  return out;
}

export async function runLifecycle(db: PrismaClient, adapters: AdapterRegistry, subscriptionId: string, now = new Date()): Promise<LifecycleOutcome> {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const periodOver = !!sub.currentPeriodEnd && sub.currentPeriodEnd <= now;
  if (sub.pendingAction === 'suspend') return suspend(db, adapters, sub, now);
  if (sub.pendingAction === 'resume') return resume(db, adapters, sub, now);
  if (sub.cancelAtPeriodEnd && periodOver && sub.status !== 'cancelled') return cancel(db, adapters, sub, now);
  // Due at the period boundary it was scheduled for, even if the renewal was paid early and the period moved on.
  const changeDue = !!sub.scheduledChange && !!sub.scheduledChangeDueAt && sub.scheduledChangeDueAt <= now;
  if (changeDue && (sub.status === 'active' || sub.status === 'trialing')) return applyPlanChange(db, adapters, sub, now);
  return { subscriptionId, action: 'none', result: 'skipped' };
}

type Call = (adapter: AppAdapter, c: Component, idempotencyKey: string) => Promise<AdapterResult>;

/** Calls every adapter-backed component; succeeds only if each one returned evidence. */
async function callComponents(adapters: AdapterRegistry, sub: Subscription, components: Component[], op: string, call: Call): Promise<string | null> {
  const errors: string[] = [];
  for (const c of components) {
    if (c.fulfillment !== 'app_adapter' || !c.adapterKey) continue; // nothing to switch off in an app
    const adapter = adapters.get(c.adapterKey);
    if (!adapter) {
      errors.push(`${c.productKey}: adapter_unavailable`);
      continue;
    }
    const key = `sub:${sub.id}:v${sub.lifecycleVersion}:${op}:${c.productKey}`;
    try {
      const r = await call(adapter, c, key);
      if (r.outcome !== 'succeeded' || !r.evidence) errors.push(`${c.productKey}: ${r.outcome}${r.error ? ` (${r.error})` : ''}`);
    } catch (e) {
      errors.push(`${c.productKey}: ${(e as Error).message}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}

async function deferred(db: PrismaClient, sub: Subscription, action: LifecycleOutcome['action'], error: string, now: Date): Promise<LifecycleOutcome> {
  await db.$transaction([
    db.subscription.updateMany({ where: { id: sub.id, lifecycleVersion: sub.lifecycleVersion }, data: { lastLifecycleError: error.slice(0, 1000), nextLifecycleAttemptAt: new Date(now.getTime() + RETRY_AFTER_MS) } }),
    db.auditEvent.create({ data: { actorType: 'system', orgId: sub.orgId, action: `subscription.${action}_deferred`, targetType: 'subscription', targetId: sub.id, metadata: { error: error.slice(0, 1000) } } }),
  ]);
  return { subscriptionId: sub.id, action, result: 'retry_later', error };
}

/** Commits a completed transition exactly once (guarded by lifecycleVersion). */
async function commit(
  db: PrismaClient,
  sub: Subscription,
  action: LifecycleOutcome['action'],
  data: Prisma.SubscriptionUpdateManyMutationInput,
  entitlements: (tx: Prisma.TransactionClient) => Promise<void>,
  metadata: Record<string, unknown> = {},
): Promise<LifecycleOutcome> {
  const done = await db.$transaction(async (tx) => {
    const r = await tx.subscription.updateMany({
      where: { id: sub.id, lifecycleVersion: sub.lifecycleVersion },
      data: { ...data, lifecycleVersion: { increment: 1 }, lastLifecycleError: null, nextLifecycleAttemptAt: null },
    });
    if (r.count !== 1) return false;
    await entitlements(tx);
    await tx.auditEvent.create({ data: { actorType: 'system', orgId: sub.orgId, action: `subscription.${action}`, targetType: 'subscription', targetId: sub.id, metadata: metadata as Prisma.InputJsonValue } });
    return true;
  });
  return { subscriptionId: sub.id, action, result: done ? 'done' : 'raced' };
}

const revokeAll = (sub: Subscription, now: Date) => async (tx: Prisma.TransactionClient) => {
  await tx.entitlement.updateMany({ where: { orgId: sub.orgId, sourceType: 'subscription', sourceId: { startsWith: sourceKey(sub) }, revokedAt: null }, data: { revokedAt: now } });
};

async function suspend(db: PrismaClient, adapters: AdapterRegistry, sub: Subscription, now: Date) {
  if (sub.status === 'suspended' || !subscriptionMachine.canTransition(sub.status, 'suspended')) {
    // Already suspended, or no longer suspendable (e.g. cancelled meanwhile): clear the request.
    return commit(db, sub, 'suspend', { pendingAction: null, pendingActionReason: null }, async () => undefined, { noop: true, status: sub.status });
  }
  const components = await subscriptionComponents(db, sub.planVersionId);
  const reason = sub.pendingActionReason ?? 'operator_request';
  const error = await callComponents(adapters, sub, components, 'suspend', (a, _c, key) => a.suspendAccess({ orgId: sub.orgId, correlationId: `sub-${sub.id}`, idempotencyKey: key, reason }));
  if (error) return deferred(db, sub, 'suspend', error, now);
  return commit(db, sub, 'suspend', { status: 'suspended', suspendedAt: now, suspensionReason: reason, pendingAction: null, pendingActionReason: null }, revokeAll(sub, now), { reason });
}

async function resume(db: PrismaClient, adapters: AdapterRegistry, sub: Subscription, now: Date) {
  if (sub.status !== 'suspended') return commit(db, sub, 'resume', { pendingAction: null, pendingActionReason: null }, async () => undefined, { noop: true, status: sub.status });
  const components = await subscriptionComponents(db, sub.planVersionId);
  const error = await callComponents(adapters, sub, components, 'resume', (a, _c, key) => a.resumeAccess({ orgId: sub.orgId, correlationId: `sub-${sub.id}`, idempotencyKey: key }));
  if (error) return deferred(db, sub, 'resume', error, now);
  const current = components.map((c) => `${sourceKey(sub)}${c.planVersionId}`);
  return commit(
    db,
    sub,
    'resume',
    { status: sub.cancelAtPeriodEnd ? 'cancel_scheduled' : 'active', suspendedAt: null, suspensionReason: null, pendingAction: null, pendingActionReason: null },
    async (tx) => {
      // Restore only the current plan's grants (grants of a plan replaced by a downgrade stay revoked).
      await tx.entitlement.updateMany({ where: { orgId: sub.orgId, sourceType: 'subscription', sourceId: { in: current }, revokedAt: { not: null } }, data: { revokedAt: null } });
    },
    { reason: sub.pendingActionReason ?? 'operator_request' },
  );
}

async function cancel(db: PrismaClient, adapters: AdapterRegistry, sub: Subscription, now: Date) {
  const components = await subscriptionComponents(db, sub.planVersionId);
  // Access ends; data is retained (deletion follows the retention policy, never automatically here).
  const error = await callComponents(adapters, sub, components, 'cancel', (a, _c, key) => a.suspendAccess({ orgId: sub.orgId, correlationId: `sub-${sub.id}`, idempotencyKey: key, reason: 'subscription_ended' }));
  if (error) return deferred(db, sub, 'cancel', error, now);
  return commit(db, sub, 'cancel', { status: 'cancelled', cancelledAt: now, pendingAction: null, pendingActionReason: null, scheduledChange: Prisma.DbNull, scheduledChangeDueAt: null }, revokeAll(sub, now), {
    periodEnd: sub.currentPeriodEnd?.toISOString(),
  });
}

async function applyPlanChange(db: PrismaClient, adapters: AdapterRegistry, sub: Subscription, now: Date) {
  const change = sub.scheduledChange as unknown as ScheduledChange;
  const components = await subscriptionComponents(db, change.planVersionId);
  const featuresByVersion = new Map<string, { featureKey: string; limit: bigint | null; mergePolicy: Prisma.EntitlementCreateInput['mergePolicy'] }[]>();
  for (const c of components) {
    const fs = await db.planFeature.findMany({ where: { planVersionId: c.planVersionId }, include: { feature: true } });
    featuresByVersion.set(c.planVersionId, fs.map((f) => ({ featureKey: f.featureKey, limit: f.limit, mergePolicy: f.feature.mergePolicy })));
  }
  const payload = (c: Component): EntitlementPayload[] =>
    (featuresByVersion.get(c.planVersionId) ?? []).map((f) => ({ featureKey: f.featureKey, limit: f.limit === null ? null : Number(f.limit) * change.quantity }));

  const error = await callComponents(adapters, sub, components, 'change', (a, c, key) =>
    a.changePlan({ orgId: sub.orgId, correlationId: `sub-${sub.id}`, idempotencyKey: key, planVersionId: c.planVersionId, entitlements: payload(c) }),
  );
  if (error) return deferred(db, sub, 'plan_change', error, now);

  return commit(
    db,
    sub,
    'plan_change',
    { planVersionId: change.planVersionId, priceVersionId: change.priceVersionId, quantity: change.quantity, scheduledChange: Prisma.DbNull, scheduledChangeDueAt: null },
    async (tx) => {
      await revokeAll(sub, now)(tx);
      for (const c of components) {
        for (const f of featuresByVersion.get(c.planVersionId) ?? []) {
          const limit = f.limit === null ? null : f.limit * BigInt(change.quantity);
          const sourceId = `${sourceKey(sub)}${c.planVersionId}`;
          await tx.entitlement.upsert({
            where: { orgId_featureKey_sourceType_sourceId: { orgId: sub.orgId, featureKey: f.featureKey, sourceType: 'subscription', sourceId } },
            update: { revokedAt: null, limit },
            create: { orgId: sub.orgId, featureKey: f.featureKey, mergePolicy: f.mergePolicy, limit, sourceType: 'subscription', sourceId },
          });
        }
      }
    },
    { from: { planVersionId: sub.planVersionId, priceVersionId: sub.priceVersionId, quantity: sub.quantity }, to: change },
  );
}

/** Live statuses, for listing what a customer is currently subscribed to. */
export const LIVE_SUBSCRIPTION_STATUSES = LIVE;
