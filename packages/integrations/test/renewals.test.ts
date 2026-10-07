import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, ReferenceAppAdapter } from '../src/adapters/contract';
import { applyPaymentEvidence } from '../src/payments/processor';
import { advanceOverdueRenewals, claimRenewalReminders, prepareRenewals } from '../src/renewals';
import { processSubscriptionLifecycle, scheduleCancellation, scheduleDowngrade, withdrawCancellation } from '../src/subscriptions';
import { issueInvoiceForOrder } from '../src/invoices';
import { db, makeFeature, makeOrg, makeProduct, reset } from './fixtures';

const DAY = 86_400_000;
const settings = { noticeDays: 7, graceDays: 7, lapseDays: 30 };
const PERIOD_END = new Date('2026-11-01T00:00:00Z');
const at = (days: number) => new Date(PERIOD_END.getTime() + days * DAY);
const seller = { legalName: 'Octave Test', address: 'Bengaluru', gstin: null, stateCode: '29', invoicePrefix: 'OOC', creditNotePrefix: 'OCN' };

async function setup() {
  const org = await makeOrg(); // state 29 → intra-state GST
  await db.organization.update({ where: { id: org.id }, data: { billingEmail: 'accounts@acme.test' } });
  await db.taxRule.create({ data: { taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], reviewed: true } });
  await makeFeature('crm.seats', 'max');
  const { product, version, price } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm', amountMinor: 199900, features: [{ key: 'crm.seats', limit: 10 }] });
  const plan = await db.plan.create({ data: { productId: product.id, key: `${product.key}-lite`, name: 'Lite', tier: 'starter' } });
  const lite = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  await db.planFeature.create({ data: { planVersionId: lite.id, featureKey: 'crm.seats', limit: 3n } });
  const litePrice = await db.priceVersion.create({ data: { planVersionId: lite.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: 99900n } });
  await db.planVersion.update({ where: { id: lite.id }, data: { publishedAt: new Date() } });

  const adapter = new ReferenceAppAdapter('app.crm', 'test');
  const adapters = new AdapterRegistry().register(adapter);
  await adapter.provisionTenant({ orgId: org.id, correlationId: 'c', idempotencyKey: 'p', planVersionId: version.id, entitlements: [{ featureKey: 'crm.seats', limit: 10 }] });
  const itemId = '00000000-0000-4000-8000-000000000002';
  await db.entitlement.create({ data: { orgId: org.id, featureKey: 'crm.seats', limit: 10n, mergePolicy: 'max', sourceType: 'subscription', sourceId: `${itemId}:${version.id}` } });
  const sub = await db.subscription.create({
    data: { orgId: org.id, planVersionId: version.id, priceVersionId: price.id, status: 'active', currentPeriodStart: at(-31), currentPeriodEnd: PERIOD_END, sourceOrderItemId: itemId },
  });
  return { org, sub, adapter, adapters, litePrice, lite };
}

async function pay(orderId: string, paymentId = `cf-${orderId.slice(0, 8)}`) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const po = await db.paymentOrder.create({ data: { orgId: order.orgId, orderId, environment: 'sandbox', providerOrderId: `ooc-${orderId}`, amountMinor: order.totalMinor, currency: 'INR', status: 'active' } });
  return applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: paymentId, providerStatus: 'SUCCESS', amountMinor: Number(order.totalMinor), currency: 'INR', raw: {} }, 'webhook');
}

const subOf = (id: string) => db.subscription.findUniqueOrThrow({ where: { id } });
const runOf = (subscriptionId: string) => db.renewalRun.findFirstOrThrow({ where: { subscriptionId }, orderBy: { createdAt: 'desc' } });

describe('renewals', () => {
  beforeEach(reset);

  it('creates one renewal order inside the notice window, with GST, idempotently', async () => {
    const { sub } = await setup();
    expect((await prepareRenewals(db, settings, '29', at(-8))).created).toEqual([]);
    const r = await prepareRenewals(db, settings, '29', at(-7));
    expect(r.created).toHaveLength(1);
    expect((await prepareRenewals(db, settings, '29', at(-6))).created).toEqual([]);
    const order = await db.order.findUniqueOrThrow({ where: { id: r.created[0]!.orderId }, include: { items: true, quote: true } });
    expect(order).toMatchObject({ kind: 'renewal', subscriptionId: sub.id, status: 'awaiting_payment', totalMinor: 235882n });
    expect(await db.order.count({ where: { kind: 'renewal' } })).toBe(1);
  });

  it('records blocking problems and retries once they are fixed', async () => {
    const { org } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { stateCode: null } });
    const r = await prepareRenewals(db, settings, '29', at(-3));
    expect(r.blocked[0]!.error).toMatch(/billing_details_required/);
    await db.organization.update({ where: { id: org.id }, data: { stateCode: '29' } });
    expect((await prepareRenewals(db, settings, '29', at(-2))).created).toHaveLength(1);
  });

  it('extends from the old period end on payment, without provisioning again, and invoices it', async () => {
    const { sub } = await setup();
    const { created } = await prepareRenewals(db, settings, '29', at(-5));
    const paid = await pay(created[0]!.orderId);
    expect(paid).toMatchObject({ result: 'paid', provisioningJobIds: [] });
    expect(await subOf(sub.id)).toMatchObject({ status: 'active', currentPeriodStart: PERIOD_END, currentPeriodEnd: new Date('2026-12-01T00:00:00Z') });
    expect(await db.provisioningJob.count()).toBe(0);
    expect((await runOf(sub.id)).status).toBe('paid');
    expect((await db.order.findUniqueOrThrow({ where: { id: created[0]!.orderId } })).status).toBe('active');
    const inv = await issueInvoiceForOrder(db, created[0]!.orderId, seller);
    expect(inv.result).toBe('issued');
    // The next period's renewal is a new run.
    expect((await prepareRenewals(db, settings, '29', new Date('2026-11-25T00:00:00Z'))).created).toHaveLength(1);
  });

  it('goes past due, suspends after grace, and restores access when paid', async () => {
    const { org, sub, adapter, adapters } = await setup();
    const { created } = await prepareRenewals(db, settings, '29', at(-7));
    expect((await advanceOverdueRenewals(db, settings, at(-1))).pastDue).toBe(0);
    expect((await advanceOverdueRenewals(db, settings, at(0))).pastDue).toBe(1);
    expect(await subOf(sub.id)).toMatchObject({ status: 'past_due', graceEndsAt: at(7) });
    expect(adapter.tenants.get(org.id)?.state).toBe('active'); // access continues in grace

    expect((await advanceOverdueRenewals(db, settings, at(7))).suspensionsRequested).toBe(1);
    await processSubscriptionLifecycle(db, adapters, at(7));
    expect(await subOf(sub.id)).toMatchObject({ status: 'suspended', suspensionReason: 'non_payment' });
    expect(adapter.tenants.get(org.id)?.state).toBe('suspended');
    expect(await db.entitlement.count({ where: { orgId: org.id, revokedAt: null } })).toBe(0);

    await pay(created[0]!.orderId);
    expect(await subOf(sub.id)).toMatchObject({ status: 'suspended', pendingAction: 'resume', currentPeriodEnd: new Date('2026-12-01T00:00:00Z') });
    await processSubscriptionLifecycle(db, adapters, at(8));
    expect(await subOf(sub.id)).toMatchObject({ status: 'active', suspensionReason: null, graceEndsAt: null });
    expect(adapter.tenants.get(org.id)?.state).toBe('active');
    expect(await db.entitlement.count({ where: { orgId: org.id, revokedAt: null } })).toBe(1);
  });

  it('does not resume a subscription an operator suspended for another reason', async () => {
    const { sub, adapters } = await setup();
    const { created } = await prepareRenewals(db, settings, '29', at(-7));
    await db.subscription.update({ where: { id: sub.id }, data: { pendingAction: 'suspend', pendingActionReason: 'abuse report' } });
    await processSubscriptionLifecycle(db, adapters, at(-6));
    await pay(created[0]!.orderId);
    expect(await subOf(sub.id)).toMatchObject({ status: 'suspended', pendingAction: null, suspensionReason: 'abuse report' });
  });

  it('ends the subscription after the lapse period and refuses a late payment for review', async () => {
    const { org, sub, adapter, adapters } = await setup();
    const { created } = await prepareRenewals(db, settings, '29', at(-7));
    await advanceOverdueRenewals(db, settings, at(0));
    await advanceOverdueRenewals(db, settings, at(7));
    await processSubscriptionLifecycle(db, adapters, at(7));
    expect((await advanceOverdueRenewals(db, settings, at(30))).lapsed).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: created[0]!.orderId } })).status).toBe('expired');
    await processSubscriptionLifecycle(db, adapters, at(30));
    expect(await subOf(sub.id)).toMatchObject({ status: 'cancelled' });
    expect(adapter.tenants.get(org.id)?.state).toBe('suspended'); // data kept

    const late = await pay(created[0]!.orderId);
    expect(late.result).toBe('mismatch'); // received for an inactive order → needs_attention, never silently kept
    expect((await db.order.findUniqueOrThrow({ where: { id: created[0]!.orderId } })).status).toBe('needs_attention');
  });

  it('re-prices the unpaid renewal when a downgrade is scheduled and applies the downgrade at the boundary', async () => {
    const { org, sub, adapter, adapters, litePrice, lite } = await setup();
    const first = (await prepareRenewals(db, settings, '29', at(-7))).created[0]!.orderId;
    await scheduleDowngrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: litePrice.id, quantity: 1 }, at(-6));
    expect((await db.order.findUniqueOrThrow({ where: { id: first } })).status).toBe('cancelled');
    const second = (await prepareRenewals(db, settings, '29', at(-6))).created[0]!.orderId;
    expect((await db.order.findUniqueOrThrow({ where: { id: second } })).totalMinor).toBe(117882n);

    await pay(second); // paid early: the period moves on, the downgrade still applies at the old boundary
    expect(await processSubscriptionLifecycle(db, adapters, at(-1))).toEqual([]);
    const r = await processSubscriptionLifecycle(db, adapters, at(0));
    expect(r[0]).toMatchObject({ action: 'plan_change', result: 'done' });
    expect(await subOf(sub.id)).toMatchObject({ planVersionId: lite.id, priceVersionId: litePrice.id, scheduledChangeDueAt: null, currentPeriodEnd: new Date('2026-12-01T00:00:00Z') });
    expect(adapter.tenants.get(org.id)?.entitlements).toEqual([{ featureKey: 'crm.seats', limit: 3 }]);
  });

  it('cancelling stops the pending renewal order; keeping the subscription re-creates it', async () => {
    const { org, sub } = await setup();
    const first = (await prepareRenewals(db, settings, '29', at(-7))).created[0]!.orderId;
    await scheduleCancellation(db, org.id, sub.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: first } })).status).toBe('cancelled');
    expect((await runOf(sub.id)).status).toBe('cancelled');
    expect(await advanceOverdueRenewals(db, settings, at(1))).toEqual({ pastDue: 0, suspensionsRequested: 0, lapsed: 0 });

    await withdrawCancellation(db, org.id, sub.id, at(-5));
    const again = await prepareRenewals(db, settings, '29', at(-5));
    expect(again.created).toHaveLength(1);
    expect(again.created[0]!.orderId).not.toBe(first);
  });

  it('sends each reminder stage once, skipping stages missed during downtime', async () => {
    const { sub } = await setup();
    await prepareRenewals(db, settings, '29', at(-7));
    const first = await claimRenewalReminders(db, 'https://app.test', at(-7));
    expect(first.map((m) => m.stage)).toEqual(['upcoming']);
    expect(first[0]!.to).toEqual(['accounts@acme.test']);
    expect(first[0]!.text).toContain('₹2,358.82');
    expect(await claimRenewalReminders(db, 'https://app.test', at(-6))).toEqual([]);
    await advanceOverdueRenewals(db, settings, at(0));
    const later = await claimRenewalReminders(db, 'https://app.test', at(6)); // due_tomorrow and overdue were missed
    expect(later.map((m) => m.stage)).toEqual(['suspension_warning']);
    expect((await runOf(sub.id)).remindersSent.sort()).toEqual(['due_tomorrow', 'overdue', 'suspension_warning', 'upcoming']);
  });
});
