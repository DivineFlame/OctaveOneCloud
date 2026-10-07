import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';
import { SupportService, TICKET_CATEGORIES } from './support.service';

const Create = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  category: z.enum(TICKET_CATEGORIES).default('general'),
  serviceId: z.uuid().optional(),
}).strict();
const Reply = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
const OperatorReply = z.object({ body: z.string().trim().min(1).max(10_000), internal: z.boolean().default(false) }).strict();
const Status = z.object({ status: z.enum(['open', 'pending_customer', 'pending_internal', 'resolved', 'closed']) }).strict();

@UseGuards(OrgGuard)
@RequireOrgPermission('support.use')
@Controller('orgs/:orgId/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.support.list(orgId);
  }

  @Post()
  create(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Create)) body: z.infer<typeof Create>) {
    return this.support.create(orgId, a.user.id, body);
  }

  @Get(':ticketId')
  get(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('ticketId', ParseUUIDPipe) ticketId: string) {
    return this.support.getForCustomer(orgId, ticketId);
  }

  @Post(':ticketId/messages')
  reply(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('ticketId', ParseUUIDPipe) ticketId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Reply)) body: z.infer<typeof Reply>) {
    return this.support.customerReply(orgId, ticketId, a.user.id, body.body);
  }

  @HttpCode(200)
  @Post(':ticketId/close')
  close(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('ticketId', ParseUUIDPipe) ticketId: string, @CurrentAuth() a: AuthContext) {
    return this.support.customerClose(orgId, ticketId, a.user.id);
  }
}

@OperatorOnly('operator_support', 'operator_admin')
@Controller('admin/tickets')
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get()
  queue(@Query('status') status?: string) {
    const parsed = Status.shape.status.safeParse(status);
    return this.support.queue(parsed.success ? parsed.data : undefined);
  }

  @Get(':ticketId')
  get(@Param('ticketId', ParseUUIDPipe) ticketId: string) {
    return this.support.getForOperator(ticketId);
  }

  @Post(':ticketId/messages')
  reply(@Param('ticketId', ParseUUIDPipe) ticketId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(OperatorReply)) body: z.infer<typeof OperatorReply>) {
    return this.support.operatorReply(ticketId, a.user.id, body.body, body.internal);
  }

  @HttpCode(200)
  @Post(':ticketId/status')
  status(@Param('ticketId', ParseUUIDPipe) ticketId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Status)) body: z.infer<typeof Status>) {
    return this.support.setStatus(ticketId, a.user.id, body.status);
  }
}
