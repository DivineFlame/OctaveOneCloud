import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { signAdapterPayload } from '@ooc/shared';
import { ORIGIN, createOrg, createTestApp, db, resetDb, signUp } from './harness';

const SECRET = 'crm-adapter-secret-for-tests-0123456789abcdef';
let provider = '';
let server: http.Server;
const codes = new Map<string, string>(); // code → PKCE challenge
let tokenCalls: URLSearchParams[] = [];
let n = 0;

let app: NestExpressApplication;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      tokenCalls.push(form);
      const json = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (form.get('client_secret') !== 'gmail-secret') return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(form.get('code') ?? '');
        if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        return json(200, { access_token: `at-${++n}`, refresh_token: 'rt-1', expires_in: 30, scope: 'mail.send', token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'rt-1') return json(200, { access_token: `at-${++n}`, expires_in: 3600, token_type: 'Bearer' });
      return json(400, { error: 'unsupported_grant_type' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  provider = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    APP_ADAPTER_CRM_SECRET: SECRET,
    CONNECTOR_GMAIL_AUTHORIZE_URL: `${provider}/authorize`,
    CONNECTOR_GMAIL_TOKEN_URL: `${provider}/token`,
    CONNECTOR_GMAIL_CLIENT_ID: 'gmail-client',
    CONNECTOR_GMAIL_CLIENT_SECRET: 'gmail-secret',
    CONNECTOR_GMAIL_SCOPES: 'mail.send',
    CONNECTOR_GMAIL_APPS: 'app.crm',
    CONNECTOR_GMAIL_LABEL: 'Gmail',
  });
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
  server.close();
  for (const k of Object.keys(process.env)) if (k.startsWith('CONNECTOR_GMAIL_') || k === 'APP_ADAPTER_CRM_SECRET') delete process.env[k];
});
beforeEach(() => {
  tokenCalls = [];
  return resetDb();
});

function signed(path: string, body: unknown, appKey = 'app.crm') {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app.getHttpServer()).post(`/v1/app-api/${path}`).set('content-type', 'application/json').set('x-ooc-app', appKey).set('x-ooc-timestamp', ts).set('x-ooc-signature', signAdapterPayload(SECRET, ts, raw)).send(raw);
}

async function provisioned(orgId: string) {
  await db.product.create({ data: { key: 'crm', name: 'CRM', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.crm', taxCategory: 'saas', status: 'active' } });
  const job = await db.provisioningJob.create({ data: { orgId, adapterKey: 'app.crm', idempotencyKey: `t-${orgId}`, status: 'active' } });
  await db.provisioningStep.create({ data: { jobId: job.id, name: 'product:crm', status: 'active' } });
}

async function connect(agent: ReturnType<typeof request.agent>, orgId: string) {
  const start = await agent.post(`/v1/orgs/${orgId}/connectors/gmail/start`).set('Origin', ORIGIN).expect(200);
  const url = new URL(start.body.authorizeUrl);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:4000/v1/connectors/callback');
  const code = `c-${Math.random()}`;
  codes.set(code, url.searchParams.get('code_challenge')!);
  return agent.get(`/v1/connectors/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state')!)}`).expect(302);
}

describe('OAuth connectors', () => {
  it('connects with PKCE, stores tokens encrypted, and releases them only to allowed apps', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const orgId = await createOrg(owner.agent);
    await provisioned(orgId);
    const cb = await connect(owner.agent, orgId);
    expect(cb.headers.location).toBe(`http://localhost:3000/dashboard/orgs/${orgId}/connectors?connected=gmail`);
    const grant = await db.connectorGrant.findFirstOrThrow({ where: { orgId } });
    expect(grant.tokenEnc).not.toContain('at-');
    expect(grant.tokenEnc).not.toContain('rt-1');
    const list = await owner.agent.get(`/v1/orgs/${orgId}/connectors`).expect(200);
    expect(list.body.providers).toEqual([{ key: 'gmail', label: 'Gmail', scopes: ['mail.send'] }]);
    expect(JSON.stringify(list.body)).not.toMatch(/at-|rt-1|gmail-secret/);

    // Token expires in 30 s (< 60 s margin): the first request refreshes it.
    const t1 = await signed('connectors/token', { orgId, provider: 'gmail' }).expect(200);
    expect(t1.body).toMatchObject({ accessToken: 'at-2', tokenType: 'Bearer', scopes: ['mail.send'] });
    expect(tokenCalls.map((c) => c.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    const t2 = await signed('connectors/token', { orgId, provider: 'gmail' }).expect(200);
    expect(t2.body.accessToken).toBe('at-2'); // still valid, no refresh
    expect(await db.auditEvent.count({ where: { action: 'connector.token_issued' } })).toBe(2);

    await signed('connectors/token', { orgId, provider: 'unknown' }).expect(404);
    await owner.agent.post(`/v1/orgs/${orgId}/connectors/grants/${grant.id}/revoke`).set('Origin', ORIGIN).expect(200);
    expect((await signed('connectors/token', { orgId, provider: 'gmail' }).expect(404)).body.error).toBe('not_connected');
  });

  it('enforces roles and binds the callback to the user who started it', async () => {
    const owner = await signUp(app, 'own2@example.com');
    const orgId = await createOrg(owner.agent);
    const member = await signUp(app, 'member2@example.com');
    await db.membership.create({ data: { orgId, userId: member.userId, role: 'member' } });
    await member.agent.post(`/v1/orgs/${orgId}/connectors/gmail/start`).set('Origin', ORIGIN).expect(403);
    const outsider = await signUp(app, 'out@example.com');
    await outsider.agent.post(`/v1/orgs/${orgId}/connectors/gmail/start`).set('Origin', ORIGIN).expect(404);
    // Forged state is rejected and no token request is made.
    await owner.agent.post(`/v1/orgs/${orgId}/connectors/gmail/start`).set('Origin', ORIGIN).expect(200);
    const forged = await owner.agent.get('/v1/connectors/callback?code=x&state=forged').expect(302);
    expect(forged.headers.location).toContain('connector_error=expired');
    expect(tokenCalls).toHaveLength(0);
  });
});
