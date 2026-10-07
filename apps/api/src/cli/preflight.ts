/**
 * Production pre-flight check, run on the server before taking real customers:
 *   docker compose exec api node dist/cli/preflight.js        (Dokploy: service api → Terminal)
 * Prints every readiness check (never secret values) and exits 1 if any automated check fails.
 */
import { createPrismaClient } from '@ooc/db';
import { launchReadiness } from '@ooc/integrations';
import { loadConfig } from '@ooc/shared';

const ICON = { pass: 'PASS  ', fail: 'FAIL  ', warn: 'WARN  ', manual: 'MANUAL' } as const;

async function main() {
  const config = loadConfig(process.env);
  const db = createPrismaClient(config.DATABASE_URL);
  try {
    const r = await launchReadiness(db, config);
    let area = '';
    for (const c of r.checks) {
      if (c.area !== area) {
        area = c.area;
        process.stdout.write(`\n== ${area.replace('_', ' ')} ==\n`);
      }
      process.stdout.write(`${ICON[c.status]}  ${c.title} — ${c.detail}\n`);
    }
    process.stdout.write(`\n${r.summary.pass} pass, ${r.summary.warn} warn, ${r.summary.fail} fail, ${r.summary.manual} manual gates (APP_ENV=${r.appEnv})\n`);
    process.stdout.write(r.automatedChecksPass ? 'Automated checks pass. Complete the manual gates before taking real payments.\n' : 'NOT READY: fix the FAIL items above.\n');
    process.exitCode = r.automatedChecksPass ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(2);
});
