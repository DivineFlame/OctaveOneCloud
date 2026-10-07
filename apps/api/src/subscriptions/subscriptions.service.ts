import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, SubscriptionStatus, minorFromDb } from '@ooc/db';
import {
  ScheduledChange,
  SubscriptionError,
  UpgradeError,
  createUpgradeOrder,
  downgradeOptions,
  previewUpgrade,
  requestOperatorAction,
  scheduleCancellation,
  scheduleDowngrade,
  withdrawCancellation,
  withdrawScheduledChange,
} from '@ooc/integrations';
import { PRISMA } from '../common/prisma.module';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '@ooc/shared';
import { AuditService } from '../common/audit.service';

const include = { org: { select: { id: true, name: true } } } as const;

@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string) {
    const subs = await this.db.subscription.findMany({ where: { orgId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], include });
    return Promise.all(subs.map((s) => this.view(s, true)));
  }

  async cancel(orgId: string, id: string, actorId: string) {
    return this.run(orgId, id, actorId, 'subscription.cancel_scheduled', () => scheduleCancellation(this.db, orgId, id));
  }

  async keep(orgId: string, id: string, actorId: string) {
    return this.run(orgId, id, actorId, 'subscription.cancel_withdrawn', () => withdrawCancellation(this.db, orgId, id));
  }

  async downgrade(orgId: string, id: string, actorId: string, input: { priceVersionId: string; quantity: number }) {
    return this.run(orgId, id, actorId, 'subscription.downgrade_scheduled', () => scheduleDowngrade(this.db, { orgId, subscriptionId: id, ...input, actorId }), input);
  }

  async withdrawChange(orgId: string, id: string, actorId: string) {
    return this.run(orgId, id, actorId, 'subscription.change_withdrawn', () => withdrawScheduledChange(this.db, orgId, id));
  }

  async upgradePreview(orgId: string, id: string, input: { priceVersionId: string; quantity: number }) {
    try {
      return await previewUpgrade(this.db, { orgId, subscriptionId: id, ...input });
    } catch (e) {
      throw mapError(e);
    }
  }

  /** Creates the prorated upgrade order; the customer then pays it via POST /orders/:orderId/pay. */
  async upgrade(orgId: string, id: string, actorId: string, input: { priceVersionId: string; quantity: number }) {
    try {
      return await createUpgradeOrder(this.db, { orgId, subscriptionId: id, ...input, actorId, sellerStateCode: this.config.SELLER_STATE_CODE });
    } catch (e) {
      throw mapError(e);
    }
  }

  // ── Operator ──

  async adminList(q: { status?: SubscriptionStatus; orgId?: string; attention?: boolean }) {
    const subs = await this.db.subscription.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.orgId ? { orgId: q.orgId } : {}), ...(q.attention ? { lastLifecycleError: { not: null } } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include,
    });
    return Promise.all(subs.map((s) => this.view(s, false)));
  }

  async operatorAction(id: string, actorId: string, action: 'suspend' | 'resume', reason: string) {
    try {
      const s = await requestOperatorAction(this.db, id, action, reason);
      await this.audit.record({ actorId, actorType: 'operator', orgId: s.orgId, action: `subscription.${action}_requested`, targetType: 'subscription', targetId: id, metadata: { reason } });
      return this.view({ ...s, org: await this.db.organization.findUniqueOrThrow({ where: { id: s.orgId }, select: { id: true, name: true } }) }, false);
    } catch (e) {
      throw mapError(e);
    }
  }

  private async run<T extends { id: string; orgId: string }>(orgId: string, id: string, actorId: string, action: string, fn: () => Promise<T>, metadata?: Record<string, unknown>) {
    try {
      const s = await fn();
      await this.audit.record({ actorId, actorType: 'user', orgId, action, targetType: 'subscription', targetId: id, metadata });
      const full = await this.db.subscription.findUniqueOrThrow({ where: { id: s.id }, include });
      return this.view(full, true);
    } catch (e) {
      throw mapError(e);
    }
  }

  /** Higher-priced published plans of the same product and term. */
  private async upgradeOptions(priceVersionId: string) {
    const now = new Date();
    const current = await this.db.priceVersion.findUniqueOrThrow({ where: { id: priceVersionId }, include: { planVersion: { include: { plan: true } } } });
    const rows = await this.db.priceVersion.findMany({
      where: {
        kind: 'subscription', currency: current.currency, billingInterval: current.billingInterval, amountMinor: { gt: current.amountMinor },
        effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        planVersion: { publishedAt: { not: null }, retiredAt: null, plan: { productId: current.planVersion.plan.productId, product: { status: 'active' } } },
      },
      include: { planVersion: { include: { plan: true } } },
      orderBy: { amountMinor: 'asc' },
    });
    return rows.map((p) => ({ priceVersionId: p.id, planName: p.planVersion.plan.name, amountMinor: minorFromDb(p.amountMinor), billingInterval: p.billingInterval }));
  }

  private async view(s: Awaited<ReturnType<PrismaClient['subscription']['findUniqueOrThrow']>> & { org: { id: string; name: string } }, withOptions: boolean) {
    const price = await this.db.priceVersion.findUniqueOrThrow({ where: { id: s.priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } });
    const change = s.scheduledChange as unknown as ScheduledChange | null;
    let scheduled = null;
    if (change) {
      const target = await this.db.priceVersion.findUnique({ where: { id: change.priceVersionId }, include: { planVersion: { include: { plan: true } } } });
      scheduled = { ...change, planName: target?.planVersion.plan.name ?? null, amountMinor: target ? minorFromDb(target.amountMinor) : null };
    }
    const changeable = (s.status === 'active' || s.status === 'trialing') && !s.cancelAtPeriodEnd;
    const run = await this.db.renewalRun.findFirst({ where: { subscriptionId: s.id, status: 'pending' }, orderBy: { periodStart: 'desc' } });
    const renewalOrder = run?.orderId ? await this.db.order.findUnique({ where: { id: run.orderId }, select: { id: true, status: true, totalMinor: true } }) : null;
    const renewal = run
      ? {
          dueAt: run.periodStart,
          graceEndsAt: s.graceEndsAt,
          orderId: renewalOrder?.status === 'awaiting_payment' ? renewalOrder.id : null,
          totalMinor: renewalOrder ? minorFromDb(renewalOrder.totalMinor) : null,
          // Shown to the customer only when they can fix it (billing details); operators see the raw error.
          problem: run.lastError ? (run.lastError.startsWith('billing_details_required') ? 'billing_details_required' : withOptions ? 'renewal_not_ready' : run.lastError) : null,
        }
      : null;
    return {
      id: s.id,
      org: s.org,
      status: s.status,
      product: { key: price.planVersion.plan.product.key, name: price.planVersion.plan.product.name },
      plan: { name: price.planVersion.plan.name, tier: price.planVersion.plan.tier, planVersionId: s.planVersionId },
      priceVersionId: s.priceVersionId,
      amountMinor: minorFromDb(price.amountMinor),
      billingInterval: price.billingInterval,
      quantity: s.quantity,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      scheduledChange: scheduled,
      suspendedAt: s.suspendedAt,
      cancelledAt: s.cancelledAt,
      pendingAction: s.pendingAction,
      suspensionReason: s.suspensionReason,
      renewal,
      lastLifecycleError: withOptions ? undefined : s.lastLifecycleError,
      downgradeOptions: withOptions && changeable ? await downgradeOptions(this.db, s) : [],
      upgradeOptions: withOptions && changeable && !s.scheduledChange && !s.pendingAction ? await this.upgradeOptions(s.priceVersionId) : [],
    };
  }
}

function mapError(e: unknown) {
  if (!(e instanceof SubscriptionError) && !(e instanceof UpgradeError)) return e;
  if (e.code === 'not_found') return new NotFoundException();
  if (e.code === 'conflict') return new ConflictException({ error: e.code, message: e.message });
  return new BadRequestException({ error: e.code, message: e.message });
}
