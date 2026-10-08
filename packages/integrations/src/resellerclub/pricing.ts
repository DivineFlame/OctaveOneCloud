import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import type { ResellerClubClient } from './client';

/**
 * ResellerClub price lists.
 *
 *   cost      GET /products/reseller-cost-price.json   what ResellerClub charges this reseller account
 *   customer  GET /products/customer-price.json        this reseller's generic selling prices (set in the panel)
 *
 * Both return a large nested hash map whose shape differs by product family (documented in the ResellerClub help
 * articles "Get Reseller Cost Pricing Details Using the API" and "How to Fetch Customer Pricing Using the Products
 * Pricing API"). Every numeric leaf is kept as a price point keyed by its path (`ref`); known shapes are labelled
 * (domain / hosting / server / email / certificate / addon) and anything unrecognised is kept as `other`, so a new
 * product family never breaks a sync. Prices are only stored and compared here: nothing changes selling prices.
 */

export type SupplierPriceKind = 'cost' | 'customer';

export interface ParsedSupplierPrice {
  ref: string;
  productKey: string;
  category: 'domain' | 'hosting' | 'server' | 'email' | 'certificate' | 'addon' | 'other';
  plan: string | null;
  action: string | null;
  term: number | null;
  termUnit: 'years' | 'months' | null;
  amountMinor: number;
}

const DOMAIN_ACTIONS = new Set(['addnewdomain', 'renewdomain', 'addtransferdomain', 'restoredomain']);
const TERM = /^\d{1,3}$/;

/** "1234.565" → 123457 (half up, exact string arithmetic). Returns null for non-numeric or negative values. */
export function priceToMinor(v: unknown): number | null {
  const text = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(6) : '') : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? '').padEnd(3, '0');
  let minor = whole * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) minor += 1n;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function classify(path: string[]): Omit<ParsedSupplierPrice, 'ref' | 'amountMinor'> {
  const p = path;
  const last = p[p.length - 1]!;
  // Cost-price "pricing" bands: hosting/<productkey>/<band>/pricing/<action>  or  <key>/<key>/<band>/pricing/<action>
  const pi = p.indexOf('pricing');
  if (pi >= 2) {
    const productKey = p[0] === 'hosting' ? p[1]! : p[0]!;
    const isAddon = last === 'ssl';
    return { productKey, category: isAddon ? 'addon' : 'hosting', plan: p[pi - 1]!, action: isAddon ? 'ssl' : last, term: null, termUnit: null };
  }
  const productKey = p[0]!;
  if (p.length === 3 && DOMAIN_ACTIONS.has(p[1]!) && TERM.test(p[2]!)) {
    return { productKey, category: 'domain', plan: null, action: p[1]!, term: Number(p[2]), termUnit: 'years' };
  }
  if (p[1] === 'addons' && p.length === 3) return { productKey, category: 'addon', plan: p[2]!, action: null, term: null, termUnit: null };
  if (p[1] === 'plans' && p.length === 5 && TERM.test(p[4]!)) {
    return { productKey, category: 'server', plan: p[2]!, action: p[3]!, term: Number(p[4]), termUnit: 'months' };
  }
  if (p[1] === 'email_account_ranges' && p.length === 5 && TERM.test(p[4]!)) {
    return { productKey, category: 'email', plan: p[2]!, action: p[3]!, term: Number(p[4]), termUnit: 'months' };
  }
  if (/cert/i.test(productKey) && p.length === 4 && TERM.test(p[3]!)) {
    return { productKey, category: 'certificate', plan: p[1]!, action: p[2]!, term: Number(p[3]), termUnit: 'years' };
  }
  if (p.length === 4 && TERM.test(p[3]!) && (p[2] === 'add' || p[2] === 'renew')) {
    return { productKey, category: 'hosting', plan: p[1]!, action: p[2]!, term: Number(p[3]), termUnit: 'months' };
  }
  if (p.length === 3 && last === 'ssl') return { productKey, category: 'addon', plan: p[1]!, action: 'ssl', term: null, termUnit: null };
  return { productKey, category: 'other', plan: null, action: null, term: null, termUnit: null };
}

/** Flattens a pricing response. `description` objects (plan specs, not prices) are skipped. */
export function parseSupplierPrices(body: unknown): { prices: ParsedSupplierPrice[]; skipped: number } {
  const prices: ParsedSupplierPrice[] = [];
  let skipped = 0;
  const walk = (node: unknown, path: string[]) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'description') continue;
        walk(v, [...path, k]);
      }
      return;
    }
    if (path.length < 2) return;
    if (typeof node === 'boolean' || node === null || Array.isArray(node)) return;
    const amountMinor = priceToMinor(node);
    if (amountMinor === null) {
      skipped++;
      return;
    }
    prices.push({ ref: path.join('/'), amountMinor, ...classify(path) });
  };
  if (!body || typeof body !== 'object') throw new Error('Pricing response is not a JSON object');
  walk(body, []);
  prices.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { prices, skipped };
}

function contentHash(prices: ParsedSupplierPrice[]) {
  const h = createHash('sha256');
  for (const p of prices) h.update(`${p.ref}=${p.amountMinor}\n`);
  return h.digest('hex');
}

const KEEP_SNAPSHOTS = 10;

export interface PriceSyncResult {
  kind: SupplierPriceKind;
  snapshotId: string;
  unchanged: boolean;
  itemCount: number;
  skippedCount: number;
  changedCount: number | null;
  /** Prices on sale whose recorded supplier cost no longer matches (cost syncs only). */
  affectedPrices: CostDrift[];
}

export interface CostDrift {
  priceVersionId: string;
  product: string;
  plan: string;
  ref: string;
  recordedCostMinor: number;
  currentCostMinor: number | null;
  sellingMinor: number;
  marginBps: number | null;
}

/** Fetches one price list and stores it as a snapshot (or confirms the previous one when nothing changed). */
export async function syncResellerClubPrices(db: PrismaClient, client: ResellerClubClient, kind: SupplierPriceKind, opts: { currency: string; actorId?: string; now?: Date }): Promise<PriceSyncResult> {
  const now = opts.now ?? new Date();
  const body = kind === 'cost' ? await client.resellerCostPrice() : await client.customerPrice();
  const { prices, skipped } = parseSupplierPrices(body);
  if (prices.length === 0) throw new Error(`ResellerClub returned no ${kind} prices`);
  const hash = contentHash(prices);
  const environment = client.environment;
  const previous = await db.supplierPriceSnapshot.findFirst({ where: { provider: 'resellerclub', kind, environment }, orderBy: { fetchedAt: 'desc' } });

  if (previous && previous.contentHash === hash && previous.currency === opts.currency) {
    await db.supplierPriceSnapshot.update({ where: { id: previous.id }, data: { checkedAt: now } });
    return { kind, snapshotId: previous.id, unchanged: true, itemCount: previous.itemCount, skippedCount: previous.skippedCount, changedCount: 0, affectedPrices: kind === 'cost' ? await costDrift(db, environment) : [] };
  }

  let changedCount: number | null = null;
  if (previous) {
    const old = new Map((await db.supplierPrice.findMany({ where: { snapshotId: previous.id }, select: { ref: true, amountMinor: true } })).map((r) => [r.ref, r.amountMinor]));
    changedCount = 0;
    for (const p of prices) {
      const o = old.get(p.ref);
      if (o === undefined || Number(o) !== p.amountMinor) changedCount++;
      old.delete(p.ref);
    }
    changedCount += old.size; // removed
  }

  const snapshot = await db.$transaction(async (tx) => {
    const s = await tx.supplierPriceSnapshot.create({
      data: { provider: 'resellerclub', kind, environment, currency: opts.currency, itemCount: prices.length, skippedCount: skipped, contentHash: hash, changedCount, fetchedById: opts.actorId, fetchedAt: now, checkedAt: now },
    });
    for (let i = 0; i < prices.length; i += 2000) {
      await tx.supplierPrice.createMany({ data: prices.slice(i, i + 2000).map((p) => ({ ...p, snapshotId: s.id, amountMinor: BigInt(p.amountMinor) })) });
    }
    // Keep the newest snapshots of this kind and environment.
    const old = await tx.supplierPriceSnapshot.findMany({ where: { provider: 'resellerclub', kind, environment }, orderBy: { fetchedAt: 'desc' }, skip: KEEP_SNAPSHOTS, select: { id: true } });
    if (old.length) await tx.supplierPriceSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    await tx.auditEvent.create({ data: { actorId: opts.actorId ?? null, actorType: opts.actorId ? 'operator' : 'system', action: 'supplier.prices_synced', targetType: 'supplier_price_snapshot', targetId: s.id, metadata: { kind, environment, itemCount: prices.length, changedCount, skipped } } });
    return s;
  }, { timeout: 120_000 });

  return { kind, snapshotId: snapshot.id, unchanged: false, itemCount: prices.length, skippedCount: skipped, changedCount, affectedPrices: kind === 'cost' ? await costDrift(db, environment) : [] };
}

export const COST_SOURCE_PREFIX = 'resellerclub:cost:';

export async function latestSnapshot(db: PrismaClient | Prisma.TransactionClient, kind: SupplierPriceKind, environment?: string) {
  return db.supplierPriceSnapshot.findFirst({ where: { provider: 'resellerclub', kind, ...(environment ? { environment } : {}) }, orderBy: { fetchedAt: 'desc' } });
}

/**
 * Current supplier cost for a ref from the latest cost snapshot of the given environment (demo prices must never
 * become the cost basis of a live catalogue).
 */
export async function currentSupplierCost(db: PrismaClient | Prisma.TransactionClient, ref: string, environment: string) {
  const snap = await latestSnapshot(db, 'cost', environment);
  if (!snap) return null;
  const item = await db.supplierPrice.findUnique({ where: { snapshotId_ref: { snapshotId: snap.id, ref } } });
  return item ? { amountMinor: minorFromDb(item.amountMinor), currency: snap.currency, snapshotId: snap.id, fetchedAt: snap.fetchedAt, environment: snap.environment } : null;
}

/**
 * Prices currently on sale whose cost basis (costSource = "resellerclub:cost:<ref>") differs from the latest
 * supplier cost — or whose ref disappeared. Selling prices are never changed automatically; an operator decides.
 */
export async function costDrift(db: PrismaClient, environment: string, now = new Date()): Promise<CostDrift[]> {
  const snap = await latestSnapshot(db, 'cost', environment);
  if (!snap) return [];
  const prices = await db.priceVersion.findMany({
    where: {
      costSource: { startsWith: COST_SOURCE_PREFIX },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      planVersion: { publishedAt: { not: null }, retiredAt: null },
    },
    include: { planVersion: { include: { plan: { include: { product: true } } } } },
  });
  if (prices.length === 0) return [];
  const refs = prices.map((p) => p.costSource!.slice(COST_SOURCE_PREFIX.length));
  const current = new Map((await db.supplierPrice.findMany({ where: { snapshotId: snap.id, ref: { in: refs } } })).map((r) => [r.ref, minorFromDb(r.amountMinor)]));
  const out: CostDrift[] = [];
  for (const p of prices) {
    const ref = p.costSource!.slice(COST_SOURCE_PREFIX.length);
    const recorded = p.costMinor === null ? null : minorFromDb(p.costMinor);
    const cur = current.get(ref) ?? null;
    if (recorded !== null && cur === recorded) continue;
    const selling = minorFromDb(p.amountMinor);
    out.push({
      priceVersionId: p.id,
      product: p.planVersion.plan.product.name,
      plan: p.planVersion.plan.name,
      ref,
      recordedCostMinor: recorded ?? 0,
      currentCostMinor: cur,
      sellingMinor: selling,
      marginBps: cur === null || selling === 0 ? null : Math.round(((selling - cur) / selling) * 10_000),
    });
  }
  return out;
}

/** Due for an automatic refresh? (no snapshot yet, or the last check is older than `hours`). */
export async function priceSyncDue(db: PrismaClient, environment: string, hours: number, now = new Date()) {
  if (hours <= 0) return [] as SupplierPriceKind[];
  const due: SupplierPriceKind[] = [];
  for (const kind of ['cost', 'customer'] as const) {
    const s = await latestSnapshot(db, kind, environment);
    if (!s || now.getTime() - s.checkedAt.getTime() >= hours * 3600_000) due.push(kind);
  }
  return due;
}
