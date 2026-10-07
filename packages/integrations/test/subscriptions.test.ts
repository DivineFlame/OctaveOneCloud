import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, ReferenceAppAdapter } from '../src/adapters/contract';
import {
  SubscriptionError,
  downgradeOptions,
  processSubscriptionLifecycle,
  requestOperatorAction,
  scheduleCancellation,
  scheduleDowngrade,
  withdrawCancellation,
  withdrawScheduledChange,
} from '../src/subscriptions';
import { db, makeFeature, makeOrg, makeProduct, reset } from './fixtures';

const DAY = 86_400_000;

async function addPlan(productId: string, key: string, amountMinor: number, seats: number, tier: 'starter' | 'growth' | 'business' = 'starter') {
  const plan = await db.plan.create({ data: { productId, key, name: key, tier } });
  const version = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  await makeFeature('crm.seats', 'max');
  await db.planFeature.create({ data: { planVersionId: version.id, featureKey: 'crm.seats', limit: BigInt(seats) } });
  const price = await db.priceVersion.create({ data: { planVersionId: version.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: BigInt(amountMinor) } });
  await db.planVersion.update({ where: { id: version.id }, data: { publishedAt: new Date() } });
  return { version, price };
}

/** An active CRM Growth subscription provisioned in the reference adapter, with its seat entitlement. */
async function setup(periodEnd = new Date(Date.now() + 10 * DAY)) {
  const org = await makeOrg();
  const { product } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm', amountMinor: 1 });
  const growth = await addPlan(product.id, `${product.key}-growth`, 199900, 10, 'growth');
  const starter = await addPlan(product.id, `${product.key}-starter2`, 99900, 3);
  const business = await addPlan(product.id, `${product.key}-business`, 499900, 50, 'business');
  const adapter = new ReferenceAppAdapter('app.crm', 'test');
  const adapters = new AdapterRegistry().register(adapter);
  await adapter.provisionTenant({ orgId: org.id, correlationId: 'c', idempotencyKey: 'p', planVersionId: growth.version.id, entitlements: [{ featureKey: 'crm.seats', limit: 10 }] });
  const itemId = '00000000-0000-4000-8000-000000000001';
  await db.entitlement.create({ data: { orgId: org.id, featureKey: 'crm.seats', limit: 10n, mergePolicy: 'max', sourceType: 'subscription', sourceId: `${itemId}:${growth.version.id}` } });
  const sub = await db.subscription.create({
    data: { orgId: org.id, planVersionId: growth.version.id, priceVersionId: growth.price.id, status: 'active', currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY), currentPeriodEnd: periodEnd, sourceOrderItemId: itemId },
  });
  return { org, sub, adapter, adapters, growth, starter, business };
}

const activeGrants = (orgId: string) => db.entitlement.findMany({ where: { orgId, revokedAt: null }, select: { featureKey: true, limit: true, sourceId: true } });

describe('subscription lifecycle', () => {
  beforeEach(reset);

  it('cancels at period end: access continues until then, then the app is switched off', async () => {
    const { org, sub, adapter, adapters } = await setup();
    const s1 = await scheduleCancellation(db, org.id, sub.id);
    expect(s1).toMatchObject({ status: 'cancel_scheduled', cancelAtPeriodEnd: true });
    expect((await scheduleCancellation(db, org.id, sub.id)).status).toBe('cancel_scheduled'); // idempotent

    expect(await processSubscriptionLifecycle(db, adapters)).toEqual([]); // not due yet
    expect(adapter.tenants.get(org.id)?.state).toBe('active');

    const after = new Date(sub.currentPeriodEnd!.getTime() + 1000);
    const r = await processSubscriptionLifecycle(db, adapters, after);
    expect(r).toEqual([{ subscriptionId: sub.id, action: 'cancel', result: 'done' }]);
    expect(adapter.tenants.get(org.id)?.state).toBe('suspended'); // data kept, access off
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'cancelled', cancelledAt: after });
    expect(await activeGrants(org.id)).toEqual([]);
    expect(await processSubscriptionLifecycle(db, adapters, new Date(after.getTime() + DAY))).toEqual([]);
  });

  it('lets the customer keep the subscription before the period ends, not after', async () => {
    const { org, sub } = await setup();
    await scheduleCancellation(db, org.id, sub.id);
    expect(await withdrawCancellation(db, org.id, sub.id)).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    await scheduleCancellation(db, org.id, sub.id);
    await expect(withdrawCancellation(db, org.id, sub.id, new Date(sub.currentPeriodEnd!.getTime() + 1))).rejects.toMatchObject({ code: 'period_ended' });
  });

  it('never acts on another organisation’s subscription', async () => {
    const { sub } = await setup();
    const other = await makeOrg('Other');
    await expect(scheduleCancellation(db, other.id, sub.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('schedules downgrades for renewal and applies them through the adapter', async () => {
    const { org, sub, adapter, adapters, starter, business, growth } = await setup();
    const options = await downgradeOptions(db, sub);
    const ids = options.map((o) => o.priceVersionId);
    expect(ids).toContain(starter.price.id);
    expect(ids).not.toContain(business.price.id);
    expect(ids).not.toContain(growth.price.id);
    await expect(scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1 })).rejects.toMatchObject({ code: 'upgrade_requires_quote' });

    const s = await scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: starter.price.id, quantity: 1 });
    expect(s.scheduledChange).toMatchObject({ priceVersionId: starter.price.id, effectiveAt: sub.currentPeriodEnd!.toISOString() });
    expect(s.priceVersionId).toBe(growth.price.id); // nothing changes until renewal

    const r = await processSubscriptionLifecycle(db, adapters, new Date(sub.currentPeriodEnd!.getTime() + 1));
    expect(r[0]).toMatchObject({ action: 'plan_change', result: 'done' });
    expect(adapter.tenants.get(org.id)).toMatchObject({ planVersionId: starter.version.id, entitlements: [{ featureKey: 'crm.seats', limit: 3 }] });
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ planVersionId: starter.version.id, priceVersionId: starter.price.id, scheduledChange: null, status: 'active' });
    expect(await activeGrants(org.id)).toEqual([{ featureKey: 'crm.seats', limit: 3n, sourceId: `${sub.sourceOrderItemId}:${starter.version.id}` }]);
  });

  it('withdraws a scheduled change, and cancelling replaces it', async () => {
    const { org, sub, starter } = await setup();
    await scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: starter.price.id, quantity: 1 });
    expect((await withdrawScheduledChange(db, org.id, sub.id)).scheduledChange).toBeNull();
    await scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: starter.price.id, quantity: 1 });
    expect((await scheduleCancellation(db, org.id, sub.id)).scheduledChange).toBeNull();
    await expect(scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: starter.price.id, quantity: 1 })).rejects.toBeInstanceOf(SubscriptionError);
  });

  it('suspends and resumes on operator request without touching data, restoring only current grants', async () => {
    const { org, sub, adapter, adapters } = await setup();
    await requestOperatorAction(db, sub.id, 'suspend', 'abuse report #12');
    expect(await processSubscriptionLifecycle(db, adapters)).toEqual([{ subscriptionId: sub.id, action: 'suspend', result: 'done' }]);
    expect(adapter.tenants.get(org.id)?.state).toBe('suspended');
    expect(await activeGrants(org.id)).toEqual([]);
    await expect(requestOperatorAction(db, sub.id, 'suspend', 'again')).rejects.toMatchObject({ code: 'invalid_state' });

    await requestOperatorAction(db, sub.id, 'resume', 'resolved');
    expect((await processSubscriptionLifecycle(db, adapters))[0]).toMatchObject({ action: 'resume', result: 'done' });
    expect(adapter.tenants.get(org.id)?.state).toBe('active');
    expect(await activeGrants(org.id)).toHaveLength(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('active');
  });

  it('defers and retries when the app does not confirm, without changing the subscription', async () => {
    const { org, sub, adapter, adapters } = await setup();
    await scheduleCancellation(db, org.id, sub.id);
    const end = sub.currentPeriodEnd!.getTime();
    adapter.failNext = 'unknown';
    const r = await processSubscriptionLifecycle(db, adapters, new Date(end + 1));
    expect(r[0]).toMatchObject({ action: 'cancel', result: 'retry_later' });
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'cancel_scheduled', lastLifecycleError: expect.stringContaining('unknown') });
    expect(await activeGrants(org.id)).toHaveLength(1);
    expect(await processSubscriptionLifecycle(db, adapters, new Date(end + 60_000))).toEqual([]); // backoff
    expect((await processSubscriptionLifecycle(db, adapters, new Date(end + 6 * 60_000)))[0]).toMatchObject({ result: 'done' });
    expect((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('cancelled');
  });

  it('applies a due transition once even when two workers race', async () => {
    const { org, sub, adapters } = await setup();
    await scheduleCancellation(db, org.id, sub.id);
    const at = new Date(sub.currentPeriodEnd!.getTime() + 1);
    const [a, b] = await Promise.all([processSubscriptionLifecycle(db, adapters, at), processSubscriptionLifecycle(db, adapters, at)]);
    const results = [...a, ...b].map((x) => x.result);
    expect(results.filter((x) => x === 'done')).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { action: 'subscription.cancel', targetId: sub.id } })).toBe(1);
  });
});
