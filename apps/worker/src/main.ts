import { Job, Queue, Worker } from 'bullmq';
import { createPrismaClient } from '@ooc/db';
import { CashfreeClient, ResellerClubClient } from '@ooc/integrations';
import { cashfreeBaseUrl, loadConfig, redisOptionsFromUrl, renewalSettings, sellerProfile } from '@ooc/shared';
import { buildAdapterRegistry } from './adapters';
import { createMailer } from './mail';
import { Deps, handleInbox, handlePriceSync, handleProvisioning, handleReconcile, sweep } from './jobs';
import { log } from './log';

const QUEUES = { webhooks: 'webhooks', provisioning: 'provisioning', reconcile: 'reconcile', maintenance: 'maintenance', supplier: 'supplier' } as const;

async function main() {
  const config = loadConfig(process.env);
  const connection = redisOptionsFromUrl(config.REDIS_URL);
  const db = createPrismaClient(config.DATABASE_URL);
  const defaultJobOptions = { attempts: 8, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: false };
  const queues = {
    webhooks: new Queue(QUEUES.webhooks, { connection, defaultJobOptions }),
    provisioning: new Queue(QUEUES.provisioning, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 3 } }),
    reconcile: new Queue(QUEUES.reconcile, { connection, defaultJobOptions }),
    maintenance: new Queue(QUEUES.maintenance, { connection }),
    // Supplier price-list fetches are slow (large responses); a separate queue keeps them off the sweep.
    supplier: new Queue(QUEUES.supplier, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential' as const, delay: 60_000 }, removeOnComplete: 100, removeOnFail: 100 } }),
  };
  const deps: Deps = {
    db,
    adapters: buildAdapterRegistry(process.env),
    cashfree: new CashfreeClient(cashfreeBaseUrl(config.CASHFREE_ENV), { clientId: config.CASHFREE_CLIENT_ID, clientSecret: config.CASHFREE_CLIENT_SECRET, apiVersion: config.CASHFREE_API_VERSION }),
    seller: sellerProfile(config),
    renewal: renewalSettings(config),
    sellerStateCode: config.SELLER_STATE_CODE,
    appUrl: config.APP_URL,
    resellerclub: new ResellerClubClient(config, db),
    resellerclubCurrency: config.RESELLERCLUB_CURRENCY,
    priceSyncHours: config.RESELLERCLUB_PRICE_SYNC_HOURS,
    enqueuePriceSync: async (kind) => {
      // One pending job per kind per hour window; manual requests from the API use their own job ids.
      await queues.supplier.add('price-sync', { kind }, { jobId: `price-sync-${kind}-${Math.floor(Date.now() / 3_600_000)}` });
    },
    mailer: createMailer(config),
    enqueueProvisioning: async (id) => {
      await queues.provisioning.add('run', { jobId: id }, { jobId: `prov-${id}-${Date.now()}` });
    },
  };

  // Bounded concurrency; payment/provisioning work is isolated from any GPU/agent workloads.
  const workers = [
    new Worker(QUEUES.webhooks, (j: Job<{ inboxId: string }>) => handleInbox(deps, j.data.inboxId), { connection, concurrency: 4 }),
    new Worker(QUEUES.provisioning, (j: Job<{ jobId: string }>) => handleProvisioning(deps, j.data.jobId), { connection, concurrency: 2 }),
    new Worker(QUEUES.supplier, (j: Job<{ kind: 'cost' | 'customer'; actorId?: string }>) => handlePriceSync(deps, j.data.kind, j.data.actorId), { connection, concurrency: 1 }),
    new Worker(QUEUES.reconcile, (j: Job<{ paymentOrderId: string }>) => handleReconcile(deps, j.data.paymentOrderId), { connection, concurrency: 2 }),
    new Worker(
      QUEUES.maintenance,
      () =>
        sweep(deps, {
          inbox: async (id) => void (await queues.webhooks.add('inbox', { inboxId: id }, { jobId: `inbox-${id}-${Math.floor(Date.now() / 60_000)}` })),
          reconcile: async (id) => void (await queues.reconcile.add('payment-order', { paymentOrderId: id }, { jobId: `po-${id}-${Math.floor(Date.now() / 300_000)}` })),
        }),
      { connection, concurrency: 1 },
    ),
  ];
  for (const w of workers) {
    // Jobs that exhaust retries stay in the failed set (dead letter) for the operator console.
    w.on('failed', (job, err) => log(job && job.attemptsMade >= (job.opts.attempts ?? 1) ? 'error' : 'warn', 'job failed', { queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, error: err.message }));
  }
  await queues.maintenance.upsertJobScheduler('sweep', { every: 60_000 }, { name: 'sweep' });
  log('info', 'worker started', { queues: Object.values(QUEUES) });

  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(Object.values(queues).map((q) => q.close()));
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  process.stderr.write(`Fatal worker error: ${(e as Error).message}\n`);
  process.exit(1);
});
