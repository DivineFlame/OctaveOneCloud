import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaClient, minorFromDb } from '@ooc/db';
import { costDrift, latestSnapshot } from '@ooc/integrations';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../common/audit.service';
import { Queues } from '../common/queue.module';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';

const SyncBody = z.object({ kind: z.enum(['cost', 'customer', 'both']).default('both') }).strict();
const CATEGORIES = ['domain', 'hosting', 'server', 'email', 'certificate', 'addon', 'other'] as const;

/** ResellerClub price lists (cost and selling) for finance operators. Read-only towards ResellerClub. */
@OperatorOnly('operator_finance', 'operator_admin')
@Controller('admin/supplier-prices')
export class SupplierPricesController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  /** Snapshots of the configured environment; while disabled, the most recent of any environment (labelled). */
  private env() {
    return this.config.RESELLERCLUB_ENV === 'disabled' ? undefined : this.config.RESELLERCLUB_ENV;
  }

  @Get('status')
  async status() {
    const env = this.env();
    const [cost, customer] = await Promise.all([latestSnapshot(this.db, 'cost', env), latestSnapshot(this.db, 'customer', env)]);
    const meta = (s: Awaited<ReturnType<typeof latestSnapshot>>) => (s ? { id: s.id, environment: s.environment, fetchedAt: s.fetchedAt, checkedAt: s.checkedAt, itemCount: s.itemCount, skippedCount: s.skippedCount, changedCount: s.changedCount, currency: s.currency } : null);
    return {
      enabled: env !== undefined,
      environment: this.config.RESELLERCLUB_ENV,
      currency: this.config.RESELLERCLUB_CURRENCY,
      syncEveryHours: this.config.RESELLERCLUB_PRICE_SYNC_HOURS,
      cost: meta(cost),
      customer: meta(customer),
      costChangesOnSale: env ? await costDrift(this.db, env) : [],
    };
  }

  /** Latest price list with cost and selling price side by side where both exist for the same item. */
  @Get()
  async list(@Query('q') q?: string, @Query('category') category?: string, @Query('take') take?: string) {
    const env = this.env();
    const [cost, customer] = await Promise.all([latestSnapshot(this.db, 'cost', env), latestSnapshot(this.db, 'customer', env)]);
    const base = cost ?? customer;
    if (!base) return { items: [], total: 0 };
    const cat = z.enum(CATEGORIES).safeParse(category);
    const search = q?.trim().toLowerCase().slice(0, 60);
    const where = { snapshotId: base.id, ...(cat.success ? { category: cat.data } : {}), ...(search ? { OR: [{ productKey: { contains: search } }, { ref: { contains: search } }] } : {}) };
    const n = Math.min(Math.max(Number(take) || 200, 1), 1000);
    const [rows, total] = await Promise.all([this.db.supplierPrice.findMany({ where, orderBy: { ref: 'asc' }, take: n }), this.db.supplierPrice.count({ where })]);
    const other = base === cost && customer ? new Map((await this.db.supplierPrice.findMany({ where: { snapshotId: customer.id, ref: { in: rows.map((r) => r.ref) } } })).map((r) => [r.ref, minorFromDb(r.amountMinor)])) : new Map<string, number>();
    return {
      basis: base === cost ? 'cost' : 'customer',
      environment: base.environment,
      currency: base.currency,
      total,
      items: rows.map((r) => {
        const amount = minorFromDb(r.amountMinor);
        const selling = base === cost ? (other.get(r.ref) ?? null) : amount;
        const costMinor = base === cost ? amount : null;
        return {
          ref: r.ref,
          productKey: r.productKey,
          category: r.category,
          plan: r.plan,
          action: r.action,
          term: r.term,
          termUnit: r.termUnit,
          costMinor,
          sellingMinor: selling,
          marginBps: costMinor !== null && selling ? Math.round(((selling - costMinor) / selling) * 10_000) : null,
        };
      }),
    };
  }

  /** Queues a refresh on the worker (large responses take a while); the page shows progress via `status`. */
  @HttpCode(202)
  @Post('sync')
  async sync(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(SyncBody)) body: z.infer<typeof SyncBody>) {
    const kinds = body.kind === 'both' ? (['cost', 'customer'] as const) : ([body.kind] as const);
    for (const kind of kinds) await this.queues.supplier.add('price-sync', { kind, actorId: a.user.id }, { jobId: `price-sync-${kind}-manual-${Date.now()}` });
    await this.audit.record({ actorId: a.user.id, actorType: 'operator', action: 'supplier.prices_sync_requested', targetType: 'supplier', targetId: 'resellerclub', metadata: { kinds } });
    return { queued: kinds, enabled: this.config.RESELLERCLUB_ENV !== 'disabled' };
  }
}
