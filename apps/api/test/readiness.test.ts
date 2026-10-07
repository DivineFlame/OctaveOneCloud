import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, makeOperator, resetDb } from './harness';

let app: NestExpressApplication;
beforeAll(async () => {
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

describe('launch readiness', () => {
  it('reports failing production checks and manual gates without secrets, to operator admins only', async () => {
    const admin = await makeOperator(app, 'admin@example.com');
    const r = await admin.agent.get('/v1/admin/readiness').expect(200);
    expect(r.body.automatedChecksPass).toBe(false);
    const byId = Object.fromEntries(r.body.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(byId['payments.cashfree_env']).toBe('fail'); // sandbox in tests
    expect(byId['config.https']).toBe('fail');
    expect(byId['security.operator_mfa']).toBe('pass');
    expect(byId['tax.seller']).toBe('pass');
    expect(byId['operations.migrations']).toBe('pass');
    expect(byId['gate.accountant']).toBe('manual');
    expect(JSON.stringify(r.body)).not.toMatch(/whsec|secret-value|client_secret/i);

    const finance = await makeOperator(app, 'finance@example.com', 'operator_finance');
    await finance.agent.get('/v1/admin/readiness').expect(403);
  });

  it('activates an adapter only when its URL and secret are configured', async () => {
    const admin = await makeOperator(app, 'adm@example.com');
    const missing = await admin.agent.post('/v1/admin/adapters/app.billing/status').set('Origin', 'http://localhost:3000').send({ status: 'sandbox', note: 'testing billing app' }).expect(400);
    expect(missing.body.error).toBe('adapter_not_configured');
    process.env.APP_ADAPTER_BILLING_URL = 'http://billing.internal/ooc';
    process.env.APP_ADAPTER_BILLING_SECRET = 'x'.repeat(40);
    try {
      const r = await admin.agent.post('/v1/admin/adapters/app.billing/status').set('Origin', 'http://localhost:3000').send({ status: 'sandbox', note: 'contract tests passed', name: 'Billing app' }).expect(201);
      expect(r.body).toMatchObject({ key: 'app.billing', status: 'sandbox', baseUrl: 'http://billing.internal/ooc', authRef: 'APP_ADAPTER_BILLING_SECRET' });
      expect(JSON.stringify(r.body)).not.toContain('x'.repeat(40));
      await admin.agent.post('/v1/admin/adapters/BAD/status').set('Origin', 'http://localhost:3000').send({ status: 'sandbox', note: 'bad key' }).expect(400);
      const finance = await makeOperator(app, 'fin2@example.com', 'operator_finance');
      await finance.agent.post('/v1/admin/adapters/app.billing/status').set('Origin', 'http://localhost:3000').send({ status: 'active', note: 'nope' }).expect(403);
    } finally {
      delete process.env.APP_ADAPTER_BILLING_URL;
      delete process.env.APP_ADAPTER_BILLING_SECRET;
    }
  });
});
