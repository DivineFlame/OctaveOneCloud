#!/usr/bin/env node
/**
 * Migration drift check (no native Prisma binaries required).
 *   A = database built by applying every migration in order.
 *   B = database built from schema.prisma (Prisma's Wasm schema engine, same commit as the pinned CLI)
 *       plus the hand-written migrations marked "-- ooc:custom-sql".
 * The catalog snapshots of A and B (columns, types, defaults, constraints, indexes, enums, triggers)
 * must be identical; otherwise schema.prisma and prisma/migrations have drifted.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPkg = path.join(root, 'packages', 'db');
const migrationsDir = path.join(dbPkg, 'prisma', 'migrations');
const require = createRequire(path.join(dbPkg, 'package.json'));
const pg = require('pg');
const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://ooc:ooc@localhost:5432/ooc_test');
const stamp = Date.now();
const names = { a: `ooc_drift_a_${stamp}`, b: `ooc_drift_b_${stamp}` };
const urlFor = (name) => Object.assign(new URL(base), { pathname: `/${name}` }).toString();

const SNAPSHOT = `
SELECT json_build_object(
  'columns', (SELECT json_agg(x ORDER BY x) FROM (SELECT table_name || '.' || column_name || ' ' || udt_name || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') AS x
              FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations') c),
  'constraints', (SELECT json_agg(x ORDER BY x) FROM (SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS x
                  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT IN ('_prisma_migrations', '"_prisma_migrations"')) k),
  'indexes', (SELECT json_agg(indexdef ORDER BY indexdef) FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'),
  'enums', (SELECT json_agg(x ORDER BY x) FROM (SELECT t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS x
            FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname) en),
  'triggers', (SELECT json_agg(x ORDER BY x) FROM (SELECT tgrelid::regclass::text || ' ' || tgname AS x FROM pg_trigger WHERE NOT tgisinternal) tr)
) AS snapshot`;

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${names.a}"`);
  await admin.query(`CREATE DATABASE "${names.b}"`);

  execFileSync(process.execPath, ['--no-warnings', path.join(dbPkg, 'scripts', 'schema-engine-wasm.mjs'), 'deploy'], { env: { ...process.env, DATABASE_URL: urlFor(names.a) }, stdio: 'ignore' });

  const tmpSql = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ooc-drift-')), 'schema.sql');
  execFileSync(process.execPath, ['--no-warnings', path.join(dbPkg, 'scripts', 'schema-engine-wasm.mjs'), 'diff-empty', tmpSql], { env: { ...process.env, DATABASE_URL: urlFor(names.b) }, stdio: 'ignore' });
  await withClient(urlFor(names.b), async (c) => {
    await c.query(fs.readFileSync(tmpSql, 'utf8'));
    for (const dir of fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory()).sort()) {
      const sql = fs.readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8');
      if (sql.startsWith('-- ooc:custom-sql')) await c.query(sql);
    }
  });

  const a = await withClient(urlFor(names.a), (c) => c.query(SNAPSHOT).then((r) => r.rows[0].snapshot));
  const b = await withClient(urlFor(names.b), (c) => c.query(SNAPSHOT).then((r) => r.rows[0].snapshot));
  let drift = false;
  for (const key of Object.keys(a)) {
    const sa = new Set(a[key] ?? []);
    const sb = new Set(b[key] ?? []);
    for (const x of sa) if (!sb.has(x)) { drift = true; console.error(`only in migrations  [${key}] ${x}`); }
    for (const x of sb) if (!sa.has(x)) { drift = true; console.error(`only in schema.prisma [${key}] ${x}`); }
  }
  if (drift) {
    console.error('\nSchema drift detected: create a migration for schema.prisma changes.');
    process.exitCode = 1;
  } else {
    console.log('Migrations match schema.prisma.');
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${names.a}" WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS "${names.b}" WITH (FORCE)`);
  await admin.end();
}
