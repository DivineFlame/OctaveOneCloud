import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, ReferenceAppAdapter } from '../src/adapters/contract';
import { applyPaymentEvidence } from '../src/payments/processor';
import { addIsoDuration, runProvisioningJob } from '../src/provisioning/engine';
import { db, makeOrg, makePaidPendingOrder, makeProduct, reset } from './fixtures';

async function paidOrder(priceIds: string[]) {
  const org = await makeOrg();
  const { order, po } = await makePaidPendingOrder(org.id, priceIds.map((id) => ({ priceVersionId: id, totalMinor: 1000 })));
  const r = await applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: `cf-${order.id}`, providerStatus: 'SUCCESS', amountMinor: priceIds.length * 1000, currency: 'INR', raw: {} }, 'webhook');
  if (r.result !== 'paid') throw new Error('expected paid');
  return { org, order, jobIds: r.provisioningJobIds };
}

describe('provisioning workflow', () => {
  beforeEach(reset);

  it('activates with adapter evidence, grants entitlements and a subscription, and is idempotent', async () => {
    const crm = await makeProduct({ key: 'crm', fulfillment: 'app_adapter', adapterKey: 'app.crm', features: [{ key: 'crm.access', limit: null }, { key: 'seats', limit: 3 }] });
    const adapter = new ReferenceAppAdapter('app.crm');
    const reg = new AdapterRegistry().register(adapter);
    const { org, order, jobIds } = await paidOrder([crm.price.id]);
    const r = await runProvisioningJob(db, reg, jobIds[0]!);
    expect(r.status).toBe('active');
    expect(adapter.tenants.get(org.id)?.state).toBe('active');
    expect(await db.entitlement.count({ where: { orgId: org.id } })).toBe(2);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('active');
    expect(await db.subscription.count({ where: { orgId: org.id, status: 'active' } })).toBe(1);
    // Re-running a finished job is a no-op.
    expect((await runProvisioningJob(db, reg, jobIds[0]!)).status).toBe('active');
    expect(await db.subscription.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('never reports success for an unconfigured adapter', async () => {
    const crm = await makeProduct({ key: 'crm', fulfillment: 'app_adapter', adapterKey: 'app.crm', adapterStatus: 'unconfigured' });
    const { order, jobIds } = await paidOrder([crm.price.id]);
    const r = await runProvisioningJob(db, new AdapterRegistry().register(new ReferenceAppAdapter('app.crm')), jobIds[0]!);
    expect(r.status).toBe('failed');
    expect(r.steps[0]?.error).toBe('adapter_unconfigured');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('needs_attention');
  });

  it('stops on unknown adapter outcomes for reconciliation', async () => {
    const crm = await makeProduct({ key: 'crm', fulfillment: 'app_adapter', adapterKey: 'app.crm' });
    const adapter = new ReferenceAppAdapter('app.crm');
    adapter.failNext = 'unknown';
    const { jobIds } = await paidOrder([crm.price.id]);
    const r = await runProvisioningJob(db, new AdapterRegistry().register(adapter), jobIds[0]!);
    expect(r.status).toBe('unknown_outcome');
    expect(await db.entitlement.count()).toBe(0);
  });

  it('reports bundle partial failure with visible component status', async () => {
    const crm = await makeProduct({ key: 'crm', fulfillment: 'app_adapter', adapterKey: 'app.crm', features: [{ key: 'crm.access', limit: null }] });
    const wf = await makeProduct({ key: 'workflow', fulfillment: 'app_adapter', adapterKey: 'app.workflow', adapterStatus: 'unconfigured' });
    const bundle = await makeProduct({ key: 'sales-desk', fulfillment: 'bundle', family: 'agentic_bundles' });
    await db.bundleComponent.createMany({ data: [
      { bundleVersionId: bundle.version.id, componentVersionId: crm.version.id, provisionOrder: 0 },
      { bundleVersionId: bundle.version.id, componentVersionId: wf.version.id, provisionOrder: 1 },
    ] });
    const reg = new AdapterRegistry().register(new ReferenceAppAdapter('app.crm')).register(new ReferenceAppAdapter('app.workflow'));
    const { order, jobIds } = await paidOrder([bundle.price.id]);
    const r = await runProvisioningJob(db, reg, jobIds[0]!);
    expect(r.status).toBe('partially_failed');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['component:crm', 'active'], ['component:workflow', 'failed']]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('needs_attention');
    // After the operator configures the adapter, a retry only runs the failed component.
    await db.appAdapter.update({ where: { key: 'app.workflow' }, data: { status: 'sandbox' } });
    const retry = await runProvisioningJob(db, reg, jobIds[0]!);
    expect(retry.status).toBe('active');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('active');
  });

  it('refuses the reference adapter in production', () => {
    expect(() => new ReferenceAppAdapter('app.crm', 'production')).toThrow();
  });

  it('adds ISO durations with month-end clamping', () => {
    expect(addIsoDuration(new Date('2026-01-31T00:00:00Z'), 'P1M').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addIsoDuration(new Date('2026-02-15T00:00:00Z'), 'P1Y').toISOString()).toBe('2027-02-15T00:00:00.000Z');
  });
});
