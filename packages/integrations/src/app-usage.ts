import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { EffectiveEntitlement, mergeEntitlements } from '@ooc/shared';
import { QuotaExceededError, ensureCounter, releaseUsage, reserveUsage, settleUsage } from './usage';

/**
 * Entitlements and quotas as seen by hosted apps (the app-side enforcement source of truth).
 *
 *  - Effective entitlements merge every active grant (subscriptions, usage packs, manual) by the feature's
 *    merge policy; revoked or expired grants are ignored.
 *  - Metered features have a counter per calendar month (IST). Its limit follows the current entitlement,
 *    so a downgrade or an expired pack lowers the cap immediately (already-used units are not refunded).
 *  - An app may only act for organisations it has been provisioned for.
 */

export class AppUsageError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const IST_MS = 330 * 60_000;

/** Calendar month in IST containing `now`, as UTC instants. */
export function usagePeriod(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS);
  const end = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_MS);
  return { start, end };
}

export async function effectiveEntitlements(db: PrismaClient | Prisma.TransactionClient, orgId: string, now = new Date()) {
  const rows = await db.entitlement.findMany({
    where: { orgId, revokedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    orderBy: { createdAt: 'asc' },
  });
  const merged = mergeEntitlements(rows.map((r) => ({ featureKey: r.featureKey, sourceId: `${r.sourceType}:${r.sourceId}`, mergePolicy: r.mergePolicy, limit: r.limit === null ? null : minorFromDb(r.limit) })));
  return { merged, grants: rows };
}

/** Has this app (adapter key) been provisioned for the organisation, with evidence? */
export async function appServesOrg(db: PrismaClient, adapterKey: string, orgId: string) {
  const products = await db.product.findMany({ where: { adapterKey }, select: { key: true } });
  if (products.length === 0) return false;
  const names = products.flatMap((p) => [`product:${p.key}`, `component:${p.key}`]);
  const step = await db.provisioningStep.findFirst({ where: { status: 'active', name: { in: names }, job: { orgId } }, select: { id: true } });
  return step !== null;
}

async function requireOrg(db: PrismaClient, adapterKey: string, orgId: string) {
  if (!(await appServesOrg(db, adapterKey, orgId))) throw new AppUsageError('org_not_served', 'This app is not provisioned for the organisation');
}

export async function appEntitlements(db: PrismaClient, adapterKey: string, orgId: string, now = new Date()) {
  await requireOrg(db, adapterKey, orgId);
  const { merged } = await effectiveEntitlements(db, orgId, now);
  const subs = await db.subscription.findMany({ where: { orgId, status: { not: 'cancelled' } }, select: { id: true, status: true, currentPeriodEnd: true } });
  return {
    orgId,
    // Access is suspended when every subscription is suspended (entitlements are also revoked then).
    entitlements: [...merged.values()].map((e: EffectiveEntitlement) => ({ featureKey: e.featureKey, limit: e.limit, mergePolicy: e.mergePolicy })),
    subscriptions: subs,
    checkedAt: now.toISOString(),
  };
}

async function counterFor(db: PrismaClient, orgId: string, resource: string, now: Date) {
  const feature = await db.feature.findUnique({ where: { key: resource } });
  if (!feature) throw new AppUsageError('unknown_resource', `Unknown feature ${resource}`);
  if (!feature.metered || feature.mergePolicy === 'boolean') throw new AppUsageError('not_metered', `${resource} is not a metered feature`);
  const { merged } = await effectiveEntitlements(db, orgId, now);
  const ent = merged.get(resource);
  if (!ent || ent.limit === null) throw new AppUsageError('not_entitled', `The organisation has no ${resource} entitlement`);
  const period = usagePeriod(now);
  return ensureCounter(db, { orgId, resource, periodStart: period.start, periodEnd: period.end, limit: BigInt(ent.limit) });
}

export async function appReserve(db: PrismaClient, adapterKey: string, input: { orgId: string; resource: string; quantity: number; idempotencyKey: string; ttlSeconds?: number }, now = new Date()) {
  await requireOrg(db, adapterKey, input.orgId);
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new AppUsageError('invalid_quantity', 'quantity must be a positive integer');
  const counter = await counterFor(db, input.orgId, input.resource, now);
  try {
    const r = await reserveUsage(db, { counterId: counter.id, quantity: BigInt(input.quantity), idempotencyKey: `${adapterKey}:${input.idempotencyKey}`, ttlMs: Math.min(Math.max(input.ttlSeconds ?? 900, 30), 24 * 3600) * 1000 });
    if (r.orgId !== input.orgId) throw new AppUsageError('idempotency_conflict', 'Idempotency key already used for another organisation');
    return { reservationId: r.id, status: r.status, quantity: Number(r.quantity), expiresAt: r.expiresAt, periodEnd: counter.periodEnd };
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      const c = await db.usageCounter.findUniqueOrThrow({ where: { id: counter.id } });
      throw new AppUsageError('quota_exceeded', `Quota exceeded for ${input.resource}`, { limit: Number(c.limit), used: Number(c.used), reserved: Number(c.reserved), periodEnd: c.periodEnd });
    }
    throw e;
  }
}

async function ownReservation(db: PrismaClient, adapterKey: string, reservationId: string) {
  const r = await db.usageReservation.findUnique({ where: { id: reservationId } });
  if (!r || !r.idempotencyKey.startsWith(`${adapterKey}:`)) throw new AppUsageError('reservation_not_found', 'Reservation not found');
  return r;
}

export async function appSettle(db: PrismaClient, adapterKey: string, input: { reservationId: string; actualQuantity: number; sourceEventId: string }) {
  const r = await ownReservation(db, adapterKey, input.reservationId);
  if (!Number.isSafeInteger(input.actualQuantity) || input.actualQuantity < 0) throw new AppUsageError('invalid_quantity', 'actualQuantity must be a non-negative integer');
  const res = await settleUsage(db, { reservationId: r.id, actualQuantity: BigInt(input.actualQuantity), source: adapterKey, sourceEventId: input.sourceEventId });
  if (!res.settled) {
    // Repeating a settle with the same event is fine; anything else is a state error the app must see.
    const prior = await db.usageEvent.findUnique({ where: { source_sourceEventId: { source: adapterKey, sourceEventId: input.sourceEventId } } });
    if (prior && prior.reservationId === r.id) return { settled: true, billed: Number(prior.quantity), replay: true };
    throw new AppUsageError('reservation_not_open', res.reason);
  }
  return { settled: true, billed: Number(res.billed), cappedFrom: res.cappedFrom !== undefined ? Number(res.cappedFrom) : undefined };
}

export async function appRelease(db: PrismaClient, adapterKey: string, reservationId: string) {
  const r = await ownReservation(db, adapterKey, reservationId);
  return { released: await releaseUsage(db, r.id) };
}

/** Customer view: entitlements with sources and this month's metered usage. */
export async function orgUsageSummary(db: PrismaClient, orgId: string, now = new Date()) {
  const { merged, grants } = await effectiveEntitlements(db, orgId, now);
  const period = usagePeriod(now);
  const [features, counters] = await Promise.all([
    db.feature.findMany({ where: { key: { in: [...merged.keys()] } } }),
    db.usageCounter.findMany({ where: { orgId, periodStart: period.start } }),
  ]);
  return {
    period,
    features: [...merged.values()].map((e) => {
      const f = features.find((x) => x.key === e.featureKey);
      const c = counters.find((x) => x.resource === e.featureKey);
      return {
        featureKey: e.featureKey,
        name: f?.name ?? e.featureKey,
        unit: f?.unit ?? null,
        metered: f?.metered ?? false,
        limit: e.limit,
        used: c ? Number(c.used) : 0,
        reserved: c ? Number(c.reserved) : 0,
        grants: grants.filter((g) => g.featureKey === e.featureKey).map((g) => ({ sourceType: g.sourceType, limit: g.limit === null ? null : Number(g.limit), validTo: g.validTo })),
      };
    }),
  };
}
