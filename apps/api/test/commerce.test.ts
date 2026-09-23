import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { computeCashfreeSignature, totpCode } from '@ooc/shared';
import { ORIGIN, cashfreeCalls, createOrg, createTestApp, db, makeOperator, onCashfree, resetDb, sellableProduct, signUp } from './harness';

let app: NestExpressApplication;
beforeAll(async () => {
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('catalogue administration', () => {
  it('requires operator role and MFA for admin endpoints', async () => {
    const customer = await signUp(app, 'cust@example.com');
    await customer.agent.get('/v1/admin/catalogue/products').expect(403);
    const op = await makeOperator(app, 'op@example.com');
    await op.agent.get('/v1/admin/catalogue/products').expect(200);
    // A fresh session for the same operator must pass MFA again.
    const fresh = request.agent(app.getHttpServer());
    await fresh.post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'op@example.com', password: 'correct-horse-battery' }).expect(200);
    const denied = await fresh.get('/v1/admin/catalogue/products').expect(403);
    expect(denied.body.error).toBe('mfa_required');
    await fresh.post('/v1/auth/mfa/verify').set('Origin', ORIGIN).send({ code: totpCode(op.secret) }).expect(200);
    await fresh.get('/v1/admin/catalogue/products').expect(200);
  });

  it('keeps draft products out of the public catalogue and blocks unsafe activation', async () => {
    const op = await makeOperator(app, 'op2@example.com');
    await db.appAdapter.create({ data: { key: 'app.support', name: 'Support', status: 'unconfigured' } });
    const product = await db.product.create({ data: { key: 'support-desk', name: 'Support desk', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.support', taxCategory: 'saas' } });
    const plan = await db.plan.create({ data: { productId: product.id, key: 'support-desk-starter', name: 'Support Starter', tier: 'starter' } });
    const v = await op.agent.post(`/v1/admin/catalogue/plans/${plan.id}/versions`).set('Origin', ORIGIN).expect(201);
    await op.agent.post(`/v1/admin/catalogue/plan-versions/${v.body.id}/publish`).set('Origin', ORIGIN).expect(400);
    await op.agent.post(`/v1/admin/catalogue/plan-versions/${v.body.id}/prices`).set('Origin', ORIGIN).send({ kind: 'subscription', currency: 'INR', billingInterval: 'P1M', amountMinor: 79900, costMinor: 30000, costSource: 'measured 2026-09' }).expect(201);
    await op.agent.post(`/v1/admin/catalogue/plan-versions/${v.body.id}/publish`).set('Origin', ORIGIN).expect(201);
    await op.agent.put(`/v1/admin/catalogue/plan-versions/${v.body.id}/features`).set('Origin', ORIGIN).send({ features: [] }).expect(409);

    const blocked = await op.agent.post(`/v1/admin/catalogue/products/${product.id}/status`).set('Origin', ORIGIN).send({ status: 'active' }).expect(409);
    expect(blocked.body.blockers.join(' ')).toMatch(/unconfigured/);
    expect(blocked.body.blockers.join(' ')).toMatch(/reviewed tax rule/);
    expect((await request(app.getHttpServer()).get('/v1/catalogue/products').expect(200)).body).toEqual([]);

    await db.appAdapter.update({ where: { key: 'app.support' }, data: { status: 'sandbox' } });
    await db.taxRule.create({ data: { taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }] } });
    const rule = await db.taxRule.findFirstOrThrow();
    await op.agent.post(`/v1/admin/tax-rules/${rule.id}/review`).set('Origin', ORIGIN).send({ reviewer: 'CA Test' }).expect(201);
    await op.agent.post(`/v1/admin/catalogue/products/${product.id}/status`).set('Origin', ORIGIN).send({ status: 'active' }).expect(201);
    const pub = await request(app.getHttpServer()).get('/v1/catalogue/products').expect(200);
    expect(pub.body[0].plans[0].prices[0]).toMatchObject({ amountMinor: 79900 });
    expect(JSON.stringify(pub.body)).not.toContain('costMinor');
  });

  it('keeps published prices immutable at the database level', async () => {
    const { price } = await sellableProduct();
    await expect(db.priceVersion.update({ where: { id: price.id }, data: { amountMinor: 1n } })).rejects.toThrow();
  });
});

describe('quotes and checkout', () => {
  it('prices on the server and rejects manipulated or unsellable input', async () => {
    const owner = await signUp(app, 'buyer@example.com');
    const orgId = await createOrg(owner.agent, 'Buyer Co', '29');
    const { price } = await sellableProduct({ amountMinor: 49900 });
    await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 2, unitAmountMinor: 1 }] }).expect(400);
    await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 2 }], totalMinor: 1 }).expect(400);
    const q = await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 2 }] }).expect(201);
    expect(q.body).toMatchObject({ subtotalMinor: 99800, taxMinor: 17964, totalMinor: 117764, supplyType: 'intra_state' });

    const draft = await db.product.create({ data: { key: 'draft-x', name: 'Draft', family: 'hosted_apps', fulfillment: 'app_adapter', taxCategory: 'saas' } });
    const dp = await db.plan.create({ data: { productId: draft.id, key: 'draft-x-s', name: 'Draft S', tier: 'starter' } });
    const dv = await db.planVersion.create({ data: { planId: dp.id, version: 1, publishedAt: new Date() } });
    const dpr = await db.priceVersion.create({ data: { planVersionId: dv.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: 100n } });
    const r = await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: dpr.id, quantity: 1 }] }).expect(400);
    expect(r.body.error).toBe('product_not_available');
  });

  it('requires billing details and preserves accepted quotes across price changes', async () => {
    const owner = await signUp(app, 'nobilling@example.com');
    const org = await owner.agent.post('/v1/orgs').set('Origin', ORIGIN).send({ name: 'No Billing' }).expect(201);
    const { price, version } = await sellableProduct({ amountMinor: 10000 });
    const r = await owner.agent.post(`/v1/orgs/${org.body.id}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 1 }] }).expect(400);
    expect(r.body.error).toBe('billing_details_required');
    await owner.agent.patch(`/v1/orgs/${org.body.id}/billing`).set('Origin', ORIGIN).send({ stateCode: '27' }).expect(200);
    const q = await owner.agent.post(`/v1/orgs/${org.body.id}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 1 }] }).expect(201);
    expect(q.body.supplyType).toBe('inter_state');
    // New price version supersedes the old one; the existing quote keeps its frozen amounts.
    await db.priceVersion.update({ where: { id: price.id }, data: { effectiveTo: new Date() } });
    await db.priceVersion.create({ data: { planVersionId: version.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: 20000n } });
    const again = await owner.agent.get(`/v1/orgs/${org.body.id}/quotes/${q.body.id}`).expect(200);
    expect(again.body.totalMinor).toBe(11800);
    await owner.agent.post(`/v1/orgs/${org.body.id}/quotes/${q.body.id}/accept`).set('Origin', ORIGIN).expect(200);
  });

  it('starts hosted checkout idempotently with server totals and never trusts the redirect', async () => {
    onCashfree((c) => {
      const body = JSON.parse(String(c.init.body));
      return json({ order_id: body.order_id, cf_order_id: 1, order_amount: body.order_amount, order_currency: 'INR', order_status: 'ACTIVE', payment_session_id: 'session_abc' });
    });
    const owner = await signUp(app, 'checkout@example.com');
    const orgId = await createOrg(owner.agent, 'Checkout Co', '29');
    const { price } = await sellableProduct({ amountMinor: 49900 });
    const q = await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: price.id, quantity: 1 }] }).expect(201);
    await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/checkout`).set('Origin', ORIGIN).send({ idempotencyKey: 'checkout-0001', phone: '9876543210' }).expect(409);
    await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/accept`).set('Origin', ORIGIN).expect(200);
    const first = await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/checkout`).set('Origin', ORIGIN).send({ idempotencyKey: 'checkout-0001', phone: '9876543210' }).expect(201);
    const replay = await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/checkout`).set('Origin', ORIGIN).send({ idempotencyKey: 'checkout-0001', phone: '9876543210' }).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ status: 'awaiting_payment', totalMinor: 58882, payment: { status: 'active', paymentSessionId: 'session_abc' } });
    expect(cashfreeCalls).toHaveLength(1);
    expect(JSON.parse(String(cashfreeCalls[0]!.init.body)).order_amount).toBe(588.82);
    // The browser returning to the success URL changes nothing without server-side evidence.
    const status = await owner.agent.get(`/v1/orgs/${orgId}/orders/${first.body.id}`).expect(200);
    expect(status.body.status).toBe('awaiting_payment');
  });

  it('rejects mixed-term baskets at checkout', async () => {
    onCashfree(() => json({}, 500));
    const owner = await signUp(app, 'mixed@example.com');
    const orgId = await createOrg(owner.agent, 'Mixed Co', '29');
    const monthly = await sellableProduct({ interval: 'P1M' });
    const yearly = await sellableProduct({ interval: 'P1Y' });
    const q = await owner.agent.post(`/v1/orgs/${orgId}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: monthly.price.id, quantity: 1 }, { priceVersionId: yearly.price.id, quantity: 1 }] }).expect(201);
    expect(q.body.snapshot.checkoutGroups).toBe(2);
    await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/accept`).set('Origin', ORIGIN).expect(200);
    const r = await owner.agent.post(`/v1/orgs/${orgId}/quotes/${q.body.id}/checkout`).set('Origin', ORIGIN).send({ idempotencyKey: 'mixed-0001', phone: '9876543210' }).expect(400);
    expect(r.body.error).toBe('mixed_terms_require_separate_checkout');
    expect(cashfreeCalls).toHaveLength(0);
  });
});

describe('Cashfree webhook intake', () => {
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ooc-x' }, payment: { cf_payment_id: 1 } } });
  const send = (sig: string, ts = '1727000000000', channel = 'pg', idem?: string) => {
    const r = request(app.getHttpServer()).post(`/v1/webhooks/cashfree/${channel}`).set('content-type', 'application/json').set('x-webhook-timestamp', ts).set('x-webhook-signature', sig);
    if (idem) r.set('x-idempotency-header', idem);
    return r.send(body);
  };

  it('rejects invalid signatures without storing anything', async () => {
    await send('bogus').expect(401);
    await send(computeCashfreeSignature(Buffer.from(body), '1727000000000', 'wrong-secret')).expect(401);
    expect(await db.webhookInbox.count()).toBe(0);
  });

  it('stores verified events durably and deduplicates redeliveries', async () => {
    const sig = computeCashfreeSignature(Buffer.from(body), '1727000000000', 'whsec-test');
    const first = await send(sig).expect(200);
    expect(first.body).toEqual({ received: true });
    const dup = await send(sig).expect(200);
    expect(dup.body.duplicate).toBe(true);
    await send(sig, '1727000000000', 'pg', 'idem-123').expect(200);
    await send(sig, '1727000000000', 'pg', 'idem-123').expect(200);
    const rows = await db.webhookInbox.findMany();
    expect(rows).toHaveLength(2);
    expect(Buffer.from(rows[0]!.rawBody).toString()).toBe(body);
    expect(JSON.stringify(rows[0]!.headers)).not.toContain(sig);
  });

  it('keeps subscription events on a separate, disabled-by-default channel', async () => {
    await send(computeCashfreeSignature(Buffer.from(body), '1', 'whsec-test'), '1', 'subscriptions').expect(403);
    await send('x', '1', 'unknown').expect(403);
  });
});

describe('operations', () => {
  it('exposes health and readiness', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    const ready = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(ready.body.checks).toEqual({ database: true, redis: true });
  });

  it('reports integration state to operators without secrets', async () => {
    const op = await makeOperator(app, 'ops@example.com');
    const r = await op.agent.get('/v1/admin/integrations').expect(200);
    expect(r.body.cashfree.env).toBe('sandbox');
    expect(JSON.stringify(r.body)).not.toMatch(/test-secret|whsec-test/);
  });
});
