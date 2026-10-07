import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { signAdapterPayload } from '@ooc/shared';
import { createOrg, createTestApp, db, resetDb, signUp } from './harness';

const SECRET = 'crm-adapter-secret-for-tests-0123456789abcdef';
let app: NestExpressApplication;
beforeAll(async () => {
  process.env.APP_ADAPTER_CRM_SECRET = SECRET;
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
  delete process.env.APP_ADAPTER_CRM_SECRET;
});
beforeEach(resetDb);

function signed(path: string, body: unknown, opts: { secret?: string; ts?: number; app?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return request(app.getHttpServer())
    .post(`/v1/app-api/${path}`)
    .set('content-type', 'application/json')
    .set('x-ooc-app', opts.app ?? 'app.crm')
    .set('x-ooc-timestamp', ts)
    .set('x-ooc-signature', signAdapterPayload(opts.secret ?? SECRET, ts, raw))
    .send(raw);
}

async function provisioned(orgId: string) {
  await db.feature.create({ data: { key: 'ai.credits', name: 'AI credits', unit: 'credits', mergePolicy: 'additive', metered: true } });
  await db.appAdapter.create({ data: { key: 'app.crm', name: 'CRM', status: 'sandbox' } });
  await db.product.create({ data: { key: 'crm', name: 'CRM', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.crm', taxCategory: 'saas', status: 'active' } });
  const job = await db.provisioningJob.create({ data: { orgId, adapterKey: 'app.crm', idempotencyKey: `t-${orgId}`, status: 'active' } });
  await db.provisioningStep.create({ data: { jobId: job.id, name: 'product:crm', status: 'active' } });
  await db.entitlement.create({ data: { orgId, featureKey: 'ai.credits', limit: 100n, mergePolicy: 'additive', sourceType: 'subscription', sourceId: 'x:y' } });
}

describe('app service API', () => {
  it('authenticates apps by signature and serves only provisioned organisations', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const orgId = await createOrg(owner.agent);
    expect((await signed('entitlements', { orgId }, { secret: 'wrong-secret-wrong-secret-wrong-secret' })).status).toBe(401);
    expect((await signed('entitlements', { orgId }, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect((await signed('entitlements', { orgId }, { app: 'app.unknown' })).status).toBe(401);
    expect((await signed('entitlements', { orgId })).status).toBe(403);

    await provisioned(orgId);
    const e = await signed('entitlements', { orgId }).expect(200);
    expect(e.body.entitlements).toEqual([{ featureKey: 'ai.credits', limit: 100, mergePolicy: 'additive' }]);

    const r = await signed('usage/reserve', { orgId, resource: 'ai.credits', quantity: 60, idempotencyKey: 'run-0001' }).expect(200);
    const over = await signed('usage/reserve', { orgId, resource: 'ai.credits', quantity: 60, idempotencyKey: 'run-0002' }).expect(409);
    expect(over.body).toMatchObject({ error: 'quota_exceeded', limit: 100, reserved: 60 });
    await signed('usage/settle', { reservationId: r.body.reservationId, actualQuantity: 42, sourceEventId: 'evt-1' }).expect(200);

    const usage = await owner.agent.get(`/v1/orgs/${orgId}/usage`).expect(200);
    expect(usage.body.features[0]).toMatchObject({ featureKey: 'ai.credits', limit: 100, used: 42, reserved: 0 });
    const other = await signUp(app, 'other@example.com');
    await other.agent.get(`/v1/orgs/${orgId}/usage`).expect(404);
  });
});
