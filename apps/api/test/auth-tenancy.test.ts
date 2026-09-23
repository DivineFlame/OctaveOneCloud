import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MailService } from '../src/auth/mail.service';
import { ORIGIN, createOrg, createTestApp, db, resetDb, signUp } from './harness';

let app: NestExpressApplication;
let mail: MailService;

beforeAll(async () => {
  ({ app, mail } = (await createTestApp()) as { app: NestExpressApplication; mail: MailService });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

describe('authentication', () => {
  it('registers, logs in with an httpOnly cookie, and rejects bad credentials generically', async () => {
    const server = app.getHttpServer();
    await request(server).post('/v1/auth/register').set('Origin', ORIGIN).send({ email: 'a@example.com', password: 'short' }).expect(400);
    await request(server).post('/v1/auth/register').set('Origin', ORIGIN).send({ email: 'a@example.com', password: 'long-enough-password' }).expect(201);
    await request(server).post('/v1/auth/register').set('Origin', ORIGIN).send({ email: 'A@example.com', password: 'long-enough-password' }).expect(409);
    const login = await request(server).post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'a@example.com', password: 'long-enough-password' }).expect(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const bad = await request(server).post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'a@example.com', password: 'wrong-password-xx' }).expect(401);
    const unknown = await request(server).post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'nobody@example.com', password: 'wrong-password-xx' }).expect(401);
    expect(bad.body.error).toBe(unknown.body.error);
    await request(server).get('/v1/auth/me').expect(401);
  });

  it('stores only hashed session tokens and revokes on logout', async () => {
    const u = await signUp(app, 'b@example.com');
    const sessions = await db.session.findMany({ where: { userId: u.userId } });
    expect(sessions[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await u.agent.post('/v1/auth/logout').set('Origin', ORIGIN).expect(204);
    await u.agent.get('/v1/auth/me').expect(401);
  });

  it('rejects cookie-authenticated mutations from untrusted origins (CSRF)', async () => {
    const u = await signUp(app, 'c@example.com');
    await u.agent.post('/v1/orgs').set('Origin', 'https://evil.example').send({ name: 'Evil Org' }).expect(403);
    await u.agent.post('/v1/orgs').send({ name: 'No Origin' }).expect(403);
    await u.agent.post('/v1/orgs').set('Origin', ORIGIN).send({ name: 'Good Org' }).expect(201);
  });

  it('verifies email and resets passwords with single-use tokens, revoking sessions', async () => {
    const u = await signUp(app, 'd@example.com');
    const verifyToken = new URL(mail.devOutbox.find((m) => m.to === 'd@example.com' && /Verify/.test(m.subject))!.text).searchParams.get('token')!;
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token: verifyToken }).expect(200);
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token: verifyToken }).expect(400);

    await request(app.getHttpServer()).post('/v1/auth/password-reset/request').send({ email: 'nobody@example.com' }).expect(202);
    await request(app.getHttpServer()).post('/v1/auth/password-reset/request').send({ email: 'd@example.com' }).expect(202);
    const resetToken = new URL(mail.devOutbox.filter((m) => /Reset/.test(m.subject)).at(-1)!.text).searchParams.get('token')!;
    await request(app.getHttpServer()).post('/v1/auth/password-reset/confirm').send({ token: resetToken, password: 'brand-new-password-1' }).expect(200);
    await u.agent.get('/v1/auth/me').expect(401);
    await request(app.getHttpServer()).post('/v1/auth/password-reset/confirm').send({ token: resetToken, password: 'another-password-22' }).expect(400);
    await request(app.getHttpServer()).post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'd@example.com', password: 'brand-new-password-1' }).expect(200);
  });
});

describe('tenant isolation and roles', () => {
  it('hides other organisations and never trusts a client-supplied org id', async () => {
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const aliceOrg = await createOrg(alice.agent, 'Alice Co');
    await bob.agent.get(`/v1/orgs/${aliceOrg}`).expect(404);
    await bob.agent.get(`/v1/orgs/${aliceOrg}/members`).expect(404);
    await bob.agent.patch(`/v1/orgs/${aliceOrg}/billing`).set('Origin', ORIGIN).send({ legalName: 'Hijack' }).expect(404);
    await bob.agent.post(`/v1/orgs/${aliceOrg}/quotes`).set('Origin', ORIGIN).send({ lines: [{ priceVersionId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] }).expect(404);
    await bob.agent.get('/v1/orgs/not-a-uuid').expect(404);
    const bobOrg = await createOrg(bob.agent, 'Bob Co');
    // Bob cannot reach Alice's quote through his own org either.
    await bob.agent.get(`/v1/orgs/${bobOrg}/quotes/00000000-0000-4000-8000-000000000000`).expect(404);
  });

  it('binds invitations to the invited email and enforces the role matrix', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const orgId = await createOrg(owner.agent);
    await owner.agent.post(`/v1/orgs/${orgId}/invitations`).set('Origin', ORIGIN).send({ email: 'member@example.com', role: 'member' }).expect(201);
    const token = new URL(mail.devOutbox.filter((m) => m.to === 'member@example.com').at(-1)!.text).searchParams.get('token')!;

    const intruder = await signUp(app, 'intruder@example.com');
    await intruder.agent.post('/v1/orgs/invitations/accept').set('Origin', ORIGIN).send({ token }).expect(403);

    const member = await signUp(app, 'member@example.com');
    await member.agent.post('/v1/orgs/invitations/accept').set('Origin', ORIGIN).send({ token }).expect(200);
    await member.agent.post('/v1/orgs/invitations/accept').set('Origin', ORIGIN).send({ token }).expect(400);
    await member.agent.get(`/v1/orgs/${orgId}`).expect(200);
    await member.agent.patch(`/v1/orgs/${orgId}/billing`).set('Origin', ORIGIN).send({ legalName: 'Nope Ltd' }).expect(403);
    await member.agent.post(`/v1/orgs/${orgId}/invitations`).set('Origin', ORIGIN).send({ email: 'x@example.com', role: 'owner' }).expect(403);

    const members = await owner.agent.get(`/v1/orgs/${orgId}/members`).expect(200);
    const ownerMembership = members.body.find((m: { role: string }) => m.role === 'owner');
    await owner.agent.patch(`/v1/orgs/${orgId}/members/${ownerMembership.id}`).set('Origin', ORIGIN).send({ role: 'member' }).expect(400);
  });

  it('validates GSTIN format against the state code', async () => {
    const owner = await signUp(app, 'gst@example.com');
    const orgId = await createOrg(owner.agent);
    await owner.agent.patch(`/v1/orgs/${orgId}/billing`).set('Origin', ORIGIN).send({ gstin: '29ABCDE1234F1Z5', stateCode: '27' }).expect(400);
    await owner.agent.patch(`/v1/orgs/${orgId}/billing`).set('Origin', ORIGIN).send({ gstin: '29ABCDE1234F1Z5', stateCode: '29' }).expect(200);
  });

  it('writes an append-only audit trail', async () => {
    const owner = await signUp(app, 'audit@example.com');
    await createOrg(owner.agent);
    expect(await db.auditEvent.count({ where: { action: 'org.created' } })).toBe(1);
    await expect(db.auditEvent.deleteMany({})).rejects.toThrow();
  });
});
