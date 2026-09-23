import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaClient, Prisma } from '@ooc/db';
import { AppConfig, appEnv } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../common/audit.service';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';
import { RESELLERCLUB_CAPABILITIES } from '@ooc/integrations';

const Resolve = z.object({ outcome: z.enum(['succeeded', 'failed']), providerRef: z.string().max(200).optional(), note: z.string().min(5).max(2000) });
const take = (v?: string) => Math.min(Math.max(Number(v) || 50, 1), 200);

@OperatorOnly()
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /** Integration health without exposing any secret values. */
  @Get('integrations')
  async integrations() {
    return {
      appEnv: appEnv(this.config),
      resellerclub: { env: this.config.RESELLERCLUB_ENV, liveMutationsAllowed: this.config.RESELLERCLUB_ALLOW_LIVE_MUTATIONS, capabilities: RESELLERCLUB_CAPABILITIES },
      cashfree: { env: this.config.CASHFREE_ENV, apiVersion: this.config.CASHFREE_API_VERSION, webhookSecretConfigured: Boolean(this.config.CASHFREE_WEBHOOK_SECRET), subscriptionsEnabled: this.config.CASHFREE_SUBSCRIPTIONS_ENABLED },
      smtpConfigured: Boolean(this.config.SMTP_URL),
      objectStorageConfigured: Boolean(this.config.S3_BUCKET),
      modelGatewayConfigured: Boolean(this.config.MODEL_GATEWAY_URL),
      adapters: await this.db.appAdapter.findMany({ orderBy: { key: 'asc' } }),
    };
  }

  @Get('webhooks')
  webhooks(@Query('status') status?: string, @Query('take') t?: string) {
    return this.db.webhookInbox.findMany({
      where: status ? { status: status as Prisma.EnumInboxStatusFilter['equals'] } : undefined,
      orderBy: { receivedAt: 'desc' },
      take: take(t),
      select: { id: true, provider: true, channel: true, eventType: true, status: true, attempts: true, lastError: true, receivedAt: true, processedAt: true },
    });
  }

  @Get('provisioning')
  provisioning(@Query('status') status?: string, @Query('take') t?: string) {
    return this.db.provisioningJob.findMany({
      where: status ? { status: status as Prisma.EnumProvisioningStatusFilter['equals'] } : { status: { in: ['failed', 'partially_failed', 'unknown_outcome'] } },
      orderBy: { updatedAt: 'desc' },
      take: take(t),
      include: { steps: true },
    });
  }

  @Get('supplier-operations')
  supplierOps(@Query('status') status?: string, @Query('take') t?: string) {
    return this.db.supplierOperation.findMany({
      where: status ? { status: status as Prisma.EnumSupplierOperationStatusFilter['equals'] } : { status: { in: ['unknown', 'failed', 'sent'] } },
      orderBy: { updatedAt: 'desc' },
      take: take(t),
    });
  }

  /** Operator recovery path for unknown supplier outcomes, after checking the supplier panel/records. */
  @OperatorOnly('operator_admin')
  @Post('supplier-operations/:id/resolve')
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Resolve)) body: z.infer<typeof Resolve>, @CurrentAuth() a: AuthContext) {
    const op = await this.db.supplierOperation.findUnique({ where: { id } });
    if (!op) throw new NotFoundException();
    if (!['unknown', 'sent', 'failed'].includes(op.status)) throw new BadRequestException({ error: 'operation_not_resolvable', status: op.status });
    const updated = await this.db.supplierOperation.update({
      where: { id },
      data: { status: body.outcome === 'succeeded' ? 'reconciled' : 'failed', providerRef: body.providerRef ?? op.providerRef, lastError: body.outcome === 'failed' ? `operator: ${body.note}` : op.lastError },
    });
    await this.audit.record({ actorId: a.user.id, actorType: 'operator', action: 'supplier.operation_resolved', targetType: 'supplierOperation', targetId: id, metadata: { outcome: body.outcome, note: body.note } });
    return updated;
  }

  @Get('audit')
  auditLog(@Query('orgId') orgId?: string, @Query('take') t?: string) {
    return this.db.auditEvent.findMany({ where: orgId ? { orgId } : undefined, orderBy: { createdAt: 'desc' }, take: take(t) });
  }

  @Get('orders')
  orders(@Query('status') status?: string, @Query('take') t?: string) {
    return this.db.order.findMany({
      where: status ? { status: status as Prisma.EnumOrderStatusFilter['equals'] } : { status: { in: ['needs_attention', 'delayed'] } },
      orderBy: { updatedAt: 'desc' },
      take: take(t),
      include: { paymentOrders: { include: { attempts: true } } },
    });
  }
}
