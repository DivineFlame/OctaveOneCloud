import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { computeCandidateNetPrice } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, CurrentAuth, OperatorOnly, Public } from '../auth/decorators';
import { CatalogueService } from './catalogue.service';

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Features = z.object({ features: z.array(z.object({ featureKey: z.string().min(1), limit: z.number().int().nonnegative().nullable() })).max(100) });
const Price = z.object({
  kind: z.enum(['subscription', 'registration', 'renewal', 'transfer', 'one_time', 'usage_pack']),
  currency: z.literal('INR'),
  billingInterval: z.string().regex(/^P(\d+Y)?(\d+M)?(\d+D)?$/),
  amountMinor: minor,
  setupFeeMinor: minor.default(0),
  costMinor: minor.nullable().default(null),
  costSource: z.string().max(200).nullable().default(null),
  /** Take the cost from the latest ResellerClub cost snapshot, e.g. "dotin/renewdomain/1" (overrides costMinor/costSource). */
  supplierCostRef: z.string().min(3).max(300).optional(),
  isPremium: z.boolean().default(false),
});
const Status = z.object({ status: z.enum(['active', 'draft', 'retired']) });
const Review = z.object({ reviewer: z.string().min(2).max(200), notes: z.string().max(2000).optional() });
const Candidate = z.object({
  fixedDeliveryCostMinor: minor,
  expectedVariableCostMinor: minor,
  fixedTransactionCostMinor: minor.default(0),
  targetMarginBps: z.number().int().min(0).max(9999),
  collectionFeeBps: z.number().int().min(0).max(9999),
});

@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Public()
  @Get('catalogue/products')
  publicCatalogue() {
    return this.catalogue.publicCatalogue();
  }

  @OperatorOnly()
  @Get('admin/catalogue/products')
  adminList() {
    return this.catalogue.adminList();
  }

  @OperatorOnly()
  @Get('admin/catalogue/products/:id/activation-blockers')
  async blockers(@Param('id', ParseUUIDPipe) id: string) {
    return { blockers: await this.catalogue.activationBlockers(id) };
  }

  @OperatorOnly('operator_admin')
  @Post('admin/catalogue/products/:id/status')
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Status)) body: z.infer<typeof Status>, @CurrentAuth() a: AuthContext) {
    return this.catalogue.setStatus(id, body.status, a.user.id);
  }

  @OperatorOnly('operator_admin')
  @Post('admin/catalogue/plans/:planId/versions')
  createVersion(@Param('planId', ParseUUIDPipe) planId: string, @CurrentAuth() a: AuthContext) {
    return this.catalogue.createPlanVersion(planId, a.user.id);
  }

  @OperatorOnly('operator_admin')
  @Put('admin/catalogue/plan-versions/:id/features')
  setFeatures(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Features)) body: z.infer<typeof Features>, @CurrentAuth() a: AuthContext) {
    return this.catalogue.setFeatures(id, body.features, a.user.id);
  }

  @OperatorOnly('operator_admin', 'operator_finance')
  @Post('admin/catalogue/plan-versions/:id/prices')
  addPrice(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Price)) body: z.infer<typeof Price>, @CurrentAuth() a: AuthContext) {
    return this.catalogue.addPrice(id, body, a.user.id);
  }

  @OperatorOnly('operator_admin')
  @Post('admin/catalogue/plan-versions/:id/publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext) {
    return this.catalogue.publishPlanVersion(id, a.user.id);
  }

  @OperatorOnly('operator_finance')
  @Get('admin/tax-rules')
  taxRules() {
    return this.catalogue.listTaxRules();
  }

  @OperatorOnly('operator_finance')
  @Post('admin/tax-rules/:id/review')
  review(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Review)) body: z.infer<typeof Review>, @CurrentAuth() a: AuthContext) {
    return this.catalogue.reviewTaxRule(id, body.reviewer, body.notes, a.user.id);
  }

  /** Internal planning calculator; not a market quotation. */
  @OperatorOnly('operator_finance')
  @Post('admin/pricing/candidate')
  candidate(@Body(new ZodPipe(Candidate)) body: z.infer<typeof Candidate>) {
    return computeCandidateNetPrice(body);
  }
}
