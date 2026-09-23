import { PrismaClient } from '@ooc/db';
import { AdapterRegistry, CashfreeClient, expireStaleReservations, processInboxRow, reconcilePaymentOrder, runProvisioningJob } from '@ooc/integrations';
import { log } from './log';

export interface Deps {
  db: PrismaClient;
  adapters: AdapterRegistry;
  cashfree: CashfreeClient;
  enqueueProvisioning: (jobId: string) => Promise<void>;
}

export async function handleInbox(deps: Deps, inboxId: string) {
  const r = await processInboxRow(deps.db, inboxId);
  for (const id of r.provisioningJobIds ?? []) await deps.enqueueProvisioning(id);
  log('info', 'inbox processed', { inboxId, status: r.status, detail: r.detail });
  return r;
}

export async function handleProvisioning(deps: Deps, jobId: string) {
  const r = await runProvisioningJob(deps.db, deps.adapters, jobId);
  log(r.status === 'active' ? 'info' : 'warn', 'provisioning finished', { jobId, status: r.status, steps: r.steps });
  return r;
}

export async function handleReconcile(deps: Deps, paymentOrderId: string) {
  if (!deps.cashfree.enabled) {
    log('warn', 'reconcile skipped: Cashfree disabled', { paymentOrderId });
    return [];
  }
  const results = await reconcilePaymentOrder(deps.db, deps.cashfree, paymentOrderId);
  for (const r of results) if (r.result === 'paid') for (const id of r.provisioningJobIds) await deps.enqueueProvisioning(id);
  log('info', 'payment order reconciled', { paymentOrderId, results: results.map((r) => r.result) });
  return results;
}

/**
 * Periodic safety net. Durable DB rows are the source of truth; queues are only a delivery mechanism,
 * so anything that missed its queue message is found here.
 */
export async function sweep(deps: Deps, enqueue: { inbox: (id: string) => Promise<void>; reconcile: (id: string) => Promise<void> }) {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000);
  const inbox = await deps.db.webhookInbox.findMany({ where: { status: 'received', receivedAt: { lt: twoMinAgo } }, select: { id: true }, take: 200 });
  for (const r of inbox) await enqueue.inbox(r.id);

  const jobs = await deps.db.provisioningJob.findMany({ where: { status: 'queued', createdAt: { lt: twoMinAgo } }, select: { id: true }, take: 200 });
  for (const j of jobs) await deps.enqueueProvisioning(j.id);

  // Payment orders still awaiting evidence after 10 minutes: ask the status API (missing webhooks).
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const pending = await deps.db.paymentOrder.findMany({ where: { status: { in: ['created', 'active'] }, createdAt: { lt: tenMinAgo, gt: dayAgo } }, select: { id: true }, take: 100 });
  for (const p of pending) await enqueue.reconcile(p.id);

  const expired = await expireStaleReservations(deps.db);
  if (inbox.length || jobs.length || pending.length || expired) log('info', 'sweep', { inbox: inbox.length, jobs: jobs.length, reconcile: pending.length, expiredReservations: expired });
}
