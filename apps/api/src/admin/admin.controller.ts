import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaClient, Prisma } from '@ooc/db';
import { AppConfig, appEnv } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../common/audit.service';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';
import { RESELLERCLUB_CAPABILITIES, launchReadiness } from '@ooc/integrations';

const Resolve = z.object({ outcome: z.enum(['succeeded', 'failed']), providerRef: z.string().max(200).optional(), note: z.string().min(5).max(2000) });
const AdapterStatusBody = z.object({ status: z.enum(['unconfigured', 'sandbox', 'active', 'disabled']), note: z.string().trim().min(3).max(500), name: z.string().trim().min(2).max(80).optional() }).strict();
const take = (v?: string) => Math.min(Math.max(Number(v) || 50, 1), 200);

@OperatorOnly()
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /** Launch readiness: automated checks plus the manual launch gates (no secret values). */
  @OperatorOnly('operator_admin')
  @Get('readiness')
  readiness() {
    return launchReadiness(this.db, this.config);
  }

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

  /**
   * Sets an app adapter's status. `sandbox`/`active` require APP_ADAPTER_<NAME>_URL and _SECRET (≥ 32 chars) in the
   * environment (the worker reads the same file); `active` in production also requires an https URL. Audited.
   */
  @OperatorOnly('operator_admin')
  @Post('adapters/:key/status')
  async adapterStatus(@Param('key') key: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(AdapterStatusBody)) body: z.infer<typeof AdapterStatusBody>) {
    const m = /^app\.([a-z0-9_]{1,40})$/.exec(key);
    if (!m) throw new BadRequestException({ error: 'invalid_adapter_key', message: 'Adapter keys look like app.<name> (APP_ADAPTER_<NAME>_URL)' });
    const envName = m[1]!.toUpperCase();
    const url = process.env[`APP_ADAPTER_${envName}_URL`]?.trim();
    const secret = process.env[`APP_ADAPTER_${envName}_SECRET`] ?? '';
    if (body.status === 'sandbox' || body.status === 'active') {
      const missing = [!url && `APP_ADAPTER_${envName}_URL`, secret.length < 32 && `APP_ADAPTER_${envName}_SECRET (≥ 32 characters)`].filter(Boolean);
      if (missing.length) throw new BadRequestException({ error: 'adapter_not_configured', message: `Set ${missing.join(' and ')} in the environment and redeploy first` });
      if (body.status === 'active' && this.config.NODE_ENV === 'production' && !url!.startsWith('https://')) {
        throw new BadRequestException({ error: 'adapter_url_not_https', message: 'Active adapters must use an https URL' });
      }
    }
    const before = await this.db.appAdapter.findUnique({ where: { key } });
    const row = await this.db.appAdapter.upsert({
      where: { key },
      update: { status: body.status, baseUrl: url ?? null, authRef: `APP_ADAPTER_${envName}_SECRET`, ...(body.name ? { name: body.name } : {}) },
      create: { key, name: body.name ?? key, status: body.status, baseUrl: url ?? null, authRef: `APP_ADAPTER_${envName}_SECRET` },
    });
    await this.audit.record({ actorId: a.user.id, actorType: 'operator', action: 'adapter.status_changed', targetType: 'adapter', targetId: key, metadata: { from: before?.status ?? null, to: body.status, note: body.note } });
    return row;
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
