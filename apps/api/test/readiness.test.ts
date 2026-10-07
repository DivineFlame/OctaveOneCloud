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
});
