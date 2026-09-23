import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, CurrentAuth } from '../auth/decorators';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';
import { QuotesService } from './quotes.service';
import { CheckoutService } from '../checkout/checkout.service';

const CreateQuote = z.object({
  lines: z
    .array(
      z.object({
        priceVersionId: z.uuid(),
        quantity: z.number().int().min(1).max(10_000),
        configuration: z.record(z.string(), z.unknown()).optional(),
      }).strict(),
    )
    .min(1)
    .max(50),
}).strict();
const Checkout = z.object({
  idempotencyKey: z.string().min(8).max(100),
  phone: z.string().regex(/^\+?[0-9]{10,15}$/),
});

@UseGuards(OrgGuard)
@Controller('orgs/:orgId')
export class QuotesController {
  constructor(private readonly quotes: QuotesService, private readonly checkout: CheckoutService) {}

  @RequireOrgPermission('billing.manage')
  @Post('quotes')
  create(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(CreateQuote)) body: z.infer<typeof CreateQuote>) {
    return this.quotes.create(orgId, a.user.id, body.lines);
  }

  @RequireOrgPermission('billing.read')
  @Get('quotes/:quoteId')
  get(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('quoteId', ParseUUIDPipe) quoteId: string) {
    return this.quotes.get(orgId, quoteId);
  }

  @RequireOrgPermission('billing.manage')
  @HttpCode(200)
  @Post('quotes/:quoteId/accept')
  accept(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('quoteId', ParseUUIDPipe) quoteId: string, @CurrentAuth() a: AuthContext) {
    return this.quotes.accept(orgId, quoteId, a.user.id);
  }

  @RequireOrgPermission('billing.manage')
  @Post('quotes/:quoteId/checkout')
  startCheckout(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('quoteId', ParseUUIDPipe) quoteId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Checkout)) body: z.infer<typeof Checkout>) {
    return this.checkout.checkout(orgId, quoteId, { id: a.user.id, email: a.user.email }, body);
  }

  @RequireOrgPermission('billing.read')
  @Get('orders/:orderId')
  order(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.checkout.present(orderId, orgId);
  }

  @RequireOrgPermission('billing.read')
  @HttpCode(202)
  @Post('orders/:orderId/reconcile')
  reconcile(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.checkout.requestReconcile(orgId, orderId);
  }
}
