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

describe('invoices', () => {
  it('lets billing members read their own invoices only; finance operators issue credit notes', async () => {
    const alice = await paidOrder('alice@example.com', 'Alice');
    const bob = await paidOrder('bob@example.com', 'Bob');

    const finance = await makeOperator(app, 'finance@example.com', 'operator_finance');
    const admin0 = await finance.agent.get('/v1/admin/invoices').expect(200);
    expect(admin0.body).toMatchObject({ sellerConfigured: true, ordersAwaitingInvoice: 2, invoices: [] });

    const issued = await finance.agent.post(`/v1/admin/invoices/issue/${alice.orderId}`).set('Origin', ORIGIN).expect(201);
    expect(issued.body.result).toBe('issued');
    expect(issued.body.number).toMatch(/^OOC\/\d{2}-\d{2}\/00001$/);
    const repeat = await finance.agent.post(`/v1/admin/invoices/issue/${alice.orderId}`).set('Origin', ORIGIN).expect(201);
    expect(repeat.body).toMatchObject({ result: 'exists', invoiceId: issued.body.invoiceId });
    await finance.agent.post(`/v1/admin/invoices/issue/${bob.orderId}`).set('Origin', ORIGIN).expect(201);

    const list = await alice.owner.agent.get(`/v1/orgs/${alice.orgId}/invoices`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ totalMinor: 58882, taxMinor: 8982, subtotalMinor: 49900 });
    const inv = await alice.owner.agent.get(`/v1/orgs/${alice.orgId}/invoices/${issued.body.invoiceId}`).expect(200);
    expect(inv.body.billing.seller.legalName).toBe('Octave Test Services Pvt Ltd');
    expect(inv.body.billing.buyer.legalName).toBeTruthy();
    expect(inv.body.lines).toHaveLength(1);

    // Tenant isolation: Bob cannot see Alice's invoice through either org.
    await bob.owner.agent.get(`/v1/orgs/${alice.orgId}/invoices/${issued.body.invoiceId}`).expect(404);
    await bob.owner.agent.get(`/v1/orgs/${bob.orgId}/invoices/${issued.body.invoiceId}`).expect(404);
    await bob.owner.agent.get('/v1/admin/invoices').expect(403);

    // Credit notes: finance operators only, capped at the invoice's taxable value.
    await alice.owner.agent.post(`/v1/admin/invoices/${issued.body.invoiceId}/credit-notes`).set('Origin', ORIGIN).send({ taxableMinor: 100, reason: 'Goodwill' }).expect(403);
    const cn = await finance.agent.post(`/v1/admin/invoices/${issued.body.invoiceId}/credit-notes`).set('Origin', ORIGIN).send({ taxableMinor: 49900, reason: 'Cancelled within trial' }).expect(201);
    expect(cn.body).toMatchObject({ amountMinor: 49900, taxMinor: 8982 });
    expect(cn.body.number).toMatch(/^OCN\/\d{2}-\d{2}\/00001$/);
    const over = await finance.agent.post(`/v1/admin/invoices/${issued.body.invoiceId}/credit-notes`).set('Origin', ORIGIN).send({ taxableMinor: 1, reason: 'Too much' }).expect(400);
    expect(over.body.error).toBe('credit_note_rejected');

    const after = await alice.owner.agent.get(`/v1/orgs/${alice.orgId}/invoices/${issued.body.invoiceId}`).expect(200);
    expect(after.body.creditNotes).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { action: 'invoice.credit_note_issued' } })).toBe(1);
  });
});
