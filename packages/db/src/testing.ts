import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { PrismaClient } from './generated/prisma/client';

/** Test-only helpers. Never import from application code. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://ooc:ooc@localhost:5432/ooc_test';

export function migrateTestDatabase(url = TEST_DATABASE_URL) {
  if (!/test/i.test(new URL(url).pathname)) throw new Error('Refusing to migrate a database whose name does not contain "test"');
  const script = path.resolve(__dirname, '..', 'scripts', 'schema-engine-wasm.mjs');
  execFileSync(process.execPath, ['--no-warnings', script, 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
}

export async function truncateAll(db: PrismaClient) {
  const url = process.env.DATABASE_URL ?? '';
  if (!/test/i.test(url)) throw new Error('Refusing to truncate a non-test database');
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
