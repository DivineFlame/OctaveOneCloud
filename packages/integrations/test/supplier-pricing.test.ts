import { beforeEach, describe, expect, it } from 'vitest';
import { ResellerClubClient } from '../src/resellerclub/client';
import { COST_SOURCE_PREFIX, costDrift, currentSupplierCost, parseSupplierPrices, priceSyncDue, priceToMinor, syncResellerClubPrices } from '../src/resellerclub/pricing';
import { db, makeProduct, reset } from './fixtures';

const rcConfig = { RESELLERCLUB_ENV: 'demo' as const, RESELLERCLUB_BASE_URL: 'https://test.httpapi.com/api', RESELLERCLUB_AUTH_USERID: '12345', RESELLERCLUB_API_KEY: 'sekrit-key', RESELLERCLUB_ALLOW_LIVE_MUTATIONS: false };

/** Shapes copied from the ResellerClub help articles (cost price and customer price), with sample amounts. */
const COST_SAMPLE = {
  dotin: { addnewdomain: { '1': '649.0', '2': '1298.0' }, renewdomain: { '1': '699.0' }, addtransferdomain: { '1': '649.0' }, restoredomain: { '1': '5000.0' } },
  hosting: {
    email_plan: { '1': { pricing: { renew: 49.5, add: 49.5 }, description: { no_of_mail_accounts: 5, default: false } } },
  },
  singledomainhostinglinuxin: {
    singledomainhostinglinuxin: { '1': { pricing: { renew: 99.0, ssl: 0.0, add: 99.0 }, description: { no_of_mail_accounts: -1, default: true, bandwidth: -1, webspace: -1 } } },
  },
  multidomainhostinglinuxin: { '1': { renew: { '3': 450.0, '12': 1500.0 }, ssl: 0.0, add: { '3': 450.0, '12': 1500.0 } } },
  vpslinuxus: { addons: { ssl: 0.0, cpanel: 1200.0, whmcs: 0.0 }, plans: { '1': { renew: { '1': 899.0 }, add: { '1': 899.0 } } } },
  enterpriseemailin: { email_account_ranges: { '1-5': { renew: { '3': 100.0, '12': 360.0 }, add: { '3': 100.0, '12': 360.0 } } } },
  thawtecert: { ssl: { renew: { '1': '100.0', '2': '200.0' }, add: { '1': '100.0' }, additionallicense: { '1': '100.0' } } },
};

function client(body: () => unknown) {
  const calls: string[] = [];
  const f = (async (url: URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { c: new ResellerClubClient(rcConfig, db, f), calls };
}

describe('ResellerClub price parsing', () => {
  it('converts amounts exactly (strings and numbers, half up)', () => {
    expect(priceToMinor('649.0')).toBe(64900);
    expect(priceToMinor(49.5)).toBe(4950);
    expect(priceToMinor('12.345')).toBe(1235);
    expect(priceToMinor('abc')).toBeNull();
    expect(priceToMinor('-1')).toBeNull();
  });

  it('labels every documented shape and skips plan descriptions', () => {
    const { prices, skipped } = parseSupplierPrices(COST_SAMPLE);
    const by = (ref: string) => prices.find((p) => p.ref === ref);
    expect(by('dotin/addnewdomain/2')).toMatchObject({ productKey: 'dotin', category: 'domain', action: 'addnewdomain', term: 2, termUnit: 'years', amountMinor: 129800 });
    expect(by('hosting/email_plan/1/pricing/add')).toMatchObject({ productKey: 'email_plan', category: 'hosting', plan: '1', action: 'add', amountMinor: 4950 });
    expect(by('singledomainhostinglinuxin/singledomainhostinglinuxin/1/pricing/ssl')).toMatchObject({ category: 'addon', action: 'ssl' });
    expect(by('multidomainhostinglinuxin/1/add/12')).toMatchObject({ category: 'hosting', plan: '1', action: 'add', term: 12, termUnit: 'months', amountMinor: 150000 });
    expect(by('multidomainhostinglinuxin/1/ssl')).toMatchObject({ category: 'addon', action: 'ssl' });
    expect(by('vpslinuxus/addons/cpanel')).toMatchObject({ category: 'addon', plan: 'cpanel', amountMinor: 120000 });
    expect(by('vpslinuxus/plans/1/renew/1')).toMatchObject({ category: 'server', plan: '1', action: 'renew', term: 1, termUnit: 'months' });
    expect(by('enterpriseemailin/email_account_ranges/1-5/add/12')).toMatchObject({ category: 'email', plan: '1-5', term: 12, amountMinor: 36000 });
    expect(by('thawtecert/ssl/renew/2')).toMatchObject({ category: 'certificate', plan: 'ssl', action: 'renew', term: 2, termUnit: 'years' });
    expect(prices.some((p) => p.ref.includes('description'))).toBe(false);
    expect(skipped).toBe(0);
    expect(parseSupplierPrices({ newfamily: { x: { y: '10' } } }).prices[0]).toMatchObject({ category: 'other', amountMinor: 1000 });
  });
});

describe('ResellerClub price sync', () => {
  beforeEach(reset);

  it('calls the documented read-only endpoints with authentication', async () => {
    const cost = client(() => COST_SAMPLE);
    await syncResellerClubPrices(db, cost.c, 'cost', { currency: 'INR' });
    const u = new URL(cost.calls[0]!);
    expect(u.origin + u.pathname).toBe('https://test.httpapi.com/api/products/reseller-cost-price.json');
    expect(u.searchParams.get('auth-userid')).toBe('12345');
    const cust = client(() => ({ dotin: { addnewdomain: { '1': '899.0' } } }));
    await syncResellerClubPrices(db, cust.c, 'customer', { currency: 'INR' });
    expect(new URL(cust.calls[0]!).pathname).toBe('/api/products/customer-price.json');
    expect(await db.supplierOperation.count()).toBe(0); // reads are not journaled as mutations
  });

  it('stores snapshots, skips identical re-fetches, counts changes and keeps 10', async () => {
    let body: Record<string, unknown> = structuredClone(COST_SAMPLE);
    const { c } = client(() => body);
    const first = await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    expect(first).toMatchObject({ unchanged: false, changedCount: null });
    expect(first.itemCount).toBeGreaterThan(20);
    const again = await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    expect(again).toMatchObject({ unchanged: true, snapshotId: first.snapshotId });
    body = { ...body, dotin: { ...(body.dotin as object), renewdomain: { '1': '749.0' } } };
    const changed = await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    expect(changed).toMatchObject({ unchanged: false, changedCount: 1 });
    expect(await currentSupplierCost(db, 'dotin/renewdomain/1', 'demo')).toMatchObject({ amountMinor: 74900, currency: 'INR' });
    expect(await currentSupplierCost(db, 'dotin/renewdomain/1', 'live')).toBeNull(); // demo prices never feed a live catalogue
    for (let i = 0; i < 12; i++) {
      body = { ...body, dotin: { ...(body.dotin as object), restoredomain: { '1': `${5000 + i}.0` } } };
      await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    }
    expect(await db.supplierPriceSnapshot.count({ where: { kind: 'cost' } })).toBe(10);
  });

  it('flags prices on sale whose ResellerClub cost changed, with the new margin', async () => {
    let body: Record<string, unknown> = structuredClone(COST_SAMPLE);
    const { c } = client(() => body);
    await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    const { price } = await makeProduct({ key: 'dom-in', fulfillment: 'resellerclub', amountMinor: 99900 });
    const target = await db.priceVersion.create({ data: { planVersionId: price.planVersionId, kind: 'renewal', billingInterval: 'P1Y', amountMinor: 99900n, costMinor: 69900n, costSource: `${COST_SOURCE_PREFIX}dotin/renewdomain/1` } });
    expect(await costDrift(db, 'demo')).toEqual([]);
    body = { ...body, dotin: { ...(body.dotin as object), renewdomain: { '1': '849.0' } } };
    const r = await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    expect(r.affectedPrices).toEqual([expect.objectContaining({ priceVersionId: target.id, recordedCostMinor: 69900, currentCostMinor: 84900, sellingMinor: 99900, marginBps: 1502 })]);
  });

  it('is due when never synced or older than the interval; 0 disables it', async () => {
    expect(await priceSyncDue(db, 'demo', 24)).toEqual(['cost', 'customer']);
    const { c } = client(() => COST_SAMPLE);
    await syncResellerClubPrices(db, c, 'cost', { currency: 'INR' });
    expect(await priceSyncDue(db, 'demo', 24)).toEqual(['customer']);
    expect(await priceSyncDue(db, 'demo', 24, new Date(Date.now() + 25 * 3600_000))).toEqual(['cost', 'customer']);
    expect(await priceSyncDue(db, 'demo', 0)).toEqual([]);
  });
});
