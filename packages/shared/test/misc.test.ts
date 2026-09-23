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
