import { beforeEach, describe, expect, it } from 'vitest';
import { CashfreeClient, PaymentProviderError } from '../src/cashfree/client';
import { ResellerClubClient, SupplierError } from '../src/resellerclub/client';
import { db, reset } from './fixtures';

type Call = { url: string; init: RequestInit };
function mockFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rcConfig = { RESELLERCLUB_ENV: 'demo' as const, RESELLERCLUB_BASE_URL: 'https://test.httpapi.com/api', RESELLERCLUB_AUTH_USERID: '12345', RESELLERCLUB_API_KEY: 'sekrit-key', RESELLERCLUB_ALLOW_LIVE_MUTATIONS: false };

describe('ResellerClub client', () => {
  beforeEach(reset);

  it('encodes repeated params, authenticates, and treats HTTP 200 error bodies as failures', async () => {
    const { f, calls } = mockFetch(() => json({ status: 'ERROR', message: 'Invalid domain name' }));
    const c = new ResellerClubClient(rcConfig, db, f);
    await expect(c.checkDomainAvailability(['acme'], ['com', 'in'])).rejects.toMatchObject({ kind: 'validation' });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.getAll('tlds')).toEqual(['com', 'in']);
    expect(u.searchParams.get('auth-userid')).toBe('12345');
  });

  it('journals mutations, marks timeouts unknown and blocks blind retries; never stores credentials', async () => {
    const { f } = mockFetch(() => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    const c = new ResellerClubClient(rcConfig, db, f);
    const opts = { operationKey: 'domain-register:item-1', action: 'domain.register', chargeable: true };
    await expect(c.mutate('/domains/register.json', { 'domain-name': 'acme.in' }, opts)).rejects.toMatchObject({ kind: 'unknown_outcome' });
    await expect(c.mutate('/domains/register.json', { 'domain-name': 'acme.in' }, opts)).rejects.toMatchObject({ kind: 'reconcile_required' });
    const op = await db.supplierOperation.findUniqueOrThrow({ where: { operationKey: opts.operationKey } });
    expect(op.status).toBe('unknown');
    expect(JSON.stringify(op)).not.toContain('sekrit-key');
  });

  it('classifies insufficient supplier funds', async () => {
    const { f } = mockFetch(() => json({ status: 'ERROR', message: 'Insufficient balance in reseller account' }));
    const c = new ResellerClubClient(rcConfig, db, f);
    await expect(c.mutate('/domains/renew.json', {}, { operationKey: 'renew-1', action: 'domain.renew', chargeable: true })).rejects.toMatchObject({ kind: 'insufficient_funds' });
  });

  it('blocks live mutations unless explicitly authorised', async () => {
    const { f, calls } = mockFetch(() => json({ ok: true }));
    const c = new ResellerClubClient({ ...rcConfig, RESELLERCLUB_ENV: 'live', RESELLERCLUB_BASE_URL: 'https://httpapi.com/api' }, db, f);
    await expect(c.mutate('/domains/register.json', {}, { operationKey: 'x', action: 'domain.register', chargeable: true })).rejects.toBeInstanceOf(SupplierError);
    expect(calls).toHaveLength(0);
  });
});

describe('Cashfree client', () => {
  it('sends documented headers, converts amounts exactly, and rejects mismatched responses', async () => {
    const { f, calls } = mockFetch(() => json({ order_id: 'ooc-1', cf_order_id: 99, order_amount: 1180.5, order_currency: 'INR', order_status: 'ACTIVE', payment_session_id: 'sess' }));
    const c = new CashfreeClient('https://sandbox.cashfree.com/pg', { clientId: 'id', clientSecret: 'secret', apiVersion: '2025-01-01' }, f);
    const o = await c.createOrder({ orderId: 'ooc-1', amountMinor: 118050, currency: 'INR', customer: { id: 'c1', email: 'a@b.co', phone: '9999999999' }, returnUrl: 'https://x/y' });
    expect(o.paymentSessionId).toBe('sess');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-version']).toBe('2025-01-01');
    expect(JSON.parse(String(calls[0]!.init.body)).order_amount).toBe(1180.5);

    const bad = new CashfreeClient('https://sandbox.cashfree.com/pg', { clientId: 'id', clientSecret: 'secret', apiVersion: '2025-01-01' }, mockFetch(() => json({ order_id: 'ooc-1', order_amount: 1, order_currency: 'INR', order_status: 'ACTIVE' })).f);
    await expect(bad.createOrder({ orderId: 'ooc-1', amountMinor: 118050, currency: 'INR', customer: { id: 'c1', email: 'a@b.co', phone: '9999999999' }, returnUrl: 'https://x/y' })).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('reports 5xx and network failures as unknown outcomes', async () => {
    const c = new CashfreeClient('https://sandbox.cashfree.com/pg', { clientId: 'id', clientSecret: 's', apiVersion: 'v' }, mockFetch(() => json({ message: 'oops' }, 502)).f);
    await expect(c.getOrder('x')).rejects.toMatchObject({ kind: 'unknown_outcome' });
  });
});
