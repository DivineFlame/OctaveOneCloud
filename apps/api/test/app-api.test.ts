import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { signAdapterPayload } from '@ooc/shared';
import { ORIGIN, createOrg, createTestApp, db, resetDb, signUp } from './harness';
import { MailService } from '../src/auth/mail.service';

const SECRET = 'crm-adapter-secret-for-tests-0123456789abcdef';
let app: NestExpressApplication;
let mail: MailService;
beforeAll(async () => {
  process.env.APP_ADAPTER_CRM_SECRET = SECRET;
  ({ app, mail } = (await createTestApp()) as { app: NestExpressApplication; mail: MailService });
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

  it('runs the approval flow: request → human decision bound to the exact action → single consume', async () => {
    const owner = await signUp(app, 'boss@example.com');
    const orgId = await createOrg(owner.agent);
    await provisioned(orgId);
    const payload = { to: 'customer@example.com', subject: 'Offer', body: 'Hello' };
    const req = await signed('approvals/request', { orgId, actionType: 'outbound_message', payload, summary: 'Send offer email to customer@example.com' }).expect(201);
    expect(mail.devOutbox.some((m) => m.to === 'boss@example.com' && m.subject.startsWith('Approval needed'))).toBe(true);
    expect((await signed('approvals/consume', { orgId, approvalId: req.body.approvalId, actionType: 'outbound_message', payload }).expect(409)).body.error).toBe('not_approved');

    const list = await owner.agent.get(`/v1/orgs/${orgId}/approvals?status=pending`).expect(200);
    expect(list.body[0]).toMatchObject({ summary: 'Send offer email to customer@example.com', canDecide: true, requestedBy: 'app.crm' });
    await owner.agent.post(`/v1/orgs/${orgId}/approvals/${req.body.approvalId}/decide`).set('Origin', ORIGIN).send({ approve: true, actionHash: '0'.repeat(64) }).expect(400);
    await owner.agent.post(`/v1/orgs/${orgId}/approvals/${req.body.approvalId}/decide`).set('Origin', ORIGIN).send({ approve: true, actionHash: list.body[0].actionHash }).expect(200);
    expect((await signed('approvals/status', { orgId, approvalId: req.body.approvalId }).expect(200)).body.status).toBe('approved');

    // A changed action invalidates the approval; the original can then no longer be executed either.
    const changed = await signed('approvals/consume', { orgId, approvalId: req.body.approvalId, actionType: 'outbound_message', payload: { ...payload, body: 'Different' } }).expect(409);
    expect(changed.body.error).toBe('inputs_changed');
    expect((await signed('approvals/consume', { orgId, approvalId: req.body.approvalId, actionType: 'outbound_message', payload }).expect(409)).body.error).toBe('not_approved');

    // Fresh request: approve, consume once.
    const r2 = await signed('approvals/request', { orgId, actionType: 'spend', payload: { amountMinor: 50000, vendor: 'ads' }, summary: 'Spend ₹500 on ads' }).expect(201);
    const hash = (await owner.agent.get(`/v1/orgs/${orgId}/approvals?status=pending`).expect(200)).body[0].actionHash;
    await owner.agent.post(`/v1/orgs/${orgId}/approvals/${r2.body.approvalId}/decide`).set('Origin', ORIGIN).send({ approve: true, actionHash: hash }).expect(200);
    await signed('approvals/consume', { orgId, approvalId: r2.body.approvalId, actionType: 'spend', payload: { amountMinor: 50000, vendor: 'ads' } }).expect(200);
    expect((await signed('approvals/consume', { orgId, approvalId: r2.body.approvalId, actionType: 'spend', payload: { amountMinor: 50000, vendor: 'ads' } }).expect(409)).body.error).toBe('already_used');
    await expect(db.approvalRequest.update({ where: { id: r2.body.approvalId }, data: { payload: { amountMinor: 1 } } })).rejects.toThrow(/immutable/);
  });

  it('lets only the right roles decide', async () => {
    const owner = await signUp(app, 'own@example.com');
    const orgId = await createOrg(owner.agent);
    await provisioned(orgId);
    const member = await signUp(app, 'member@example.com');
    const { userId } = member;
    await db.membership.create({ data: { orgId, userId, role: 'member' } });
    const r = await signed('approvals/request', { orgId, actionType: 'delete', payload: { contactId: 'c1' }, summary: 'Delete contact c1' }).expect(201);
    const view = await member.agent.get(`/v1/orgs/${orgId}/approvals`).expect(200);
    expect(view.body[0].canDecide).toBe(false);
    await member.agent.post(`/v1/orgs/${orgId}/approvals/${r.body.approvalId}/decide`).set('Origin', ORIGIN).send({ approve: true, actionHash: view.body[0].actionHash }).expect(403);
  });
});
