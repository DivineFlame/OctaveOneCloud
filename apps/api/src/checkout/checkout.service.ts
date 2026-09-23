import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient, isUniqueViolation, minorFromDb } from '@ooc/db';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';
import { Queues } from '../common/queue.module';
import { CASHFREE } from '../providers/providers.module';
import { CashfreeClient, PaymentProviderError } from '@ooc/integrations';

/**
 * Stage 2: one-time payment for an accepted quote via Cashfree hosted checkout.
 * Order totals come from the frozen quote; the browser only receives a payment_session_id.
 * Fulfilment starts only from server-side payment evidence (signed webhook or status API).
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CASHFREE) private readonly cashfree: CashfreeClient,
    private readonly audit: AuditService,
    private readonly queues: Queues,
  ) {}

  async checkout(orgId: string, quoteId: string, actor: { id: string; email: string }, input: { idempotencyKey: string; phone: string }) {
    if (!this.cashfree.enabled) throw new ServiceUnavailableException({ error: 'payments_unavailable' });
    const quote = await this.db.quote.findFirst({ where: { id: quoteId, orgId }, include: { lines: true } });
    if (!quote) throw new NotFoundException();

    // Idempotent replay: same key returns the same order.
    const existing = await this.db.order.findUnique({ where: { orgId_idempotencyKey: { orgId, idempotencyKey: input.idempotencyKey } }, include: { paymentOrders: true } });
    if (existing) return this.present(existing.id, orgId);

    if (quote.status !== 'accepted') throw new ConflictException({ error: 'quote_not_accepted' });
    if (quote.expiresAt <= new Date()) throw new ConflictException({ error: 'quote_expired' });
    const groups = new Set(quote.lines.map((l) => l.billingInterval));
    if (groups.size > 1) throw new BadRequestException({ error: 'mixed_terms_require_separate_checkout' });

    let orderId: string;
    let paymentOrderId: string;
    try {
      const created = await this.db.$transaction(async (tx) => {
        const converted = await tx.quote.updateMany({ where: { id: quote.id, status: 'accepted' }, data: { status: 'converted' } });
        if (converted.count !== 1) throw new ConflictException({ error: 'quote_already_converted' });
        const order = await tx.order.create({
          data: {
            orgId,
            quoteId: quote.id,
            status: 'awaiting_payment',
            totalMinor: quote.totalMinor,
            idempotencyKey: input.idempotencyKey,
            items: { create: quote.lines.map((l) => ({ priceVersionId: l.priceVersionId, quantity: l.quantity, totalMinor: l.totalMinor, configuration: l.configuration ?? undefined })) },
          },
        });
        const po = await tx.paymentOrder.create({
          data: { orgId, orderId: order.id, environment: this.config.CASHFREE_ENV, providerOrderId: `ooc-${order.id}`, amountMinor: quote.totalMinor, currency: quote.currency },
        });
        return { order, po };
      });
      orderId = created.order.id;
      paymentOrderId = created.po.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const replay = await this.db.order.findUnique({ where: { orgId_idempotencyKey: { orgId, idempotencyKey: input.idempotencyKey } } });
        if (replay) return this.present(replay.id, orgId);
      }
      throw e;
    }

    const po = await this.db.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
    try {
      const cf = await this.cashfree.createOrder({
        orderId: po.providerOrderId,
        amountMinor: minorFromDb(po.amountMinor),
        currency: 'INR',
        customer: { id: orgId.replace(/-/g, ''), email: actor.email, phone: input.phone },
        returnUrl: `${this.config.APP_URL}/dashboard/orders/${orderId}?provider_order_id={order_id}`,
        notifyUrl: `${this.config.API_URL}/v1/webhooks/cashfree/pg`,
      });
      await this.db.paymentOrder.update({ where: { id: po.id }, data: { status: 'active', paymentSessionId: cf.paymentSessionId } });
    } catch (e) {
      if (e instanceof PaymentProviderError && e.kind === 'unknown_outcome') {
        // The provider may have created the order; reconciliation fetches it by our order id.
        await this.queues.reconcile.add('payment-order', { paymentOrderId: po.id }, { jobId: `po-create-${po.id}`, delay: 15_000 });
        this.logger.warn(`Cashfree order creation outcome unknown for ${po.id}; reconciliation scheduled`);
        throw new ServiceUnavailableException({ error: 'payment_provider_timeout', orderId });
      }
      await this.db.order.update({ where: { id: orderId }, data: { status: 'needs_attention' } });
      throw e;
    }
    await this.audit.record({ actorId: actor.id, actorType: 'user', orgId, action: 'checkout.started', targetType: 'order', targetId: orderId });
    return this.present(orderId, orgId);
  }

  async present(orderId: string, orgId: string) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, orgId },
      include: { items: { include: { provisioningJobs: { select: { id: true, status: true, adapterKey: true, updatedAt: true } } } }, paymentOrders: { select: { id: true, status: true, paymentSessionId: true, environment: true, providerOrderId: true } } },
    });
    if (!order) throw new NotFoundException();
    const po = order.paymentOrders.find((p) => p.status !== 'terminated' && p.status !== 'expired');
    return {
      id: order.id,
      status: order.status,
      totalMinor: order.totalMinor,
      currency: order.currency,
      paidAt: order.paidAt,
      payment: po ? { status: po.status, paymentSessionId: po.status === 'active' ? po.paymentSessionId : null, mode: po.environment } : null,
      items: order.items.map((i) => ({ id: i.id, quantity: i.quantity, totalMinor: i.totalMinor, provisioning: i.provisioningJobs })),
    };
  }

  /** Asks the worker to reconcile a payment order with Cashfree's status API (missing webhooks). */
  async requestReconcile(orgId: string, orderId: string) {
    const po = await this.db.paymentOrder.findFirst({ where: { orderId, orgId } });
    if (!po) throw new NotFoundException();
    await this.queues.reconcile.add('payment-order', { paymentOrderId: po.id }, { jobId: `po-${po.id}-${Math.floor(Date.now() / 30_000)}` });
    return { queued: true };
  }
}
