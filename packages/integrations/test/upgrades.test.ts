import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, ReferenceAppAdapter } from '../src/adapters/contract';
import { applyPaymentEvidence } from '../src/payments/processor';
import { prepareRenewals } from '../src/renewals';
import { processSubscriptionLifecycle, scheduleCancellation } from '../src/subscriptions';
import { createUpgradeOrder, expireStaleUpgradeOrders, previewUpgrade } from '../src/upgrades';
import { issueInvoiceForOrder } from '../src/invoices';
import { db, makeFeature, makeOrg, makeProduct, reset } from './fixtures';

const DAY = 86_400_000;
const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-10-31T00:00:00Z'); // 30-day period
const MID = new Date(START.getTime() + 15 * DAY);
const actorId = '00000000-0000-4000-8000-0000000000aa';
const seller = { legalName: 'Octave Test', address: 'Bengaluru', gstin: null, stateCode: '29', invoicePrefix: 'OOC', creditNotePrefix: 'OCN' };

async function plan(productId: string, key: string, amount: number, seats: number, interval = 'P1M') {
  const p = await db.plan.create({ data: { productId, key, name: key, tier: 'business' } });
  const v = await db.planVersion.create({ data: { planId: p.id, version: 1 } });
  await db.planFeature.create({ data: { planVersionId: v.id, featureKey: 'crm.seats', limit: BigInt(seats) } });
  const price = await db.priceVersion.create({ data: { planVersionId: v.id, kind: 'subscription', billingInterval: interval, amountMinor: BigInt(amount), effectiveFrom: new Date('2026-01-01') } });
  await db.planVersion.update({ where: { id: v.id }, data: { publishedAt: new Date() } });
  return { version: v, price };
}

async function setup() {
  const org = await makeOrg();
  await db.taxRule.create({ data: { taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], reviewed: true } });
  await makeFeature('crm.seats', 'max');
  const { product, version, price } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm', amountMinor: 199900, features: [{ key: 'crm.seats', limit: 10 }] });
  const business = await plan(product.id, `${product.key}-biz`, 499900, 50);
  const lite = await plan(product.id, `${product.key}-lite`, 99900, 3);
  const yearly = await plan(product.id, `${product.key}-yearly`, 2999900, 50, 'P1Y');
  const adapter = new ReferenceAppAdapter('app.crm', 'test');
  const adapters = new AdapterRegistry().register(adapter);
  await adapter.provisionTenant({ orgId: org.id, correlationId: 'c', idempotencyKey: 'p', planVersionId: version.id, entitlements: [{ featureKey: 'crm.seats', limit: 10 }] });
  const sub = await db.subscription.create({ data: { orgId: org.id, planVersionId: version.id, priceVersionId: price.id, status: 'active', currentPeriodStart: START, currentPeriodEnd: END, sourceOrderItemId: '00000000-0000-4000-8000-000000000003' } });
  return { org, sub, adapter, adapters, business, lite, yearly };
}

async function pay(orderId: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const po = await db.paymentOrder.create({ data: { orgId: order.orgId, orderId, environment: 'sandbox', providerOrderId: `ooc-${orderId}`, amountMinor: order.totalMinor, currency: 'INR', status: 'active' } });
  return applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: `cf-${orderId.slice(0, 8)}`, providerStatus: 'SUCCESS', amountMinor: Number(order.totalMinor), currency: 'INR', raw: {} }, 'webhook');
}

describe('upgrades', () => {
  beforeEach(reset);

  it('prorates the difference for the rest of the period and refuses non-upgrades', async () => {
    const { org, sub, business, lite, yearly } = await setup();
    const p = await previewUpgrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1 }, MID);
    expect(p).toMatchObject({ differencePerPeriodMinor: 300000, proratedMinor: 150000, remainingRatio: 0.5 });
    await expect(previewUpgrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: lite.price.id, quantity: 1 }, MID)).rejects.toMatchObject({ code: 'not_an_upgrade' });
    await expect(previewUpgrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: yearly.price.id, quantity: 1 }, MID)).rejects.toMatchObject({ code: 'different_term' });
    // More units of the same plan is an upgrade too.
    expect((await previewUpgrade(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: sub.priceVersionId, quantity: 2 }, MID)).proratedMinor).toBe(99950);
    const other = await makeOrg('Other');
    await expect(previewUpgrade(db, { orgId: other.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1 }, MID)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('charges the prorated amount with GST and applies the plan through the adapter after payment', async () => {
    const { org, sub, adapter, adapters, business } = await setup();
    const u = await createUpgradeOrder(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1, actorId, sellerStateCode: '29' }, MID);
    expect(u).toMatchObject({ totalMinor: 177000, taxMinor: 27000 });
    expect((await pay(u.orderId)).result).toBe('paid');
    expect(await db.provisioningJob.count()).toBe(0);
    const r = await processSubscriptionLifecycle(db, adapters, new Date());
    expect(r[0]).toMatchObject({ action: 'plan_change', result: 'done' }); 
    expect(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ priceVersionId: business.price.id, planVersionId: business.version.id, currentPeriodEnd: END, scheduledChange: null });
    expect(adapter.tenants.get(org.id)?.entitlements).toEqual([{ featureKey: 'crm.seats', limit: 50 }]);
    expect((await issueInvoiceForOrder(db, u.orderId, seller)).result).toBe('issued');
  });

  it('replaces an unpaid renewal at the old price and keeps one open upgrade order', async () => {
    const { org, sub, business } = await setup();
    const renewal = (await prepareRenewals(db, { noticeDays: 7, graceDays: 7, lapseDays: 30 }, '29', new Date(END.getTime() - 5 * DAY))).created[0]!.orderId;
    const first = await createUpgradeOrder(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1, actorId, sellerStateCode: '29' }, new Date(END.getTime() - 4 * DAY));
    const second = await createUpgradeOrder(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1, actorId, sellerStateCode: '29' }, new Date(END.getTime() - 4 * DAY));
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).status).toBe('cancelled');
    await pay(second.orderId);
    expect((await db.order.findUniqueOrThrow({ where: { id: renewal } })).status).toBe('cancelled');
    const again = await prepareRenewals(db, { noticeDays: 7, graceDays: 7, lapseDays: 30 }, '29', new Date(END.getTime() - 4 * DAY));
    expect((await db.order.findUniqueOrThrow({ where: { id: again.created[0]!.orderId } })).totalMinor).toBe(589882n); // ₹4,999 + GST
  });

  it('flags a payment for review when the subscription changed after the quote', async () => {
    const { org, sub, business } = await setup();
    const u = await createUpgradeOrder(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1, actorId, sellerStateCode: '29' }, MID);
    await scheduleCancellation(db, org.id, sub.id);
    await pay(u.orderId);
    expect((await db.order.findUniqueOrThrow({ where: { id: u.orderId } })).status).toBe('needs_attention');
    expect(await db.auditEvent.count({ where: { action: 'upgrade.payment_needs_review' } })).toBe(1);
  });

  it('expires unpaid upgrade orders after 24 hours', async () => {
    const { org, sub, business } = await setup();
    const u = await createUpgradeOrder(db, { orgId: org.id, subscriptionId: sub.id, priceVersionId: business.price.id, quantity: 1, actorId, sellerStateCode: '29' });
    expect(await expireStaleUpgradeOrders(db, new Date(Date.now() + 23 * 3600_000))).toBe(0);
    expect(await expireStaleUpgradeOrders(db, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: u.orderId } })).status).toBe('expired');
  });
});
