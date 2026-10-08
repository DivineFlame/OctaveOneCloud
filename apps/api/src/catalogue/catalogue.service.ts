import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, PriceKind } from '@ooc/db';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';
import { COST_SOURCE_PREFIX, currentSupplierCost, isCapabilityVerified } from '@ooc/integrations';

const ISO_DURATION = /^P(\d+Y)?(\d+M)?(\d+D)?$/;

@Injectable()
export class CatalogueService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /** Public catalogue: only active products, published plan versions and currently effective prices. */
  async publicCatalogue() {
    const now = new Date();
    const products = await this.db.product.findMany({
      where: { status: 'active' },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
      include: {
        plans: {
          include: {
            versions: {
              where: { publishedAt: { not: null, lte: now }, retiredAt: null },
              orderBy: { version: 'desc' },
              take: 1,
              include: {
                features: { include: { feature: true } },
                prices: { where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } },
              },
            },
          },
        },
      },
    });
    return products.map((p) => ({
      key: p.key,
      name: p.name,
      family: p.family,
      description: p.description,
      plans: p.plans
        .filter((pl) => pl.versions.length > 0)
        .map((pl) => {
          const v = pl.versions[0]!;
          return {
            key: pl.key,
            name: pl.name,
            tier: pl.tier,
            planVersionId: v.id,
            trialDays: v.trialDays,
            supportLevel: v.supportLevel,
            features: v.features.map((f) => ({ key: f.featureKey, name: f.feature.name, unit: f.feature.unit, limit: f.limit })),
            // costMinor is internal and never exposed publicly.
            prices: v.prices.map((pr) => ({ id: pr.id, kind: pr.kind, currency: pr.currency, billingInterval: pr.billingInterval, amountMinor: pr.amountMinor, setupFeeMinor: pr.setupFeeMinor, isPremium: pr.isPremium })),
          };
        }),
    }));
  }

  adminList() {
    return this.db.product.findMany({
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
      include: { plans: { include: { versions: { include: { features: true, prices: true }, orderBy: { version: 'asc' } } } } },
    });
  }

  async createPlanVersion(planId: string, actorId: string) {
    const plan = await this.db.plan.findUnique({ where: { id: planId }, include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { features: true } } } });
    if (!plan) throw new NotFoundException();
    const latest = plan.versions[0];
    const version = await this.db.planVersion.create({
      data: {
        planId,
        version: (latest?.version ?? 0) + 1,
        trialDays: latest?.trialDays ?? 0,
        supportLevel: latest?.supportLevel,
        features: latest ? { create: latest.features.map((f) => ({ featureKey: f.featureKey, limit: f.limit })) } : undefined,
      },
    });
    await this.audit.record({ actorId, actorType: 'operator', action: 'catalogue.plan_version_created', targetType: 'planVersion', targetId: version.id });
    return version;
  }

  async setFeatures(planVersionId: string, features: { featureKey: string; limit: number | null }[], actorId: string) {
    const v = await this.db.planVersion.findUnique({ where: { id: planVersionId } });
    if (!v) throw new NotFoundException();
    if (v.publishedAt) throw new ConflictException({ error: 'plan_version_published_immutable' });
    await this.db.$transaction([
      this.db.planFeature.deleteMany({ where: { planVersionId } }),
      this.db.planFeature.createMany({ data: features.map((f) => ({ planVersionId, featureKey: f.featureKey, limit: f.limit === null ? null : BigInt(f.limit) })) }),
    ]);
    await this.audit.record({ actorId, actorType: 'operator', action: 'catalogue.features_set', targetType: 'planVersion', targetId: planVersionId, metadata: { count: features.length } });
    return this.db.planFeature.findMany({ where: { planVersionId } });
  }

  async addPrice(
    planVersionId: string,
    input: { kind: PriceKind; currency: 'INR'; billingInterval: string; amountMinor: number; setupFeeMinor: number; costMinor: number | null; costSource: string | null; supplierCostRef?: string; isPremium: boolean; effectiveFrom?: Date },
    actorId: string,
  ) {
    if (input.supplierCostRef) {
      if (this.config.RESELLERCLUB_ENV === 'disabled') throw new BadRequestException({ error: 'resellerclub_disabled', message: 'Enable ResellerClub (demo or live) to use supplier costs' });
      const cost = await currentSupplierCost(this.db, input.supplierCostRef, this.config.RESELLERCLUB_ENV);
      if (!cost) throw new BadRequestException({ error: 'supplier_cost_not_found', message: 'No such item in the latest ResellerClub cost snapshot — sync prices first' });
      if (cost.currency !== input.currency) throw new BadRequestException({ error: 'supplier_currency_mismatch', message: `ResellerClub prices are in ${cost.currency}; catalogue prices are ${input.currency}` });
      input = { ...input, costMinor: cost.amountMinor, costSource: `${COST_SOURCE_PREFIX}${input.supplierCostRef}` };
    }
    if (!ISO_DURATION.test(input.billingInterval) || input.billingInterval === 'P') throw new BadRequestException({ error: 'invalid_billing_interval' });
    const v = await this.db.planVersion.findUnique({ where: { id: planVersionId } });
    if (!v) throw new NotFoundException();
    const effectiveFrom = input.effectiveFrom ?? new Date();
    const price = await this.db.$transaction(async (tx) => {
      // Supersede (never mutate) the currently effective price for the same kind/currency/interval.
      await tx.priceVersion.updateMany({
        where: { planVersionId, kind: input.kind, currency: input.currency, billingInterval: input.billingInterval, isPremium: input.isPremium, effectiveTo: null },
        data: { effectiveTo: effectiveFrom },
      });
      return tx.priceVersion.create({
        data: {
          planVersionId,
          kind: input.kind,
          currency: input.currency,
          billingInterval: input.billingInterval,
          amountMinor: BigInt(input.amountMinor),
          setupFeeMinor: BigInt(input.setupFeeMinor),
          costMinor: input.costMinor === null ? null : BigInt(input.costMinor),
          costSource: input.costSource,
          isPremium: input.isPremium,
          effectiveFrom,
        },
      });
    });
    await this.audit.record({ actorId, actorType: 'operator', action: 'catalogue.price_added', targetType: 'priceVersion', targetId: price.id, metadata: { planVersionId, kind: input.kind, amountMinor: input.amountMinor } });
    return price;
  }

  async publishPlanVersion(planVersionId: string, actorId: string) {
    const v = await this.db.planVersion.findUnique({ where: { id: planVersionId }, include: { prices: true } });
    if (!v) throw new NotFoundException();
    if (v.publishedAt) throw new ConflictException({ error: 'already_published' });
    if (v.prices.length === 0) throw new BadRequestException({ error: 'price_required_before_publish' });
    const published = await this.db.planVersion.update({ where: { id: planVersionId }, data: { publishedAt: new Date() } });
    await this.audit.record({ actorId, actorType: 'operator', action: 'catalogue.plan_version_published', targetType: 'planVersion', targetId: planVersionId });
    return published;
  }

  /** Returns every reason a product cannot be sold. Activation is refused unless the list is empty. */
  async activationBlockers(productId: string): Promise<string[]> {
    const p = await this.db.product.findUnique({ where: { id: productId }, include: { plans: { include: { versions: { where: { publishedAt: { not: null } }, include: { prices: true } } } } } });
    if (!p) throw new NotFoundException();
    const blockers: string[] = [];
    const hasPricedVersion = p.plans.some((pl) => pl.versions.some((v) => v.prices.length > 0));
    if (!hasPricedVersion) blockers.push('No published plan version with a price.');
    if (p.fulfillment === 'resellerclub' || p.fulfillment === 'app_adapter') {
      if (!p.adapterKey) blockers.push('No fulfillment adapter assigned.');
      else {
        const adapter = await this.db.appAdapter.findUnique({ where: { key: p.adapterKey } });
        const allowed = this.config.NODE_ENV === 'production' ? ['active'] : ['active', 'sandbox'];
        if (!adapter || !allowed.includes(adapter.status)) blockers.push(`Adapter ${p.adapterKey} is ${adapter?.status ?? 'missing'}.`);
      }
    }
    if (p.fulfillment === 'resellerclub') {
      if (this.config.RESELLERCLUB_ENV === 'disabled') blockers.push('ResellerClub integration is disabled.');
      if (p.adapterKey && !isCapabilityVerified(p.adapterKey)) blockers.push(`Supplier capability for ${p.adapterKey} is not verified in docs/provider-capabilities.md.`);
    }
    if (p.fulfillment === 'bundle') {
      blockers.push(...(await this.bundleBlockers(p.id)));
    }
    if (this.config.CASHFREE_ENV === 'disabled') blockers.push('Payments are disabled (CASHFREE_ENV=disabled).');
    const rules = await this.db.taxRule.count({ where: { taxCategory: p.taxCategory, reviewed: true } });
    if (rules === 0) blockers.push(`No reviewed tax rule for category "${p.taxCategory}".`);
    return blockers;
  }

  private async bundleBlockers(productId: string): Promise<string[]> {
    const comps = await this.db.bundleComponent.findMany({
      where: { bundleVersion: { plan: { productId } } },
      include: { componentVersion: { include: { plan: { include: { product: true } } } } },
    });
    if (comps.length === 0) return ['Bundle has no components.'];
    return [...new Set(comps.filter((c) => c.componentVersion.plan.product.status !== 'active').map((c) => `Component ${c.componentVersion.plan.product.key} is not active.`))];
  }

  async setStatus(productId: string, status: 'active' | 'draft' | 'retired', actorId: string) {
    if (status === 'active') {
      const blockers = await this.activationBlockers(productId);
      if (blockers.length) throw new ConflictException({ error: 'activation_blocked', blockers });
    }
    const p = await this.db.product.update({ where: { id: productId }, data: { status } });
    await this.audit.record({ actorId, actorType: 'operator', action: `catalogue.product_${status}`, targetType: 'product', targetId: productId });
    return p;
  }

  async reviewTaxRule(id: string, reviewer: string, notes: string | undefined, actorId: string) {
    const r = await this.db.taxRule.update({ where: { id }, data: { reviewed: true, reviewedBy: reviewer, reviewedAt: new Date(), notes } });
    await this.audit.record({ actorId, actorType: 'operator', action: 'tax.rule_reviewed', targetType: 'taxRule', targetId: id, metadata: { reviewer } });
    return r;
  }

  listTaxRules() {
    return this.db.taxRule.findMany({ orderBy: [{ taxCategory: 'asc' }, { supplyType: 'asc' }] });
  }

  toJsonInput(v: unknown) {
    return v as Prisma.InputJsonValue;
  }
}
