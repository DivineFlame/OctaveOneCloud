import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaClient, RefundStatus, minorFromDb } from '@ooc/db';
import { CashfreeClient, RefundError, refundableMinor, requestRefund } from '@ooc/integrations';
import { REFUND_STATUSES } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { PRISMA } from '../common/prisma.module';
import { CASHFREE } from '../providers/providers.module';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';

const RefundBody = z.object({
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(3).max(200),
  creditNote: z.boolean().default(true),
}).strict();

const view = (r: { id: string; refundRequestId: string; providerRefundId: string | null; amountMinor: bigint; status: string; reason: string; lastError: string | null; creditNoteInvoiceId: string | null; createdAt: Date; updatedAt: Date }) => ({
  id: r.id,
  refundRequestId: r.refundRequestId,
  providerRefundId: r.providerRefundId,
  amountMinor: minorFromDb(r.amountMinor),
  status: r.status,
  reason: r.reason,
  lastError: r.lastError,
  creditNote: r.creditNoteInvoiceId !== null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Refunds are initiated by finance operators only (MFA enforced by the session guard), and audited. */
@OperatorOnly('operator_finance')
@Controller('admin')
export class RefundsAdminController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(CASHFREE) private readonly cashfree: CashfreeClient,
  ) {}

  @Get('orders/:orderId/payments')
  async payments(@Param('orderId', ParseUUIDPipe) orderId: string) {
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: { paymentOrders: { include: { attempts: { where: { status: 'success' } }, refunds: { orderBy: { createdAt: 'desc' } } } } } });
    if (!order) throw new NotFoundException();
    const paid = order.paymentOrders.find((p) => p.status === 'paid');
    return {
      orderId,
      status: order.status,
      paidMinor: paid ? paid.attempts.reduce((a, x) => a + minorFromDb(x.amountMinor), 0) : 0,
      refundableMinor: paid ? await refundableMinor(this.db, paid.id) : 0,
      refunds: order.paymentOrders.flatMap((p) => p.refunds).map(view),
    };
  }

  @Post('orders/:orderId/refunds')
  async refund(@Param('orderId', ParseUUIDPipe) orderId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(RefundBody)) body: z.infer<typeof RefundBody>) {
    try {
      return view(await requestRefund(this.db, this.cashfree, { orderId, ...body, actorId: a.user.id }));
    } catch (e) {
      if (e instanceof RefundError) {
        if (e.code === 'payments_unavailable') throw new ServiceUnavailableException({ error: e.code });
        throw new BadRequestException({ error: e.code, message: e.message });
      }
      throw e;
    }
  }

  @Get('refunds')
  async list(@Query('status') status?: string) {
    const st = z.enum(REFUND_STATUSES).safeParse(status);
    const rows = await this.db.refund.findMany({
      where: st.success ? { status: st.data as RefundStatus } : {},
      include: { paymentOrder: { select: { orderId: true, org: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({ ...view(r), orderId: r.paymentOrder.orderId, org: r.paymentOrder.org }));
  }
}
