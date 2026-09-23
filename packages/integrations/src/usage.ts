import { Prisma, PrismaClient, isUniqueViolation } from '@ooc/db';

/**
 * Usage metering with reserve-then-settle. Caps hold under concurrency because the counter update is a
 * single conditional UPDATE (and a CHECK constraint backs it up). Budget is reserved before a run and
 * settled with actual usage afterwards; settlement never exceeds the reservation (overage is not billed
 * automatically). Released/expired reservations return capacity.
 */
export class QuotaExceededError extends Error {
  constructor(public readonly resource: string) {
    super(`Quota exceeded for ${resource}`);
  }
}

export async function ensureCounter(db: PrismaClient, input: { orgId: string; resource: string; periodStart: Date; periodEnd: Date; limit: bigint }) {
  return db.usageCounter.upsert({
    where: { orgId_resource_periodStart: { orgId: input.orgId, resource: input.resource, periodStart: input.periodStart } },
    update: { limit: input.limit, periodEnd: input.periodEnd },
    create: input,
  });
}

export async function reserveUsage(db: PrismaClient, input: { counterId: string; quantity: bigint; idempotencyKey: string; ttlMs?: number }) {
  if (input.quantity <= 0n) throw new Error('Reservation quantity must be positive');
  const prior = await db.usageReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (prior) return prior;
  try {
    return await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ orgId: string; resource: string }[]>(Prisma.sql`
        UPDATE "UsageCounter" SET "reserved" = "reserved" + ${input.quantity}, "updatedAt" = now()
        WHERE "id" = ${input.counterId}::uuid AND "used" + "reserved" + ${input.quantity} <= "limit"
        RETURNING "orgId", "resource"`);
      if (rows.length !== 1) {
        const c = await tx.usageCounter.findUnique({ where: { id: input.counterId } });
        throw new QuotaExceededError(c?.resource ?? 'unknown');
      }
      return tx.usageReservation.create({
        data: {
          orgId: rows[0]!.orgId,
          counterId: input.counterId,
          resource: rows[0]!.resource,
          quantity: input.quantity,
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(Date.now() + (input.ttlMs ?? 15 * 60_000)),
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return db.usageReservation.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
    throw e;
  }
}

export async function settleUsage(db: PrismaClient, input: { reservationId: string; actualQuantity: bigint; source: string; sourceEventId: string; planVersionId?: string }) {
  return db.$transaction(async (tx) => {
    const r = await tx.usageReservation.findUniqueOrThrow({ where: { id: input.reservationId } });
    const billed = input.actualQuantity < 0n ? 0n : input.actualQuantity > r.quantity ? r.quantity : input.actualQuantity;
    const claimed = await tx.usageReservation.updateMany({ where: { id: r.id, status: 'reserved' }, data: { status: 'settled', settledQuantity: billed } });
    if (claimed.count !== 1) return { settled: false as const, reason: `reservation is ${r.status}` };
    await tx.$executeRaw(Prisma.sql`
      UPDATE "UsageCounter" SET "reserved" = "reserved" - ${r.quantity}, "used" = "used" + ${billed}, "updatedAt" = now()
      WHERE "id" = ${r.counterId}::uuid`);
    await tx.usageEvent.create({
      data: { orgId: r.orgId, source: input.source, sourceEventId: input.sourceEventId, resource: r.resource, quantity: billed, occurredAt: new Date(), planVersionId: input.planVersionId, reservationId: r.id },
    });
    return { settled: true as const, billed, cappedFrom: input.actualQuantity > r.quantity ? input.actualQuantity : undefined };
  });
}

export async function releaseUsage(db: PrismaClient, reservationId: string, status: 'released' | 'expired' = 'released') {
  return db.$transaction(async (tx) => {
    const r = await tx.usageReservation.findUniqueOrThrow({ where: { id: reservationId } });
    const claimed = await tx.usageReservation.updateMany({ where: { id: r.id, status: 'reserved' }, data: { status } });
    if (claimed.count !== 1) return false;
    await tx.$executeRaw(Prisma.sql`UPDATE "UsageCounter" SET "reserved" = "reserved" - ${r.quantity}, "updatedAt" = now() WHERE "id" = ${r.counterId}::uuid`);
    return true;
  });
}

export async function expireStaleReservations(db: PrismaClient, now = new Date()) {
  const stale = await db.usageReservation.findMany({ where: { status: 'reserved', expiresAt: { lt: now } }, select: { id: true }, take: 500 });
  let n = 0;
  for (const s of stale) if (await releaseUsage(db, s.id, 'expired')) n++;
  return n;
}
