import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ORIGIN, createOrg, createTestApp, db, makeOperator, resetDb, sellableProduct, signUp } from './harness';

let app: NestExpressApplication;
beforeAll(async () => {
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

async function activeSubscription(orgId: string) {
  const { product, version, price } = await sellableProduct({ amountMinor: 199900 });
  const plan = await db.plan.create({ data: { productId: product.id, key: `${product.key}-lite`, name: 'CRM Lite', tier: 'starter' } });
  const lite = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  const litePrice = await db.priceVersion.create({ data: { planVersionId: lite.id, kind: 'subscription', billingInterval: 'P1M', amountMinor: 99900n } });
  await db.planVersion.update({ where: { id: lite.id }, data: { publishedAt: new Date() } });
  const sub = await db.subscription.create({
    data: { orgId, planVersionId: version.id, priceVersionId: price.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  });
  return { sub, litePrice };
}

describe('subscriptions API', () => {
  it('lets billing managers cancel, keep and downgrade their own subscriptions only', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const orgId = await createOrg(owner.agent);
    const { sub, litePrice } = await activeSubscription(orgId);

    const list = await owner.agent.get(`/v1/orgs/${orgId}/subscriptions`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: sub.id, status: 'active', amountMinor: 199900, cancelAtPeriodEnd: false });
    expect(list.body[0].downgradeOptions.map((o: { priceVersionId: string }) => o.priceVersionId)).toEqual([litePrice.id]);

    const c = await owner.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/cancel`).set('Origin', ORIGIN).expect(200);
    expect(c.body).toMatchObject({ status: 'cancel_scheduled', cancelAtPeriodEnd: true, downgradeOptions: [] });
    const blocked = await owner.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/downgrade`).set('Origin', ORIGIN).send({ priceVersionId: litePrice.id }).expect(400);
    expect(blocked.body.error).toBe('cancellation_scheduled');
    await owner.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/keep`).set('Origin', ORIGIN).expect(200);

    const d = await owner.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/downgrade`).set('Origin', ORIGIN).send({ priceVersionId: litePrice.id }).expect(200);
    expect(d.body.scheduledChange).toMatchObject({ priceVersionId: litePrice.id, planName: 'CRM Lite', amountMinor: 99900, quantity: 1 });
    const w = await owner.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/scheduled-change/withdraw`).set('Origin', ORIGIN).expect(200);
    expect(w.body.scheduledChange).toBeNull();
    expect(await db.auditEvent.count({ where: { targetId: sub.id, actorType: 'user' } })).toBe(4);

    const mallory = await signUp(app, 'mallory@example.com');
    const malloryOrg = await createOrg(mallory.agent, 'Mallory Co');
    await mallory.agent.post(`/v1/orgs/${orgId}/subscriptions/${sub.id}/cancel`).set('Origin', ORIGIN).expect(404);
    await mallory.agent.post(`/v1/orgs/${malloryOrg}/subscriptions/${sub.id}/cancel`).set('Origin', ORIGIN).expect(404);
    expect((await mallory.agent.get(`/v1/orgs/${malloryOrg}/subscriptions`).expect(200)).body).toEqual([]);
    await mallory.agent.post(`/v1/admin/subscriptions/${sub.id}/suspend`).set('Origin', ORIGIN).send({ reason: 'nope' }).expect(403);
  });

  it('records operator suspend requests for the worker to carry out', async () => {
    const owner = await signUp(app, 'acme@example.com');
    const orgId = await createOrg(owner.agent);
    const { sub } = await activeSubscription(orgId);
    const op = await makeOperator(app, 'ops@example.com');
    const r = await op.agent.post(`/v1/admin/subscriptions/${sub.id}/suspend`).set('Origin', ORIGIN).send({ reason: 'Abuse report 12' }).expect(200);
    expect(r.body).toMatchObject({ status: 'active', pendingAction: 'suspend' });
    const resume = await op.agent.post(`/v1/admin/subscriptions/${sub.id}/resume`).set('Origin', ORIGIN).send({ reason: 'Resolved' }).expect(400);
    expect(resume.body.error).toBe('invalid_state');
    const list = await op.agent.get('/v1/admin/subscriptions?status=active').expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([sub.id]);
    expect(await db.auditEvent.count({ where: { action: 'subscription.suspend_requested' } })).toBe(1);
  });
});
