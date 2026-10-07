import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, db, resetDb, signUp } from './harness';

/** Minimal OpenID provider: discovery, JWKS and a token endpoint issuing RS256 ID tokens. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
let issuer = '';
const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown> }>();
let nextClaims: Record<string, unknown> = {};
let idp: http.Server;

function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64({ iss: issuer, aud: 'ooc-client', iat: now, exp: now + 300, ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

let app: NestExpressApplication;
beforeAll(async () => {
  idp = http.createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const entry = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!entry || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken({ nonce: entry.nonce, ...entry.claims }) });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  Object.assign(process.env, { OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: 'ooc-client', OIDC_CLIENT_SECRET: 'oidc-test-secret', OIDC_DISPLAY_NAME: 'Test IdP' });
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
  idp.close();
  for (const k of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_DISPLAY_NAME', 'OIDC_ALLOW_SIGNUP']) delete process.env[k];
});
beforeEach(resetDb);

/** Browser-like run: start → (IdP authorises) → callback with the flow cookie. */
async function signIn(claims: Record<string, unknown>, opts: { tamperState?: boolean; returnTo?: string } = {}) {
  const agent = request.agent(app.getHttpServer());
  const start = await agent.get(`/v1/auth/oidc/start${opts.returnTo ? `?returnTo=${encodeURIComponent(opts.returnTo)}` : ''}`).expect(302);
  const auth = new URL(start.headers.location as string);
  expect(auth.origin + auth.pathname).toBe(`${issuer}/authorize`);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const code = `code-${Math.random()}`;
  codes.set(code, { nonce: auth.searchParams.get('nonce')!, challenge: auth.searchParams.get('code_challenge')!, claims: { ...nextClaims, ...claims } });
  const state = opts.tamperState ? 'forged-state' : auth.searchParams.get('state')!;
  const cb = await agent.get(`/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`).expect(302);
  return { agent, location: cb.headers.location as string };
}

describe('OIDC sign-in', () => {
  it('advertises the provider and links an existing account by verified email', async () => {
    expect((await request(app.getHttpServer()).get('/v1/auth/oidc/config').expect(200)).body).toEqual({ enabled: true, name: 'Test IdP' });
    await signUp(app, 'staff@example.com');
    const r = await signIn({ sub: 'u-1', email: 'Staff@Example.com', email_verified: true }, { returnTo: '/dashboard/orgs' });
    expect(r.location).toBe('http://localhost:3000/dashboard/orgs');
    expect((await r.agent.get('/v1/auth/me').expect(200)).body.email).toBe('staff@example.com');
    expect(await db.userIdentity.count({ where: { subject: 'u-1' } })).toBe(1);
    // Later sign-ins use the identity link even if the email claim changes.
    const again = await signIn({ sub: 'u-1', email: 'renamed@example.com', email_verified: true });
    expect((await again.agent.get('/v1/auth/me').expect(200)).body.email).toBe('staff@example.com');
  });

  it('refuses unverified emails, unknown accounts (without sign-up), forged state and open redirects', async () => {
    await signUp(app, 'victim@example.com');
    expect((await signIn({ sub: 'attacker', email: 'victim@example.com', email_verified: false })).location).toContain('sso_error=oidc_email_not_verified');
    expect((await signIn({ sub: 'new', email: 'new@example.com', email_verified: true })).location).toContain('sso_error=oidc_no_account');
    expect((await signIn({ sub: 'x', email: 'victim@example.com', email_verified: true }, { tamperState: true })).location).toContain('sso_error=oidc_failed');
    const r = await signIn({ sub: 'v', email: 'victim@example.com', email_verified: true }, { returnTo: '//evil.example.com/x' });
    expect(r.location).toBe('http://localhost:3000/dashboard');
    // The flow cookie is single use: replaying the callback fails.
    const replay = await r.agent.get('/v1/auth/oidc/callback?code=whatever&state=whatever').expect(302);
    expect(replay.headers.location).toContain('sso_error=expired');
  });
});
