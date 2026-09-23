#!/usr/bin/env node
/**
 * Cross-platform `prisma generate`. Client generation does not use the native schema engine, so we point
 * PRISMA_SCHEMA_ENGINE_BINARY at an existing placeholder file to stop the CLI from downloading it
 * (the download is blocked in some build environments). Migrations are unaffected.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
env.PRISMA_SCHEMA_ENGINE_BINARY ??= path.join(here, 'schema-engine-placeholder.txt');
const r = spawnSync(process.platform === 'win32' ? 'prisma.cmd' : 'prisma', ['generate'], { cwd: path.join(here, '..'), env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
