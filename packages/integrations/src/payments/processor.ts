import { PaymentAttemptStatus, Prisma, PrismaClient, RefundStatus, minorFromDb } from '@ooc/db';
import { decimalToMinor, redact } from '@ooc/shared';
import type { CashfreeClient, CashfreePayment } from '../cashfree/client';
import { applyRenewalPayment } from '../renewals';
import { applyUpgradePayment } from '../upgrades';

/**
 * Applies payment evidence to local state. Evidence comes from a signature-verified webhook or from
 * Cashfree's authenticated status API — never from the browser redirect.
 *
 * Invariants (enforced by conditional updates + unique constraints, not by hoping events arrive once):
 *  - One PaymentAttempt row per cf_payment_id; a success is never downgraded by a later event.
 *  - A PaymentOrder moves to `paid` at most once; the order moves awaiting_payment -> paid at most once.
 *  - Amount and currency must match the server-created order or the order goes to needs_attention.
 *  - A second successful payment for an already-paid order is flagged for refund review, not re-fulfilled.
 *  - Provisioning jobs are keyed by order item, so duplicate events cannot create duplicate fulfilment.
 */

export type EvidenceSource = 'webhook' | 'status_api';

export interface PaymentEvidence {
  providerOrderId: string;
  cfPaymentId: string;
  providerStatus: string;
  amountMinor: number;
  currency: string;
  method?: string;
  occurredAt?: Date;
  raw: unknown;
}

export type ApplyResult =
  | { result: 'unknown_order' }
  | { result: 'recorded'; status: PaymentAttemptStatus }
  | { result: 'paid'; orderId: string; provisioningJobIds: string[] }
  | { result: 'already_paid' }
  | { result: 'duplicate_payment'; orderId: string }
  | { result: 'mismatch'; orderId: string };

export function mapCashfreePaymentStatus(s: string): PaymentAttemptStatus {
  switch (s.toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'failed';
    case 'USER_DROPPED':
      return 'user_dropped';
    case 'CANCELLED':
    case 'VOID':
      return 'cancelled';
    case 'PENDING':
    case 'NOT_ATTEMPTED':
    case 'FLAGGED':
      return 'pending';
    default:
      return 'unknown';
  }
}

export async function applyPaymentEvidence(db: PrismaClient, ev: PaymentEvidence, source: EvidenceSource): Promise<ApplyResult> {
  const po = await db.paymentOrder.findUnique({ where: { providerOrderId: ev.providerOrderId }, include: { order: { include: { items: true } } } });
  if (!po) return { result: 'unknown_order' };
  const status = mapCashfreePaymentStatus(ev.providerStatus);

  return db.$transaction(async (tx) => {
    // Upsert the attempt without ever downgrading a recorded success.
    const existing = await tx.paymentAttempt.findUnique({ where: { providerPaymentId: ev.cfPaymentId } });
    if (!existing) {
      await tx.paymentAttempt.create({
        data: {
          paymentOrderId: po.id,
          providerPaymentId: ev.cfPaymentId,
          status,
          amountMinor: BigInt(ev.amountMinor),
          currency: ev.currency,
          method: ev.method,
          occurredAt: ev.occurredAt,
          providerPayload: redact(ev.raw) as Prisma.InputJsonValue,
        },
      });
    } else if (existing.status !== 'success' && existing.status !== status) {
      await tx.paymentAttempt.update({ where: { id: existing.id }, data: { status, providerPayload: redact(ev.raw) as Prisma.InputJsonValue } });
    }

    if (status !== 'success') return { result: 'recorded', status } as const;

    const expectedAmount = minorFromDb(po.amountMinor);
    if (ev.amountMinor !== expectedAmount || ev.currency !== po.currency) {
      await tx.order.updateMany({ where: { id: po.orderId, status: { in: ['awaiting_payment', 'paid'] } }, data: { status: 'needs_attention' } });
      await audit(tx, po.orgId, 'payment.amount_mismatch', po.orderId, { expectedAmount, receivedAmount: ev.amountMinor, currency: ev.currency, source });
      return { result: 'mismatch', orderId: po.orderId } as const;
    }

    const claimed = await tx.paymentOrder.updateMany({ where: { id: po.id, status: { in: ['created', 'active'] } }, data: { status: 'paid', paidAt: ev.occurredAt ?? new Date() } });
    if (claimed.count === 0) {
      // Already paid. Same payment id = duplicate delivery; different id = customer paid twice.
      const successes = await tx.paymentAttempt.count({ where: { paymentOrderId: po.id, status: 'success' } });
      if (successes > 1) {
        await audit(tx, po.orgId, 'payment.duplicate_success', po.orderId, { cfPaymentId: ev.cfPaymentId, source, action: 'refund_review_required' });
        return { result: 'duplicate_payment', orderId: po.orderId } as const;
      }
      return { result: 'already_paid' } as const;
    }

    const moved = await tx.order.updateMany({ where: { id: po.orderId, status: 'awaiting_payment' }, data: { status: 'paid', paidAt: new Date() } });
    if (moved.count === 0) {
      // The order was cancelled/expired locally while the customer paid: never silently fulfil or drop.
      await tx.order.update({ where: { id: po.orderId }, data: { status: 'needs_attention' } });
      await audit(tx, po.orgId, 'payment.received_for_inactive_order', po.orderId, { cfPaymentId: ev.cfPaymentId });
      return { result: 'mismatch', orderId: po.orderId } as const;
    }

    if (po.order.kind === 'renewal' || po.order.kind === 'upgrade') {
      // Renewals extend and upgrades change the existing subscription; nothing is provisioned again.
      const outcome = po.order.kind === 'renewal' ? await applyRenewalPayment(tx, po.orderId) : await applyUpgradePayment(tx, po.orderId);
      if (outcome !== 'extended' && outcome !== 'already_applied' && outcome !== 'scheduled') {
        await tx.order.update({ where: { id: po.orderId }, data: { status: 'needs_attention' } });
        await audit(tx, po.orgId, `${po.order.kind}.payment_needs_review`, po.orderId, { cfPaymentId: ev.cfPaymentId, reason: outcome, action: 'refund_or_manual_change' });
      }
      await tx.outboxEvent.create({ data: { topic: 'order.paid', aggregateId: po.orderId, payload: { orderId: po.orderId, orgId: po.orgId, source, kind: po.order.kind, outcome } } });
      await audit(tx, po.orgId, 'payment.confirmed', po.orderId, { cfPaymentId: ev.cfPaymentId, source });
      return { result: 'paid', orderId: po.orderId, provisioningJobIds: [] } as const;
    }

    const jobIds: string[] = [];
    for (const item of po.order.items) {
      const price = await tx.priceVersion.findUniqueOrThrow({ where: { id: item.priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } });
      const product = price.planVersion.plan.product;
      const job = await tx.provisioningJob.upsert({
        where: { idempotencyKey: `order-item:${item.id}` },
        update: {},
        create: { orgId: po.orgId, orderItemId: item.id, adapterKey: product.fulfillment === 'bundle' ? `bundle:${product.key}` : (product.adapterKey ?? `manual:${product.key}`), idempotencyKey: `order-item:${item.id}` },
      });
      jobIds.push(job.id);
    }
    await tx.order.update({ where: { id: po.orderId }, data: { status: 'provisioning' } });
    await tx.outboxEvent.create({ data: { topic: 'order.paid', aggregateId: po.orderId, payload: { orderId: po.orderId, orgId: po.orgId, source } } });
    await audit(tx, po.orgId, 'payment.confirmed', po.orderId, { cfPaymentId: ev.cfPaymentId, source });
    return { result: 'paid', orderId: po.orderId, provisioningJobIds: jobIds } as const;
  });
}

async function audit(tx: Prisma.TransactionClient, orgId: string, action: string, orderId: string, metadata: Record<string, unknown>) {
  await tx.auditEvent.create({ data: { actorType: 'provider', orgId, action, targetType: 'order', targetId: orderId, metadata: metadata as Prisma.InputJsonValue } });
}

// ───────────── Webhook inbox processing ─────────────

interface PgWebhook {
  type?: string;
  event_time?: string;
  data?: {
    order?: { order_id?: string; order_amount?: number | string; order_currency?: string };
    payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number | string; payment_currency?: string; payment_group?: string; payment_time?: string };
    refund?: { cf_refund_id?: string | number; refund_id?: string; order_id?: string; refund_amount?: number | string; refund_status?: string };
    dispute?: { dispute_id?: string | number; dispute_status?: string; dispute_amount?: number | string };
  };
}

export type InboxOutcome = { status: 'processed' | 'ignored'; detail: string; provisioningJobIds?: string[]; paidOrderId?: string };

export class InboxProcessingError extends Error {}

/** Processes one stored, signature-verified inbox row. Safe to call repeatedly for the same row. */
export async function processInboxRow(db: PrismaClient, inboxId: string): Promise<InboxOutcome> {
  const claimed = await db.webhookInbox.updateMany({ where: { id: inboxId, status: { in: ['received', 'failed'] } }, data: { status: 'processing', attempts: { increment: 1 } } });
  if (claimed.count === 0) {
    const row = await db.webhookInbox.findUnique({ where: { id: inboxId } });
    return { status: 'ignored', detail: `not claimable (status=${row?.status ?? 'missing'})` };
  }
  const row = await db.webhookInbox.findUniqueOrThrow({ where: { id: inboxId } });
  try {
    if (!row.signatureValid) throw new InboxProcessingError('unsigned inbox row');
    const outcome = row.channel === 'pg' ? await processPgEvent(db, JSON.parse(Buffer.from(row.rawBody).toString('utf8')) as PgWebhook) : { status: 'ignored' as const, detail: 'subscription events are processed from Stage 4 (recurrence); stored for replay' };
    await db.webhookInbox.update({ where: { id: inboxId }, data: { status: outcome.status, processedAt: new Date(), lastError: outcome.status === 'ignored' ? outcome.detail : null } });
    return outcome;
  } catch (e) {
    await db.webhookInbox.update({ where: { id: inboxId }, data: { status: 'failed', lastError: (e as Error).message.slice(0, 1000) } });
    throw e;
  }
}

async function processPgEvent(db: PrismaClient, body: PgWebhook): Promise<InboxOutcome> {
  const type = body.type ?? '';
  if (type.startsWith('PAYMENT_')) {
    const order = body.data?.order;
    const payment = body.data?.payment;
    if (!order?.order_id || payment?.cf_payment_id === undefined || !payment.payment_status) throw new InboxProcessingError('payment webhook missing order_id/cf_payment_id/payment_status');
    const r = await applyPaymentEvidence(
      db,
      {
        providerOrderId: order.order_id,
        cfPaymentId: String(payment.cf_payment_id),
        providerStatus: payment.payment_status,
        amountMinor: decimalToMinor(payment.payment_amount ?? order.order_amount ?? 'NaN'),
        currency: payment.payment_currency ?? order.order_currency ?? '',
        method: payment.payment_group,
        occurredAt: payment.payment_time ? new Date(payment.payment_time) : undefined,
        raw: body,
      },
      'webhook',
    );
    if (r.result === 'unknown_order') throw new InboxProcessingError(`unknown provider order ${order.order_id}`);
    return { status: 'processed', detail: r.result, provisioningJobIds: r.result === 'paid' ? r.provisioningJobIds : undefined, paidOrderId: r.result === 'paid' ? r.orderId : undefined };
  }
  if (type.startsWith('REFUND_')) {
    const refund = body.data?.refund;
    if (!refund?.refund_id || !refund.refund_status) throw new InboxProcessingError('refund webhook missing refund_id/refund_status');
    return { status: 'processed', detail: await applyRefundStatus(db, refund.refund_id, refund.refund_status, refund.cf_refund_id ? String(refund.cf_refund_id) : undefined, body) };
  }
  if (type.startsWith('DISPUTE_')) {
    const d = body.data?.dispute;
    if (!d?.dispute_id) throw new InboxProcessingError('dispute webhook missing dispute_id');
    await db.dispute.upsert({
      where: { providerDisputeId: String(d.dispute_id) },
      update: { status: d.dispute_status ?? 'unknown', providerPayload: redact(body) as Prisma.InputJsonValue },
      create: {
        providerDisputeId: String(d.dispute_id),
        providerPaymentId: String(body.data?.payment?.cf_payment_id ?? ''),
        amountMinor: BigInt(d.dispute_amount !== undefined ? decimalToMinor(d.dispute_amount) : 0),
        status: d.dispute_status ?? 'unknown',
        providerPayload: redact(body) as Prisma.InputJsonValue,
      },
    });
    return { status: 'processed', detail: 'dispute_recorded' };
  }
  return { status: 'ignored', detail: `unhandled event type ${type || '(none)'}` };
}

// Create/Get Refund document SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED (FAILED kept for webhooks).
const REFUND_MAP: Record<string, RefundStatus> = { SUCCESS: 'success', PENDING: 'pending', PENDING_APPROVAL: 'pending', ONHOLD: 'pending', CANCELLED: 'cancelled', REJECTED: 'failed', FAILED: 'failed' };
const REFUND_ALLOWED: Record<RefundStatus, RefundStatus[]> = { requested: ['pending', 'success', 'failed', 'cancelled'], pending: ['success', 'failed', 'cancelled'], success: [], failed: [], cancelled: [] };

/** A refund request is not a confirmed refund: only provider evidence moves it to success. */
export async function applyRefundStatus(db: PrismaClient | Prisma.TransactionClient, refundRequestId: string, providerStatus: string, providerRefundId: string | undefined, raw: unknown): Promise<string> {
  const next = REFUND_MAP[providerStatus.toUpperCase()];
  if (!next) return `unmapped refund status ${providerStatus}`;
  const refund = await db.refund.findUnique({ where: { refundRequestId } });
  if (!refund) throw new InboxProcessingError(`unknown refund ${refundRequestId}`);
  if (refund.status === next) return 'refund_unchanged';
  if (!REFUND_ALLOWED[refund.status].includes(next)) return `refund_transition_ignored ${refund.status}->${next}`;
  const updated = await db.refund.updateMany({ where: { id: refund.id, status: refund.status }, data: { status: next, providerRefundId: providerRefundId ?? refund.providerRefundId, providerPayload: redact(raw) as Prisma.InputJsonValue } });
  return updated.count === 1 ? `refund_${next}` : 'refund_concurrent_update';
}

// ───────────── Reconciliation with the status API (missing webhooks) ─────────────

export async function reconcilePaymentOrder(db: PrismaClient, cashfree: CashfreeClient, paymentOrderId: string): Promise<ApplyResult[]> {
  const po = await db.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
  const remote = await cashfree.getOrder(po.providerOrderId).catch((e: Error & { kind?: string }) => {
    if (e.kind === 'http') return null; // order never created remotely
    throw e;
  });
  if (!remote) {
    if (po.status === 'created') await db.order.updateMany({ where: { id: po.orderId, status: 'awaiting_payment' }, data: { status: 'needs_attention' } });
    return [];
  }
  if (remote.amountMinor !== minorFromDb(po.amountMinor) || remote.currency !== po.currency) {
    await db.order.update({ where: { id: po.orderId }, data: { status: 'needs_attention' } });
    return [{ result: 'mismatch', orderId: po.orderId }];
  }
  if (po.status === 'created' && remote.paymentSessionId) {
    await db.paymentOrder.updateMany({ where: { id: po.id, status: 'created' }, data: { status: 'active', paymentSessionId: remote.paymentSessionId } });
  }
  const payments: CashfreePayment[] = await cashfree.getOrderPayments(po.providerOrderId);
  const results: ApplyResult[] = [];
  for (const p of payments) {
    results.push(await applyPaymentEvidence(db, { providerOrderId: po.providerOrderId, cfPaymentId: p.cfPaymentId, providerStatus: p.status, amountMinor: p.amountMinor, currency: p.currency, method: p.method, raw: p.raw }, 'status_api'));
  }
  return results;
}
