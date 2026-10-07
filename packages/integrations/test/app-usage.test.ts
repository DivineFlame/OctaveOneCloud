import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, ReferenceAppAdapter } from '../src/adapters/contract';
import { runProvisioningJob } from '../src/provisioning/engine';
import { AppUsageError, appEntitlements, appRelease, appReserve, appSettle, orgUsageSummary, usagePeriod } from '../src/app-usage';
import { db, makeOrg, makePaidPendingOrder, reset } from './fixtures';

async function catalogue() {
  await db.feature.createMany({ data: [
    { key: 'ai.credits', name: 'AI credits', unit: 'credits', mergePolicy: 'additive', metered: true },
    { key: 'crm.seats', name: 'Seats', unit: 'seats', mergePolicy: 'max', metered: false },
  ] });
  await db.appAdapter.create({ data: { key: 'app.crm', name: 'CRM', status: 'sandbox' } });
  const product = await db.product.create({ data: { key: 'crm', name: 'CRM', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.crm', taxCategory: 'saas', status: 'active' } });
  const plan = await db.plan.create({ data: { productId: product.id, key: 'crm-growth', name: 'Growth', tier: 'growth' } });
  const pv = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  await db.planFeature.createMany({ data: [{ planVersionId: pv.id, featureKey: 'ai.credits', limit: 1000n }, { planVersionId: pv.id, featureKey: 'crm.seats', limit: 5n }] });
  const sub = await db.priceVersion.create({ data: { planVersionId: pv.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: 199900n } });
  const packPlan = await db.plan.create({ data: { productId: product.id, key: 'crm-ai-pack', name: 'AI pack 500', tier: 'starter' } });
  const packPv = await db.planVersion.create({ data: { planId: packPlan.id, version: 1 } });
  await db.planFeature.create({ data: { planVersionId: packPv.id, featureKey: 'ai.credits', limit: 500n } });
  const pack = await db.priceVersion.create({ data: { planVersionId: packPv.id, kind: 'usage_pack', billingInterval: 'P1M', amountMinor: 49900n } });
  await db.planVersion.updateMany({ where: { id: { in: [pv.id, packPv.id] } }, data: { publishedAt: new Date() } });
  return { sub, pack };
}

async function buy(orgId: string, priceVersionId: string, adapters: AdapterRegistry) {
  const { order } = await makePaidPendingOrder(orgId, [{ priceVersionId, totalMinor: 1 }]);
  const item = order.items[0]!;
  const job = await db.provisioningJob.create({ data: { orgId, orderItemId: item.id, adapterKey: 'app.crm', idempotencyKey: `order-item:${item.id}` } });
  return runProvisioningJob(db, adapters, job.id);
}

describe('app usage API', () => {
  beforeEach(reset);

  it('uses calendar months in IST', () => {
    expect(usagePeriod(new Date('2026-10-31T18:29:59Z')).start.toISOString()).toBe('2026-09-30T18:30:00.000Z'); // 31 Oct 23:59 IST
    expect(usagePeriod(new Date('2026-10-31T18:30:00Z')).start.toISOString()).toBe('2026-10-31T18:30:00.000Z'); // 1 Nov 00:00 IST
  });

  it('only serves organisations the app was provisioned for', async () => {
    const { sub } = await catalogue();
    const org = await makeOrg();
    await expect(appEntitlements(db, 'app.crm', org.id)).rejects.toMatchObject({ code: 'org_not_served' });
    const adapters = new AdapterRegistry().register(new ReferenceAppAdapter('app.crm', 'test'));
    await buy(org.id, sub.id, adapters);
    const e = await appEntitlements(db, 'app.crm', org.id);
    expect(e.entitlements).toEqual(expect.arrayContaining([{ featureKey: 'ai.credits', limit: 1000, mergePolicy: 'additive' }, { featureKey: 'crm.seats', limit: 5, mergePolicy: 'max' }]));
    await expect(appEntitlements(db, 'app.other', org.id)).rejects.toMatchObject({ code: 'org_not_served' });
  });

  it('reserves within the quota, holds the cap under concurrency, settles once', async () => {
    const { sub } = await catalogue();
    const org = await makeOrg();
    await buy(org.id, sub.id, new AdapterRegistry().register(new ReferenceAppAdapter('app.crm', 'test')));
    await expect(appReserve(db, 'app.crm', { orgId: org.id, resource: 'crm.seats', quantity: 1, idempotencyKey: 's1' })).rejects.toMatchObject({ code: 'not_metered' });

    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => appReserve(db, 'app.crm', { orgId: org.id, resource: 'ai.credits', quantity: 300, idempotencyKey: `run-${i}` })));
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ reservationId: string }>[];
    expect(ok).toHaveLength(3); // 3 × 300 ≤ 1000
    const denied = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(denied.reason).toBeInstanceOf(AppUsageError);
    expect(denied.reason.details).toMatchObject({ limit: 1000, reserved: 900 });

    const s = await appSettle(db, 'app.crm', { reservationId: ok[0]!.value.reservationId, actualQuantity: 120, sourceEventId: 'evt-1' });
    expect(s).toMatchObject({ settled: true, billed: 120 });
    expect(await appSettle(db, 'app.crm', { reservationId: ok[0]!.value.reservationId, actualQuantity: 120, sourceEventId: 'evt-1' })).toMatchObject({ replay: true });
    await expect(appSettle(db, 'app.other', { reservationId: ok[1]!.value.reservationId, actualQuantity: 1, sourceEventId: 'x' })).rejects.toMatchObject({ code: 'reservation_not_found' });
    expect(await appRelease(db, 'app.crm', ok[1]!.value.reservationId)).toEqual({ released: true });

    const summary = await orgUsageSummary(db, org.id);
    expect(summary.features.find((f) => f.featureKey === 'ai.credits')).toMatchObject({ limit: 1000, used: 120, reserved: 300 });
  });

  it('adds a usage pack as an expiring, additive grant', async () => {
    const { sub, pack } = await catalogue();
    const org = await makeOrg();
    const adapters = new AdapterRegistry().register(new ReferenceAppAdapter('app.crm', 'test'));
    await buy(org.id, sub.id, adapters);
    const r = await buy(org.id, pack.id, adapters);
    expect(r.status).toBe('active');
    expect((await appEntitlements(db, 'app.crm', org.id)).entitlements.find((e) => e.featureKey === 'ai.credits')!.limit).toBe(1500);
    expect(await db.subscription.count({ where: { orgId: org.id } })).toBe(1); // a pack is not a subscription
    const grant = await db.entitlement.findFirstOrThrow({ where: { orgId: org.id, sourceType: 'usage_pack' } });
    expect(grant.validTo).not.toBeNull();
    const later = new Date(grant.validTo!.getTime() + 1000);
    expect((await appEntitlements(db, 'app.crm', org.id, later)).entitlements.find((e) => e.featureKey === 'ai.credits')!.limit).toBe(1000);
  });
});
