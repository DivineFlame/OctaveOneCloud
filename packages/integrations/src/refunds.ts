import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { SellerProfile, divideRoundHalfUp, redact } from '@ooc/shared';
import { CashfreeClient, PaymentProviderError } from './cashfree/client';
import { CreditNoteError, issueCreditNote } from './invoices';
import { applyRefundStatus } from './payments/processor';

/**
 * Operator-initiated refunds through Cashfree.
 *
 *  - A refund request is not a refund: the row starts `requested` and only provider evidence (API response,
 *    status API or REFUND_* webhook) moves it to pending/success/failed.
 *  - Refundable amount = confirmed successful payments − refunds that are not failed/cancelled, checked under a
 *    row lock, so concurrent requests can never over-refund.
 *  - The provider call carries our refund_id and an idempotency key; after a timeout we look the refund up by
 *    refund_id and only re-send the identical request (same key) if Cashfree has no record of it.
 *  - If asked, a GST credit note is issued once the refund is confirmed (never before money moved).
 * Refunds do not change subscriptions or access; cancel separately if the service should end.
 */

const REFUND_WINDOW_MS = 182 * 86_400_000; // Cashfree: refunds only within six months of the transaction

export class RefundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface RefundRequest {
  orderId: string;
  amountMinor: number;
  reason: string;
  actorId: string;
  /** Issue a credit note on the order's invoice when the refund succeeds. */
  creditNote: boolean;
}

export async function refundableMinor(db: PrismaClient | Prisma.TransactionClient, paymentOrderId: string) {
  const [paid, refunds] = await Promise.all([
    db.paymentAttempt.aggregate({ where: { paymentOrderId, status: 'success' }, _sum: { amountMinor: true } }),
    db.refund.aggregate({ where: { paymentOrderId, status: { notIn: ['failed', 'cancelled'] } }, _sum: { amountMinor: true } }),
  ]);
  return minorFromDb(paid._sum.amountMinor ?? 0n) - minorFromDb(refunds._sum.amountMinor ?? 0n);
}

/** Records the refund (durably, before calling the provider) and submits it. */
export async function requestRefund(db: PrismaClient, cashfree: CashfreeClient, input: RefundRequest, now = new Date()) {
  if (!cashfree.enabled) throw new RefundError('payments_unavailable', 'Cashfree is not configured');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RefundError('invalid_amount', 'Refund amount must be a positive number of paise');

  const refund = await db.$transaction(async (tx) => {
    const pos = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "PaymentOrder" WHERE "orderId" = ${input.orderId}::uuid AND status = 'paid' FOR UPDATE`);
    if (pos.length !== 1) throw new RefundError('not_paid', 'This order has no confirmed payment to refund');
    const po = await tx.paymentOrder.findUniqueOrThrow({ where: { id: pos[0]!.id } });
    if (po.paidAt && now.getTime() - po.paidAt.getTime() > REFUND_WINDOW_MS) throw new RefundError('refund_window_passed', 'Cashfree only refunds within six months of the payment');
    const available = await refundableMinor(tx, po.id);
    if (input.amountMinor > available) throw new RefundError('exceeds_refundable', `At most ${available} paise can be refunded`);

    let creditNoteInvoiceId: string | null = null;
    if (input.creditNote) {
      const invoice = await tx.invoice.findUnique({ where: { orderId: input.orderId } });
      if (!invoice?.number) throw new RefundError('no_invoice', 'The order has no issued invoice to credit');
      creditNoteInvoiceId = invoice.id;
    }
    const created = await tx.refund.create({
      data: {
        paymentOrderId: po.id,
        refundRequestId: `r${randomUUID().replace(/-/g, '')}`,
        amountMinor: BigInt(input.amountMinor),
        status: 'requested',
        reason: input.reason,
        requestedById: input.actorId,
        creditNoteInvoiceId,
      },
    });
    await tx.auditEvent.create({
      data: { actorId: input.actorId, actorType: 'operator', orgId: po.orgId, action: 'refund.requested', targetType: 'order', targetId: input.orderId, metadata: { refundId: created.id, amountMinor: input.amountMinor, creditNote: input.creditNote } },
    });
    return created;
  });

  await submitRefund(db, cashfree, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Sends (or re-sends, identically) a requested refund to Cashfree. */
async function submitRefund(db: PrismaClient, cashfree: CashfreeClient, refundId: string) {
  const r = await db.refund.findUniqueOrThrow({ where: { id: refundId }, include: { paymentOrder: true } });
  try {
    const res = await cashfree.createRefund({ orderId: r.paymentOrder.providerOrderId, refundId: r.refundRequestId, amountMinor: minorFromDb(r.amountMinor), note: r.reason, idempotencyKey: r.id });
    await db.refund.update({ where: { id: r.id }, data: { lastError: null } });
    return applyRefundStatus(db, r.refundRequestId, res.status, res.cfRefundId, res.raw);
  } catch (e) {
    if (e instanceof PaymentProviderError && e.kind === 'unknown_outcome') {
      // Stays `requested`; the sweeper looks it up by refund_id before anything is re-sent.
      await db.refund.update({ where: { id: r.id }, data: { lastError: `unknown outcome: ${e.message}` } });
      return 'refund_unknown_outcome';
    }
    if (e instanceof PaymentProviderError && e.kind === 'http') {
      // Rejected by Cashfree (validation, insufficient balance, …): definitely not created.
      await db.refund.updateMany({ where: { id: r.id, status: 'requested' }, data: { status: 'failed', lastError: e.message, providerPayload: redact(e.details ?? null) as Prisma.InputJsonValue } });
      return 'refund_rejected';
    }
    throw e;
  }
}

/** Brings requested/pending refunds up to date from the status API (missing webhooks, timeouts). */
export async function reconcileRefunds(db: PrismaClient, cashfree: CashfreeClient, now = new Date(), olderThanMs = 5 * 60_000) {
  if (!cashfree.enabled) return [];
  const due = await db.refund.findMany({
    where: { status: { in: ['requested', 'pending'] }, updatedAt: { lt: new Date(now.getTime() - olderThanMs) } },
    include: { paymentOrder: true },
    take: 50,
    orderBy: { updatedAt: 'asc' },
  });
  const out: { refundId: string; result: string }[] = [];
  for (const r of due) {
    try {
      const res = await cashfree.getRefund(r.paymentOrder.providerOrderId, r.refundRequestId);
      out.push({ refundId: r.id, result: await applyRefundStatus(db, r.refundRequestId, res.status, res.cfRefundId, res.raw) });
      await db.refund.update({ where: { id: r.id }, data: { updatedAt: now } });
    } catch (e) {
      if (e instanceof PaymentProviderError && e.kind === 'http' && r.status === 'requested' && /HTTP 404/.test(e.message)) {
        // Cashfree never received it (the earlier call timed out before reaching them): send the identical request.
        out.push({ refundId: r.id, result: await submitRefund(db, cashfree, r.id) });
      } else {
        await db.refund.update({ where: { id: r.id }, data: { lastError: (e as Error).message.slice(0, 500), updatedAt: now } });
        out.push({ refundId: r.id, result: 'error' });
      }
    }
  }
  return out;
}

/** Issues the requested GST credit notes for confirmed refunds (idempotent: one credit note per refund). */
export async function creditConfirmedRefunds(db: PrismaClient, seller: SellerProfile) {
  const ids = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT r.id FROM "Refund" r
    WHERE r.status = 'success' AND r."creditNoteInvoiceId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "CreditNote" c WHERE c."refundId" = r.id)
    ORDER BY r."updatedAt" LIMIT 50`);
  const due = await db.refund.findMany({ where: { id: { in: ids.map((i) => i.id) } } });
  const out: { refundId: string; creditNoteId?: string; error?: string }[] = [];
  for (const r of due) {
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: r.creditNoteInvoiceId! } });
    // The refund is gross (incl. GST); credit the taxable share in the invoice's proportion.
    const total = minorFromDb(invoice.totalMinor);
    const taxable = total === 0 ? 0 : divideRoundHalfUp(minorFromDb(r.amountMinor) * minorFromDb(invoice.subtotalMinor), total);
    try {
      const cn = await issueCreditNote(db, { invoiceId: invoice.id, taxableMinor: taxable, reason: `Refund: ${r.reason}`.slice(0, 500), refundId: r.id, actorId: r.requestedById ?? undefined }, seller);
      out.push({ refundId: r.id, creditNoteId: cn.id });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // issued concurrently
      const error = e instanceof CreditNoteError ? e.message : (e as Error).message;
      await db.refund.update({ where: { id: r.id }, data: { lastError: `credit note: ${error}`.slice(0, 500) } });
      out.push({ refundId: r.id, error });
    }
  }
  return out;
}
