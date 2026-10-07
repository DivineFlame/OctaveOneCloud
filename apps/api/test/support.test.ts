import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MailService } from '../src/auth/mail.service';
import { ORIGIN, createOrg, createTestApp, db, makeOperator, resetDb, signUp } from './harness';

let app: NestExpressApplication;
let mail: MailService;
beforeAll(async () => {
  ({ app, mail } = (await createTestApp()) as { app: NestExpressApplication; mail: MailService });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

describe('support tickets', () => {
  it('lets any member open and follow a ticket; internal notes stay hidden', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const orgId = await createOrg(owner.agent);
    const created = await owner.agent
      .post(`/v1/orgs/${orgId}/tickets`)
      .set('Origin', ORIGIN)
      .send({ subject: 'Please transfer my domain', body: 'acme.in should move to you', category: 'manual_service_request' })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'open', category: 'manual_service_request' });
    expect(created.body.messages).toHaveLength(1);

    const op = await makeOperator(app, 'support@example.com');
    const queue = await op.agent.get('/v1/admin/tickets').expect(200);
    expect(queue.body.map((t: { id: string }) => t.id)).toContain(created.body.id);

    await op.agent.post(`/v1/admin/tickets/${created.body.id}/messages`).set('Origin', ORIGIN).send({ body: 'Checked registrar lock', internal: true }).expect(201);
    const replied = await op.agent.post(`/v1/admin/tickets/${created.body.id}/messages`).set('Origin', ORIGIN).send({ body: 'Please share the EPP code' }).expect(201);
    expect(replied.body.status).toBe('pending_customer');
    expect(mail.devOutbox.some((m) => m.to === 'owner@example.com' && m.subject.startsWith('Re: Please transfer'))).toBe(true);

    const view = await owner.agent.get(`/v1/orgs/${orgId}/tickets/${created.body.id}`).expect(200);
    expect(view.body.messages.map((m: { body: string }) => m.body)).toEqual(['acme.in should move to you', 'Please share the EPP code']);
    expect(JSON.stringify(view.body)).not.toContain('registrar lock');
    expect(view.body.messages[1].author.isStaff).toBe(true);

    const after = await owner.agent.post(`/v1/orgs/${orgId}/tickets/${created.body.id}/messages`).set('Origin', ORIGIN).send({ body: 'EPP is 1234' }).expect(201);
    expect(after.body.status).toBe('pending_internal');

    await owner.agent.post(`/v1/orgs/${orgId}/tickets/${created.body.id}/close`).set('Origin', ORIGIN).expect(200);
    const blocked = await owner.agent.post(`/v1/orgs/${orgId}/tickets/${created.body.id}/messages`).set('Origin', ORIGIN).send({ body: 'one more' }).expect(400);
    expect(blocked.body.error).toBe('ticket_closed');
  });

  it('isolates tickets between organisations and keeps customers out of the operator queue', async () => {
    const alice = await signUp(app, 'alice@example.com');
    const aliceOrg = await createOrg(alice.agent, 'Alice Co');
    const t = await alice.agent.post(`/v1/orgs/${aliceOrg}/tickets`).set('Origin', ORIGIN).send({ subject: 'Billing question', body: 'Hi' }).expect(201);

    const bob = await signUp(app, 'bob@example.com');
    const bobOrg = await createOrg(bob.agent, 'Bob Co');
    await bob.agent.get(`/v1/orgs/${aliceOrg}/tickets/${t.body.id}`).expect(404);
    await bob.agent.get(`/v1/orgs/${bobOrg}/tickets/${t.body.id}`).expect(404);
    expect((await bob.agent.get(`/v1/orgs/${bobOrg}/tickets`).expect(200)).body).toEqual([]);
    await bob.agent.get('/v1/admin/tickets').expect(403);
    await alice.agent.post(`/v1/orgs/${aliceOrg}/tickets`).set('Origin', ORIGIN).send({ subject: 'x', body: 'y' }).expect(400);
  });

  it('rejects linking a ticket to another organisation’s service', async () => {
    const alice = await signUp(app, 'svc@example.com');
    const orgId = await createOrg(alice.agent);
    const other = await db.organization.create({ data: { name: 'Other', slug: 'other-x1' } });
    const product = await db.product.create({ data: { key: 'p-x', name: 'P', family: 'domains', fulfillment: 'resellerclub', taxCategory: 'domain' } });
    const svc = await db.service.create({ data: { orgId: other.id, productId: product.id, provider: 'resellerclub', displayName: 'other.in' } });
    await alice.agent.post(`/v1/orgs/${orgId}/tickets`).set('Origin', ORIGIN).send({ subject: 'Renew please', body: 'renew', serviceId: svc.id }).expect(400);
  });
});
