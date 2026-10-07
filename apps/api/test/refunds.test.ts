import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { applyPaymentEvidence } from '@ooc/integrations';
import { ORIGIN, createOrg, createTestApp, db, makeOperator, onCashfree, resetDb, sellableProduct, signUp } from './harness';

let app: NestExpressApplication;
beforeAll(async () => {
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Quote → accept → hosted checkout → server-side payment evidence (the real path, Cashfree mocked). */
async function paidOrder(email: string, orgName: string) {
  onCashfree((c) => {
    const body = JSON.parse(String(c.init.body));
    return json({ order_id: body.order_id, cf_order_id: 1, order_amount: body.order_amount, order_currency: 'INR', order_status: 'ACTIVE', payment_session_id: 'session_abc' });
  });
  const owner = await signUp(app, email);
  const orgId = await createOrg(owner.agent, orgName, '29');
  const { price } = await sellableProduct({ amountMinor: 49900 });
  const q = await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 1 }] }).expect(201);
  await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/accept`).set('Origin', ORIGIN).expect(200);
  const order = await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/checkout`).set('Origin', ORIGIN).send({ idempotencyKey: `inv-${orgName}-0001`, phone: '9876543210' }).expect(201);
  const po = await db.paymentOrder.findFirstOrThrow({ where: { orderId: order.body.id } });
  const paid = await applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: `cf-${orgName}`, providerStatus: 'SUCCESS', amountMinor: 58882, currency: 'INR', raw: {} }, 'webhook');
  expect(paid.result).toBe('paid');
  return { owner, orgId, orderId: order.body.id as string };
}

describe('refunds API', () => {
  it('lets finance operators refund within the paid amount, with a credit note after confirmation', async () => {
    const alice = await paidOrder('refund@example.com', 'Refundco');
    const finance = await makeOperator(app, 'fin@example.com', 'operator_finance');
    await finance.agent.post(`/v1/admin/invoices/issue/${alice.orderId}`).set('Origin', ORIGIN).expect(201);
    onCashfree((c) => {
      const body = JSON.parse(String(c.init.body));
      return json({ refund_id: body.refund_id, cf_refund_id: `cf${body.refund_id}`, refund_amount: body.refund_amount, refund_status: 'PENDING' });
    });
    const summary = await finance.agent.get(`/v1/admin/orders/${alice.orderId}/payments`).expect(200);
    expect(summary.body).toMatchObject({ paidMinor: 58882, refundableMinor: 58882, refunds: [] });
    const r = await finance.agent.post(`/v1/admin/orders/${alice.orderId}/refunds`).set('Origin', ORIGIN).send({ amountMinor: 58882, reason: 'Cancelled in trial' }).expect(201);
    expect(r.body).toMatchObject({ status: 'pending', amountMinor: 58882, creditNote: true });
    const over = await finance.agent.post(`/v1/admin/orders/${alice.orderId}/refunds`).set('Origin', ORIGIN).send({ amountMinor: 1, reason: 'Again' }).expect(400);
    expect(over.body.error).toBe('exceeds_refundable');
    await alice.owner.agent.post(`/v1/admin/orders/${alice.orderId}/refunds`).set('Origin', ORIGIN).send({ amountMinor: 1, reason: 'Self' }).expect(403);
    const list = await finance.agent.get('/v1/admin/refunds?status=pending').expect(200);
    expect(list.body).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { action: 'refund.requested' } })).toBe(1);
  });
});
