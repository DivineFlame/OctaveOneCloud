import { PrismaClient } from '@ooc/db';
import { AdapterRegistry, CashfreeClient, expireStaleReservations, issueInvoiceForOrder, ordersAwaitingInvoice, processInboxRow, processSubscriptionLifecycle, reconcilePaymentOrder, runProvisioningJob } from '@ooc/integrations';
import { SellerProfile } from '@ooc/shared';
import { log } from './log';

export interface Deps {
  db: PrismaClient;
  adapters: AdapterRegistry;
  cashfree: CashfreeClient;
  enqueueProvisioning: (jobId: string) => Promise<void>;
  /** null when the seller's legal details are not configured: invoices wait (the sweeper issues them later). */
  seller: SellerProfile | null;
}

let warnedNoSeller = false;

/** Issues the tax invoice for a paid order. Idempotent; failures are retried by the sweeper. */
export async function issueInvoice(deps: Deps, orderId: string) {
  if (!deps.seller) {
    if (!warnedNoSeller) log('warn', 'invoices not issued: SELLER_LEGAL_NAME / SELLER_ADDRESS / SELLER_STATE_CODE not configured');
    warnedNoSeller = true;
    return null;
  }
  try {
    const r = await issueInvoiceForOrder(deps.db, orderId, deps.seller);
    if (r.result === 'issued') log('info', 'invoice issued', { orderId, invoiceId: r.invoiceId, number: r.number });
    else if (r.result === 'not_ready') log('warn', 'invoice not issued', { orderId, reason: r.reason });
    return r;
  } catch (e) {
    log('error', 'invoice issue failed', { orderId, error: (e as Error).message });
    return null;
  }
}

export async function handleInbox(deps: Deps, inboxId: string) {
  const r = await processInboxRow(deps.db, inboxId);
  for (const id of r.provisioningJobIds ?? []) await deps.enqueueProvisioning(id);
  if (r.paidOrderId) await issueInvoice(deps, r.paidOrderId);
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
  for (const r of results) {
    if (r.result !== 'paid') continue;
    for (const id of r.provisioningJobIds) await deps.enqueueProvisioning(id);
    await issueInvoice(deps, r.orderId);
  }
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

  let invoices = 0;
  if (deps.seller) {
    for (const o of await ordersAwaitingInvoice(deps.db, 50)) if ((await issueInvoice(deps, o.id))?.result === 'issued') invoices++;
  }
  // Cancellations at period end, scheduled downgrades and operator suspend/resume requests.
  const lifecycle = await processSubscriptionLifecycle(deps.db, deps.adapters);
  for (const l of lifecycle) {
    if (l.result === 'done') log('info', 'subscription lifecycle', { ...l });
    else if (l.result === 'retry_later') log('warn', 'subscription lifecycle deferred', { ...l });
  }
  if (inbox.length || jobs.length || pending.length || expired || invoices || lifecycle.length) {
    log('info', 'sweep', { inbox: inbox.length, jobs: jobs.length, reconcile: pending.length, expiredReservations: expired, invoices, lifecycle: lifecycle.length });
  }
}
