import { describe, expect, it } from 'vitest';
import { computeCashfreeSignature, verifyCashfreeSignature } from '../src/webhook-signature';
import { mergeEntitlements } from '../src/entitlements';
import { orderMachine, provisioningMachine } from '../src/state-machines';
import { redact, redactUrl, REDACTED } from '../src/redact';
import { loadConfig } from '../src/config';
import { canAssignRole, roleHasPermission } from '../src/roles';

describe('cashfree signature', () => {
  const body = Buffer.from('{"data":{"order":{"order_id":"o1"}},"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  it('verifies against raw bytes and rejects tampering', () => {
    const sig = computeCashfreeSignature(body, '1727000000000', 'secret');
    expect(verifyCashfreeSignature({ rawBody: body, timestamp: '1727000000000', signature: sig, secret: 'secret' })).toBe(true);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyCashfreeSignature({ rawBody: reformatted, timestamp: '1727000000000', signature: sig, secret: 'secret' })).toBe(false);
    expect(verifyCashfreeSignature({ rawBody: body, timestamp: '1727000000001', signature: sig, secret: 'secret' })).toBe(false);
    expect(verifyCashfreeSignature({ rawBody: body, timestamp: '1727000000000', signature: sig, secret: 'other' })).toBe(false);
    expect(verifyCashfreeSignature({ rawBody: body, timestamp: undefined, signature: sig, secret: 'secret' })).toBe(false);
  });
});

describe('entitlements', () => {
  it('does not double-grant overlapping bundle quotas', () => {
    const m = mergeEntitlements([
      { featureKey: 'crm.seats', sourceId: 'sales-desk', mergePolicy: 'max', limit: 5 },
      { featureKey: 'crm.seats', sourceId: 'ops-bundle', mergePolicy: 'max', limit: 3 },
      { featureKey: 'ai.credits', sourceId: 'pack-1', mergePolicy: 'additive', limit: 1000 },
      { featureKey: 'ai.credits', sourceId: 'pack-2', mergePolicy: 'additive', limit: 500 },
    ]);
    expect(m.get('crm.seats')?.limit).toBe(5);
    expect(m.get('ai.credits')?.limit).toBe(1500);
  });
});

describe('state machines', () => {
  it('never moves a paid order back to awaiting payment', () => {
    expect(orderMachine.canTransition('paid', 'awaiting_payment')).toBe(false);
    expect(() => orderMachine.assertTransition('active', 'cancelled')).toThrow();
  });
  it('requires reconciliation path from unknown outcome', () => {
    expect(provisioningMachine.canTransition('running', 'unknown_outcome')).toBe(true);
    expect(provisioningMachine.canTransition('unknown_outcome', 'running')).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts supplier credentials in URLs and objects', () => {
    const url = redactUrl('https://test.httpapi.com/api/domains/available.json?auth-userid=123&api-key=abc&domain-name=x');
    expect(url).not.toContain('abc');
    expect(url).toContain('domain-name=x');
    expect(redact({ headers: { 'x-client-secret': 's' }, ok: 1 })).toEqual({ headers: { 'x-client-secret': REDACTED }, ok: 1 });
  });
});

describe('config', () => {
  const base = { APP_URL: 'http://localhost:3000', API_URL: 'http://localhost:4000', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64) };
  it('accepts a minimal disabled-integrations config', () => {
    expect(loadConfig(base).RESELLERCLUB_ENV).toBe('disabled');
  });
  it('rejects live mutation switch outside live env and missing credentials', () => {
    expect(() => loadConfig({ ...base, RESELLERCLUB_ENV: 'demo', RESELLERCLUB_ALLOW_LIVE_MUTATIONS: 'true' })).toThrow(/ALLOW_LIVE/);
    expect(() => loadConfig({ ...base, CASHFREE_ENV: 'sandbox' })).toThrow(/CASHFREE_CLIENT_ID/);
  });
  it('requires SMTP in production and MAIL_FROM with SMTP', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_URL: 'https://x.test', API_URL: 'https://x.test/api', COOKIE_SECURE: 'true' };
    expect(() => loadConfig(prod)).toThrow(/SMTP_URL is required/);
    expect(() => loadConfig({ ...prod, SMTP_URL: 'smtps://u:p@mail.test:465' })).toThrow(/MAIL_FROM/);
    expect(loadConfig({ ...prod, SMTP_URL: 'smtps://u:p@mail.test:465', MAIL_FROM: 'OctaveOneCloud <no-reply@x.test>' }).NODE_ENV).toBe('production');
  });
  it('separates provider sandboxes from production by APP_ENV', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_URL: 'https://x.test', API_URL: 'https://x.test/api', COOKIE_SECURE: 'true', SMTP_URL: 'smtp://m.test:25', MAIL_FROM: 'a@x.test', CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's', CASHFREE_WEBHOOK_SECRET: 'w' };
    expect(() => loadConfig({ ...prod, CASHFREE_ENV: 'sandbox' })).toThrow(/APP_ENV=staging/);
    expect(loadConfig({ ...prod, CASHFREE_ENV: 'sandbox', APP_ENV: 'staging' }).CASHFREE_ENV).toBe('sandbox');
    expect(() => loadConfig({ ...prod, CASHFREE_ENV: 'production', APP_ENV: 'staging' })).toThrow(/only allowed when APP_ENV=production/);
    expect(() => loadConfig({ ...base, CASHFREE_ENV: 'production', CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's', CASHFREE_WEBHOOK_SECRET: 'w' })).toThrow(/APP_ENV=production/);
  });
  it('allows an explicit IP:port HTTP trial but never with live money or supplier actions', () => {
    const ipProd = { ...base, NODE_ENV: 'production', APP_URL: 'http://203.0.113.10:8585', API_URL: 'http://203.0.113.10:8585/api', SMTP_URL: 'smtp://m.test:25', MAIL_FROM: 'a@x.test' };
    expect(() => loadConfig(ipProd)).toThrow(/OOC_ALLOW_INSECURE_HTTP/);
    expect(loadConfig({ ...ipProd, OOC_ALLOW_INSECURE_HTTP: 'true' }).APP_URL).toBe('http://203.0.113.10:8585');
    expect(() => loadConfig({ ...ipProd, OOC_ALLOW_INSECURE_HTTP: 'true', COOKIE_SECURE: 'true' })).toThrow(/COOKIE_SECURE must be false/);
    expect(() => loadConfig({ ...ipProd, OOC_ALLOW_INSECURE_HTTP: 'true', CASHFREE_ENV: 'production', CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's', CASHFREE_WEBHOOK_SECRET: 'w' })).toThrow(/cannot be used with CASHFREE_ENV=production/);
  });
  it('only allows insecure production config on localhost', () => {
    const prod = { ...base, NODE_ENV: 'production', SMTP_URL: 'smtp://mail.test:25', MAIL_FROM: 'a@b.test' };
    expect(loadConfig({ ...prod, OOC_ALLOW_INSECURE_LOCAL: 'true' }).APP_URL).toBe('http://localhost:3000');
    expect(() => loadConfig({ ...prod, APP_URL: 'http://shop.example.com', OOC_ALLOW_INSECURE_LOCAL: 'true' })).toThrow(/only permitted/);
  });
  it('never echoes secret values in errors', () => {
    try { loadConfig({ ...base, CREDENTIAL_ENCRYPTION_KEY: 'supersecretvalue' }); } catch (e) { expect(String(e)).not.toContain('supersecretvalue'); }
  });
});

describe('roles', () => {
  it('enforces the role matrix', () => {
    expect(roleHasPermission('member', 'billing.manage')).toBe(false);
    expect(roleHasPermission('billing', 'billing.manage')).toBe(true);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });
});
