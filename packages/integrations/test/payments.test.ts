import { beforeEach, describe, expect, it } from 'vitest';
import { applyPaymentEvidence, processInboxRow } from '../src/payments/processor';
import { db, makeOrg, makePaidPendingOrder, makeProduct, reset } from './fixtures';

async function setup(amount = 118000) {
  const org = await makeOrg();
  const { price } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm' });
  const { order, po } = await makePaidPendingOrder(org.id, [{ priceVersionId: price.id, totalMinor: amount }]);
  return { org, order, po };
}

const ev = (providerOrderId: string, cfPaymentId: string, providerStatus: string, amountMinor = 118000, currency = 'INR') => ({ providerOrderId, cfPaymentId, providerStatus, amountMinor, currency, raw: { cfPaymentId } });

describe('payment evidence processing', () => {
  beforeEach(reset);

  it('marks the order paid once and creates one provisioning job per item, even on redelivery', async () => {
    const { order, po } = await setup();
    const first = await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-1', 'SUCCESS'), 'webhook');
    expect(first.result).toBe('paid');
    const again = await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-1', 'SUCCESS'), 'status_api');
    expect(again.result).toBe('already_paid');
    expect(await db.provisioningJob.count({ where: { orderItem: { orderId: order.id } } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('provisioning');
  });

  it('handles concurrent duplicate success events without double fulfilment', async () => {
    const { order, po } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-1', 'SUCCESS'), 'webhook')));
    const paid = results.filter((r) => r.status === 'fulfilled' && r.value.result === 'paid');
    expect(paid).toHaveLength(1);
    expect(await db.provisioningJob.count({ where: { orderItem: { orderId: order.id } } })).toBe(1);
    expect(await db.paymentAttempt.count({ where: { paymentOrderId: po.id } })).toBe(1);
  });

  it('accepts a success after a failed attempt and a late failure never overwrites it', async () => {
    const { order, po } = await setup();
    expect((await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-a', 'FAILED'), 'webhook')).result).toBe('recorded');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('awaiting_payment');
    expect((await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-b', 'SUCCESS'), 'webhook')).result).toBe('paid');
    // Out-of-order stale events for both attempts.
    await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-b', 'PENDING'), 'webhook');
    await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-a', 'FAILED'), 'webhook');
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { providerPaymentId: 'cf-b' } });
    expect(attempt.status).toBe('success');
    expect((await db.paymentOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('paid');
  });

  it('flags a second successful payment for refund review instead of re-fulfilling', async () => {
    const { order, po } = await setup();
    await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-1', 'SUCCESS'), 'webhook');
    const dup = await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-2', 'SUCCESS'), 'webhook');
    expect(dup.result).toBe('duplicate_payment');
    expect(await db.provisioningJob.count({ where: { orderItem: { orderId: order.id } } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'payment.duplicate_success' } })).toBe(1);
  });

  it('refuses fulfilment when amount or currency does not match the server order', async () => {
    const { order, po } = await setup();
    const r = await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-1', 'SUCCESS', 100), 'webhook');
    expect(r.result).toBe('mismatch');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('needs_attention');
    expect((await db.paymentOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('active');
    expect(await db.provisioningJob.count()).toBe(0);
    const r2 = await applyPaymentEvidence(db, ev(po.providerOrderId, 'cf-2', 'SUCCESS', 118000, 'USD'), 'webhook');
    expect(r2.result).toBe('mismatch');
  });

  it('processes a stored inbox row idempotently and fails loudly for unknown orders', async () => {
    const { po } = await setup();
    const body = { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: po.providerOrderId, order_amount: 1180, order_currency: 'INR' }, payment: { cf_payment_id: 555, payment_status: 'SUCCESS', payment_amount: 1180.0, payment_currency: 'INR' } } };
    const row = await db.webhookInbox.create({ data: { provider: 'cashfree', channel: 'pg', dedupeKey: 'k1', rawBody: new Uint8Array(Buffer.from(JSON.stringify(body))), headers: {}, signatureValid: true } });
    expect((await processInboxRow(db, row.id)).detail).toBe('paid');
    expect((await processInboxRow(db, row.id)).status).toBe('ignored');

    const bad = await db.webhookInbox.create({ data: { provider: 'cashfree', channel: 'pg', dedupeKey: 'k2', rawBody: new Uint8Array(Buffer.from(JSON.stringify({ ...body, data: { ...body.data, order: { order_id: 'nope' } } }))), headers: {}, signatureValid: true } });
    await expect(processInboxRow(db, bad.id)).rejects.toThrow(/unknown provider order/);
    expect((await db.webhookInbox.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe('failed');
  });

  it('only confirms refunds from provider evidence and ignores backwards transitions', async () => {
    const { po } = await setup();
    const { applyRefundStatus } = await import('../src/payments/processor');
    await db.refund.create({ data: { paymentOrderId: po.id, refundRequestId: 'rf-1', amountMinor: 1000n, reason: 'test' } });
    expect(await applyRefundStatus(db, 'rf-1', 'PENDING', 'cf-r1', {})).toBe('refund_pending');
    expect(await applyRefundStatus(db, 'rf-1', 'SUCCESS', 'cf-r1', {})).toBe('refund_success');
    expect(await applyRefundStatus(db, 'rf-1', 'PENDING', 'cf-r1', {})).toMatch(/ignored/);
    expect((await db.refund.findUniqueOrThrow({ where: { refundRequestId: 'rf-1' } })).status).toBe('success');
  });
});
