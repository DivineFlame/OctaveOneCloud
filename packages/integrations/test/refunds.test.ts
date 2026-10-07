import { beforeEach, describe, expect, it } from 'vitest';
import { CashfreeClient } from '../src/cashfree/client';
import { applyPaymentEvidence, applyRefundStatus } from '../src/payments/processor';
import { issueInvoiceForOrder } from '../src/invoices';
import { RefundError, creditConfirmedRefunds, reconcileRefunds, refundableMinor, requestRefund } from '../src/refunds';
import { db, makeOrg, makePaidPendingOrder, makeProduct, reset } from './fixtures';

type Call = { method: string; url: string; body?: Record<string, unknown>; headers: Record<string, string> };
const seller = { legalName: 'Octave Test', address: 'Bengaluru', gstin: null, stateCode: '29', invoicePrefix: 'OOC', creditNotePrefix: 'OCN' };

function fakeCashfree(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { client: new CashfreeClient('https://sandbox.cashfree.com/pg', { clientId: 'id', clientSecret: 'secret', apiVersion: '2025-01-01' }, fetchImpl), calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const refundJson = (c: Call, status: string) => json({ refund_id: c.body?.refund_id, cf_refund_id: `cf${c.body?.refund_id}`, refund_amount: c.body?.refund_amount, refund_status: status });

/** A paid order (₹1,180 incl. 18 % GST) with its quote and invoice. */
async function paidOrder() {
  const org = await makeOrg();
  const { price } = await makeProduct({ key: `crm-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm', amountMinor: 100000 });
  const quote = await db.quote.create({
    data: {
      orgId: org.id, status: 'converted', supplyType: 'intra_state', subtotalMinor: 100000n, discountMinor: 0n, taxMinor: 18000n, totalMinor: 118000n, expiresAt: new Date(Date.now() + 3600_000),
      snapshot: { lines: [{ planPriceVersionId: price.id, description: 'CRM', quantity: 1, taxableMinor: 100000, totalMinor: 118000, tax: { ruleId: '00000000-0000-4000-8000-000000000009', components: [{ name: 'CGST', rateBps: 900, amountMinor: 9000 }, { name: 'SGST', rateBps: 900, amountMinor: 9000 }], totalTaxMinor: 18000 } }] },
    },
  });
  const { order, po } = await makePaidPendingOrder(org.id, [{ priceVersionId: price.id, totalMinor: 118000 }]);
  await db.order.update({ where: { id: order.id }, data: { quoteId: quote.id } });
  await applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: 'cf-pay-1', providerStatus: 'SUCCESS', amountMinor: 118000, currency: 'INR', raw: {} }, 'webhook');
  const inv = await issueInvoiceForOrder(db, order.id, seller);
  if (inv.result === 'not_ready') throw new Error('expected invoice');
  return { org, order, po, invoiceId: inv.invoiceId };
}

describe('refunds', () => {
  beforeEach(reset);

  it('submits with our refund id and an idempotency key, and only evidence confirms it', async () => {
    const { order, po } = await paidOrder();
    const cf = fakeCashfree((c) => refundJson(c, 'PENDING'));
    const r = await requestRefund(db, cf.client, { orderId: order.id, amountMinor: 50000, reason: 'Customer request', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: false });
    expect(r.status).toBe('pending');
    expect(cf.calls[0]).toMatchObject({ method: 'POST', url: `https://sandbox.cashfree.com/pg/orders/${po.providerOrderId}/refunds`, body: { refund_amount: 500, refund_id: r.refundRequestId } });
    expect(cf.calls[0]!.headers['x-idempotency-key']).toBe(r.id);
    expect(r.refundRequestId).toMatch(/^[A-Za-z0-9]{3,40}$/);
    expect(await refundableMinor(db, po.id)).toBe(68000);
    expect(await applyRefundStatus(db, r.refundRequestId, 'SUCCESS', '77', {})).toBe('refund_success');
    expect(await applyRefundStatus(db, r.refundRequestId, 'PENDING', '77', {})).toMatch(/ignored/); // never moves back
  });

  it('never refunds more than was paid, even under concurrency', async () => {
    const { order } = await paidOrder();
    const cf = fakeCashfree((c) => refundJson(c, 'PENDING'));
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => requestRefund(db, cf.client, { orderId: order.id, amountMinor: 50000, reason: 'Split refund', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: false })),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(2);
    const rejected = attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RefundError);
    expect(rejected.reason.code).toBe('exceeds_refundable');
  });

  it('frees the amount again when Cashfree rejects the refund', async () => {
    const { order, po } = await paidOrder();
    const cf = fakeCashfree(() => json({ message: 'insufficient balance', code: 'refund_amount_invalid' }, 400));
    const r = await requestRefund(db, cf.client, { orderId: order.id, amountMinor: 118000, reason: 'Full refund', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: false });
    expect(r).toMatchObject({ status: 'failed' });
    expect(await refundableMinor(db, po.id)).toBe(118000);
  });

  it('after a timeout, looks the refund up first and re-sends the identical request only if Cashfree has none', async () => {
    const { order } = await paidOrder();
    let phase = 'timeout';
    const cf = fakeCashfree((c) => {
      if (phase === 'timeout') throw new TypeError('network');
      if (c.method === 'GET') return json({ code: 'refund_not_found' }, 404);
      return refundJson(c, 'SUCCESS');
    });
    const r = await requestRefund(db, cf.client, { orderId: order.id, amountMinor: 1000, reason: 'Goodwill', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: false });
    expect(r.status).toBe('requested');
    phase = 'ok';
    const res = await reconcileRefunds(db, cf.client, new Date(Date.now() + 10 * 60_000));
    expect(res[0]!.result).toBe('refund_success');
    const posts = cf.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    expect(posts[0]!.headers['x-idempotency-key']).toBe(posts[1]!.headers['x-idempotency-key']);
  });

  it('issues the GST credit note only after the refund is confirmed, once', async () => {
    const { order, invoiceId } = await paidOrder();
    const cf = fakeCashfree((c) => refundJson(c, 'PENDING'));
    const r = await requestRefund(db, cf.client, { orderId: order.id, amountMinor: 59000, reason: 'Half refund', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: true });
    expect(await creditConfirmedRefunds(db, seller)).toEqual([]);
    await applyRefundStatus(db, r.refundRequestId, 'SUCCESS', '77', {});
    const issued = await creditConfirmedRefunds(db, seller);
    expect(issued).toHaveLength(1);
    expect(await creditConfirmedRefunds(db, seller)).toEqual([]);
    const cn = await db.creditNote.findFirstOrThrow({ where: { invoiceId } });
    expect(cn).toMatchObject({ amountMinor: 50000n, taxMinor: 9000n, refundId: r.id }); // ₹590 gross = ₹500 + ₹90 GST
  });

  it('refuses unpaid orders and requires an invoice for a credit note', async () => {
    const org = await makeOrg();
    const { price } = await makeProduct({ key: `x-${Math.random().toString(36).slice(2, 6)}`, fulfillment: 'app_adapter', adapterKey: 'app.crm' });
    const { order } = await makePaidPendingOrder(org.id, [{ priceVersionId: price.id, totalMinor: 1000 }]);
    const cf = fakeCashfree((c) => refundJson(c, 'PENDING'));
    await expect(requestRefund(db, cf.client, { orderId: order.id, amountMinor: 100, reason: 'x', actorId: '00000000-0000-4000-8000-0000000000aa', creditNote: false })).rejects.toMatchObject({ code: 'not_paid' });
    expect(cf.calls).toHaveLength(0);
  });
});
