#!/usr/bin/env node
/**
 * Offline fallback for Prisma migrations using Prisma's own WebAssembly schema engine
 * (same engine commit as the pinned prisma CLI), for environments where the native
 * schema-engine binary cannot be downloaded from binaries.prisma.sh.
 *
 *   node scripts/schema-engine-wasm.mjs diff-empty <out.sql>   # SQL for a fresh database from schema.prisma
 *   node scripts/schema-engine-wasm.mjs deploy                 # apply pending migrations via node-postgres (like `prisma migrate deploy`)
 *
 * Prefer the regular `prisma migrate dev|deploy` CLI wherever it works.
 */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaEngine } from '@prisma/schema-engine-wasm';
import { PrismaPg } from '@prisma/adapter-pg';
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const schemaPath = path.join(root, 'prisma', 'schema.prisma');
const migrationsDir = path.join(root, 'prisma', 'migrations');
const filters = { externalTables: [], externalEnums: [] };

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function loadMigrations() {
  const lockPath = path.join(migrationsDir, 'migration_lock.toml');
  const dirs = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  return {
    baseDir: migrationsDir,
    lockfile: { path: 'migration_lock.toml', content: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null },
    shadowDbInitScript: '',
    migrationDirectories: dirs.map((d) => {
      const file = path.join(migrationsDir, d, 'migration.sql');
      return {
        path: d,
        migrationFile: {
          path: 'migration.sql',
          content: fs.existsSync(file) ? { tag: 'ok', value: fs.readFileSync(file, 'utf8') } : { tag: 'error', value: 'missing migration.sql' },
        },
      };
    }),
  };
}

/**
 * Applies pending migrations with node-postgres, recording them in _prisma_migrations exactly as
 * `prisma migrate deploy` does (sha256 checksum of migration.sql), so the native CLI can take over later.
 * Each migration runs as one multi-statement query inside a transaction, which supports plpgsql bodies.
 */
async function deploy() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(72707369)');
    await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
    const { rows } = await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"');
    const applied = [];
    for (const dir of loadMigrations().migrationDirectories) {
      if (dir.migrationFile.content.tag !== 'ok') throw new Error(`${dir.path}: ${dir.migrationFile.content.value}`);
      const sql = dir.migrationFile.content.value;
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = rows.filter((r) => r.migration_name === dir.path && !r.rolled_back_at);
      if (existing.some((r) => r.finished_at)) {
        if (!existing.some((r) => r.finished_at && r.checksum === checksum)) {
          console.warn(`warning: ${dir.path} was modified after it was applied`);
        }
        continue;
      }
      if (existing.length) throw new Error(`${dir.path} previously failed; resolve it before deploying (prisma migrate resolve)`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ($1, $2, now(), $3, 1)',
          [randomUUID(), checksum, dir.path],
        );
        await client.query('COMMIT');
        applied.push(dir.path);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${dir.path} failed: ${err.message}`);
      }
    }
    console.log(`applied: ${applied.join(', ') || '(none pending)'}`);
  } finally {
    await client.end();
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'diff-empty') {
  const content = fs.readFileSync(schemaPath, 'utf8');
  const adapter = bindMigrationAwareSqlAdapterFactory(new PrismaPg({ connectionString: url }));
  const engine = await SchemaEngine.new({ datamodels: [[schemaPath, content]] }, () => {}, adapter);
  const r = await engine.diff({ from: { tag: 'empty' }, to: { tag: 'schemaDatamodel', files: [{ path: schemaPath, content }] }, script: true, exitCode: null, filters });
  fs.writeFileSync(arg, r.stdout);
  console.log(`wrote ${arg}`);
} else if (cmd === 'deploy') {
  await deploy();
} else {
  console.error('usage: schema-engine-wasm.mjs diff-empty <out.sql> | deploy');
  process.exit(2);
}
process.exit(0);
