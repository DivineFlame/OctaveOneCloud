import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export * from './generated/prisma/client';

export type Db = PrismaClient;
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

export function createPrismaClient(connectionString: string, opts: { log?: boolean } = {}): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, log: opts.log ? ['warn', 'error'] : ['error'] });
}

/** Converts a BigInt minor-unit column to a JS number, refusing values outside the safe range. */
export function minorFromDb(value: bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Monetary value exceeds safe integer range');
  }
  return Number(value);
}

export function minorToDb(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new Error('Monetary value must be a safe integer');
  return BigInt(value);
}

/** Recognises Postgres unique-violation errors surfaced through Prisma. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; meta?: { driverAdapterError?: { cause?: { kind?: string } } } };
  return (
    e?.code === 'P2002' ||
    e?.cause?.code === '23505' ||
    e?.meta?.driverAdapterError?.cause?.kind === 'UniqueConstraintViolation'
  );
}
