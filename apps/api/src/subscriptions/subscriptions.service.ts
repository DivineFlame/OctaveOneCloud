import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, SubscriptionStatus, minorFromDb } from '@ooc/db';
import {
  ScheduledChange,
  SubscriptionError,
  downgradeOptions,
  requestOperatorAction,
  scheduleCancellation,
  scheduleDowngrade,
  withdrawCancellation,
  withdrawScheduledChange,
} from '@ooc/integrations';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';

const include = { org: { select: { id: true, name: true } } } as const;

@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
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

  private async view(s: Awaited<ReturnType<PrismaClient['subscription']['findUniqueOrThrow']>> & { org: { id: string; name: string } }, withOptions: boolean) {
    const price = await this.db.priceVersion.findUniqueOrThrow({ where: { id: s.priceVersionId }, include: { planVersion: { include: { plan: { include: { product: true } } } } } });
    const change = s.scheduledChange as unknown as ScheduledChange | null;
    let scheduled = null;
    if (change) {
      const target = await this.db.priceVersion.findUnique({ where: { id: change.priceVersionId }, include: { planVersion: { include: { plan: true } } } });
      scheduled = { ...change, planName: target?.planVersion.plan.name ?? null, amountMinor: target ? minorFromDb(target.amountMinor) : null };
    }
    const changeable = (s.status === 'active' || s.status === 'trialing') && !s.cancelAtPeriodEnd;
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
      lastLifecycleError: withOptions ? undefined : s.lastLifecycleError,
      downgradeOptions: withOptions && changeable ? await downgradeOptions(this.db, s) : [],
    };
  }
}

function mapError(e: unknown) {
  if (!(e instanceof SubscriptionError)) return e;
  if (e.code === 'not_found') return new NotFoundException();
  if (e.code === 'conflict') return new ConflictException({ error: e.code, message: e.message });
  return new BadRequestException({ error: e.code, message: e.message });
}
