import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ResellerClubClient, syncResellerClubPrices } from '@ooc/integrations';
import { ORIGIN, createTestApp, db, makeOperator, resetDb, sellableProduct, signUp } from './harness';

const RC = { RESELLERCLUB_ENV: 'demo', RESELLERCLUB_BASE_URL: 'https://test.httpapi.com/api', RESELLERCLUB_AUTH_USERID: '1', RESELLERCLUB_API_KEY: 'demo-key' };
let app: NestExpressApplication;
beforeAll(async () => {
  Object.assign(process.env, RC);
  ({ app } = (await createTestApp()) as { app: NestExpressApplication });
});
afterAll(async () => {
  await app.close();
  for (const k of Object.keys(RC)) delete process.env[k];
});
beforeEach(resetDb);

/** Stores a snapshot the way the worker does, from a canned ResellerClub response. */
async function snapshot(kind: 'cost' | 'customer', body: unknown, env: 'demo' | 'live' = 'demo') {
  const client = new ResellerClubClient(
    { RESELLERCLUB_ENV: env, RESELLERCLUB_BASE_URL: 'https://test.httpapi.com/api', RESELLERCLUB_AUTH_USERID: '1', RESELLERCLUB_API_KEY: 'k', RESELLERCLUB_ALLOW_LIVE_MUTATIONS: false },
    db,
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
  );
  return syncResellerClubPrices(db, client, kind, { currency: 'INR' });
}

describe('supplier price lists', () => {
  it('shows cost and selling prices side by side and queues syncs', async () => {
    await snapshot('cost', { dotin: { addnewdomain: { '1': '649.0' }, renewdomain: { '1': '699.0' } }, vpslinuxus: { addons: { cpanel: 1200.0 } } });
    await snapshot('customer', { dotin: { addnewdomain: { '1': '899.0' }, renewdomain: { '1': '999.0' } } });
    await snapshot('cost', { dotin: { addnewdomain: { '1': '1.0' } } }, 'live'); // other environment: ignored

    const finance = await makeOperator(app, 'fin@example.com', 'operator_finance');
    const status = await finance.agent.get('/v1/admin/supplier-prices/status').expect(200);
    expect(status.body).toMatchObject({ enabled: true, environment: 'demo', currency: 'INR', cost: { itemCount: 3, environment: 'demo' }, customer: { itemCount: 2 }, costChangesOnSale: [] });

    const list = await finance.agent.get('/v1/admin/supplier-prices?q=dotin').expect(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ ref: 'dotin/addnewdomain/1', category: 'domain', term: 1, termUnit: 'years', costMinor: 64900, sellingMinor: 89900, marginBps: 2781 }),
      expect.objectContaining({ ref: 'dotin/renewdomain/1', costMinor: 69900, sellingMinor: 99900 }),
    ]);
    expect((await finance.agent.get('/v1/admin/supplier-prices?category=addon').expect(200)).body.items[0]).toMatchObject({ productKey: 'vpslinuxus', plan: 'cpanel', sellingMinor: null });

    const q = await finance.agent.post('/v1/admin/supplier-prices/sync').set('Origin', ORIGIN).send({ kind: 'cost' }).expect(202);
    expect(q.body).toEqual({ queued: ['cost'], enabled: true });
    expect(await db.auditEvent.count({ where: { action: 'supplier.prices_sync_requested' } })).toBe(1);

    const customer = await signUp(app, 'cust@example.com');
    await customer.agent.get('/v1/admin/supplier-prices/status').expect(403);
  });

  it('records the supplier cost on a catalogue price and reports cost changes with margin', async () => {
    await snapshot('cost', { dotin: { renewdomain: { '1': '699.0' } } });
    const admin = await makeOperator(app, 'adm@example.com', 'operator_admin');
    const { version } = await sellableProduct();
    const draft = await admin.agent.post(`/v1/admin/catalogue/plans/${version.planId}/versions`).set('Origin', ORIGIN).send({}).expect(201);
    const p = await admin.agent.post(`/v1/admin/catalogue/plan-versions/${draft.body.id}/prices`).set('Origin', ORIGIN)
      .send({ kind: 'renewal', currency: 'INR', billingInterval: 'P1Y', amountMinor: 99900, supplierCostRef: 'dotin/renewdomain/1' }).expect(201);
    expect(p.body.costSource).toBe('resellerclub:cost:dotin/renewdomain/1');
    expect(String(p.body.costMinor)).toBe('69900');
    const missing = await admin.agent.post(`/v1/admin/catalogue/plan-versions/${draft.body.id}/prices`).set('Origin', ORIGIN)
      .send({ kind: 'renewal', currency: 'INR', billingInterval: 'P2Y', amountMinor: 1, supplierCostRef: 'dotxyz/renewdomain/2' }).expect(400);
    expect(missing.body.error).toBe('supplier_cost_not_found');

    await db.planVersion.update({ where: { id: draft.body.id }, data: { publishedAt: new Date() } });
    const changed = await snapshot('cost', { dotin: { renewdomain: { '1': '849.0' } } });
    expect(changed.affectedPrices).toHaveLength(1);
    const status = await admin.agent.get('/v1/admin/supplier-prices/status').expect(200);
    expect(status.body.costChangesOnSale).toEqual([expect.objectContaining({ ref: 'dotin/renewdomain/1', recordedCostMinor: 69900, currentCostMinor: 84900, sellingMinor: 99900, marginBps: 1502 })]);
  });
});
