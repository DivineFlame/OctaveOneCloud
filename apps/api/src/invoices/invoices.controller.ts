import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';
import { InvoicesService } from './invoices.service';

const CreditNoteBody = z.object({
  taxableMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(3).max(500),
  refundId: z.uuid().optional(),
}).strict();

@UseGuards(OrgGuard)
@RequireOrgPermission('billing.read')
@Controller('orgs/:orgId/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.invoices.list(orgId);
  }

  @Get(':invoiceId')
  get(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.invoices.get(orgId, invoiceId);
  }
}

@OperatorOnly('operator_finance', 'operator_admin')
@Controller('admin/invoices')
export class InvoicesAdminController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Query('orgId') orgId?: string, @Query('number') number?: string) {
    const org = z.uuid().safeParse(orgId);
    return this.invoices.adminList({ orgId: org.success ? org.data : undefined, number: number?.slice(0, 20) || undefined });
  }

  @Get(':invoiceId')
  get(@Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.invoices.adminGet(invoiceId);
  }

  @Post('issue/:orderId')
  issue(@Param('orderId', ParseUUIDPipe) orderId: string, @CurrentAuth() a: AuthContext) {
    return this.invoices.adminIssueForOrder(orderId, a.user.id);
  }

  @Post(':invoiceId/credit-notes')
  creditNote(@Param('invoiceId', ParseUUIDPipe) invoiceId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(CreditNoteBody)) body: z.infer<typeof CreditNoteBody>) {
    return this.invoices.adminCreditNote(invoiceId, a.user.id, body);
  }
}
