import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, minorFromDb } from '@ooc/db';
import { AppConfig, MoneyError, QuoteLineInput, TaxRule, computeQuote, determineSupplyType, groupForCheckout } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';

export const QUOTE_TTL_MS = 7 * 24 * 3600_000;

export interface QuoteRequestLine {
  priceVersionId: string;
  quantity: number;
  configuration?: Record<string, unknown>;
}

@Injectable()
export class QuotesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * Prices a basket entirely on the server. Client-supplied amounts are never accepted: only price
   * version ids and quantities. Prices, tax rules and cost snapshots are frozen into the quote.
   */
  async create(orgId: string, actorId: string, lines: QuoteRequestLine[]) {
    const org = await this.db.organization.findUniqueOrThrow({ where: { id: orgId } });
    let supplyType;
    try {
      supplyType = determineSupplyType({ sellerStateCode: this.config.SELLER_STATE_CODE ?? null, buyerStateCode: org.stateCode, buyerCountry: org.country });
    } catch {
      throw new BadRequestException({ error: 'billing_details_required', message: 'Organisation state code and seller state code are required for tax calculation.' });
    }
    const now = new Date();
    const ids = [...new Set(lines.map((l) => l.priceVersionId))];
    const prices = await this.db.priceVersion.findMany({
      where: { id: { in: ids } },
      include: { planVersion: { include: { plan: { include: { product: true } } } } },
    });
    const byId = new Map(prices.map((p) => [p.id, p]));
    const inputs: QuoteLineInput[] = [];
    for (const line of lines) {
      const p = byId.get(line.priceVersionId);
      if (!p) throw new BadRequestException({ error: 'unknown_price', priceVersionId: line.priceVersionId });
      const product = p.planVersion.plan.product;
      if (product.status !== 'active') throw new BadRequestException({ error: 'product_not_available', product: product.key });
      if (!p.planVersion.publishedAt || p.planVersion.retiredAt) throw new BadRequestException({ error: 'plan_not_available' });
      if (p.effectiveFrom > now || (p.effectiveTo && p.effectiveTo <= now)) throw new BadRequestException({ error: 'price_not_effective', priceVersionId: p.id });
      if (p.currency !== 'INR') throw new BadRequestException({ error: 'unsupported_currency' });
      inputs.push({
        planPriceVersionId: p.id,
        description: p.planVersion.plan.name,
        unitAmountMinor: minorFromDb(p.amountMinor),
        setupFeeMinor: minorFromDb(p.setupFeeMinor),
        quantity: line.quantity,
        taxCategory: product.taxCategory,
        billingInterval: p.billingInterval,
        currency: 'INR',
      });
    }
    const rules = await this.loadTaxRules(now);
    let totals;
    try {
      totals = computeQuote(inputs, supplyType, rules);
    } catch (e) {
      if (e instanceof MoneyError) throw new BadRequestException({ error: 'pricing_failed', message: e.message });
      throw e;
    }
    const checkoutGroups = groupForCheckout(totals.lines).length;
    const quote = await this.db.quote.create({
      data: {
        orgId,
        supplyType,
        subtotalMinor: BigInt(totals.subtotalMinor),
        discountMinor: BigInt(totals.discountMinor),
        taxMinor: BigInt(totals.taxMinor),
        totalMinor: BigInt(totals.totalMinor),
        snapshot: { ...totals, checkoutGroups, sellerStateCode: this.config.SELLER_STATE_CODE, buyerStateCode: org.stateCode } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
        createdById: actorId,
        lines: {
          create: totals.lines.map((l, idx) => ({
            priceVersionId: l.planPriceVersionId,
            description: l.description,
            quantity: l.quantity,
            unitAmountMinor: BigInt(l.unitAmountMinor),
            setupFeeMinor: BigInt(l.setupFeeMinor ?? 0),
            discountMinor: BigInt(l.discountMinor),
            taxMinor: BigInt(l.tax.totalTaxMinor),
            totalMinor: BigInt(l.totalMinor),
            costMinor: byId.get(l.planPriceVersionId)!.costMinor,
            billingInterval: l.billingInterval,
            configuration: (lines[idx]!.configuration ?? undefined) as Prisma.InputJsonValue | undefined,
          })),
        },
      },
      include: { lines: true },
    });
    await this.audit.record({ actorId, actorType: 'user', orgId, action: 'quote.created', targetType: 'quote', targetId: quote.id, metadata: { totalMinor: totals.totalMinor } });
    return quote;
  }

  private async loadTaxRules(now: Date): Promise<TaxRule[]> {
    const rows = await this.db.taxRule.findMany({ where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } });
    return rows.map((r) => ({ id: r.id, taxCategory: r.taxCategory, supplyType: r.supplyType, components: r.components as unknown as TaxRule['components'], reviewed: r.reviewed }));
  }

  async get(orgId: string, quoteId: string) {
    const q = await this.db.quote.findFirst({ where: { id: quoteId, orgId }, include: { lines: true } });
    if (!q) throw new NotFoundException();
    return q;
  }

  async accept(orgId: string, quoteId: string, actorId: string) {
    const updated = await this.db.quote.updateMany({
      where: { id: quoteId, orgId, status: 'draft', expiresAt: { gt: new Date() } },
      data: { status: 'accepted', acceptedAt: new Date() },
    });
    if (updated.count !== 1) {
      const q = await this.db.quote.findFirst({ where: { id: quoteId, orgId } });
      if (!q) throw new NotFoundException();
      throw new ConflictException({ error: q.expiresAt <= new Date() ? 'quote_expired' : 'quote_not_draft', status: q.status });
    }
    await this.audit.record({ actorId, actorType: 'user', orgId, action: 'quote.accepted', targetType: 'quote', targetId: quoteId });
    return this.get(orgId, quoteId);
  }
}
