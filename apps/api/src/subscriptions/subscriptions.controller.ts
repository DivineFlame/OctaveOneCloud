import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, CurrentAuth, OperatorOnly } from '../auth/decorators';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';
import { SubscriptionsService } from './subscriptions.service';

const Downgrade = z.object({ priceVersionId: z.uuid(), quantity: z.number().int().min(1).max(100_000).default(1) }).strict();
const Reason = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

@UseGuards(OrgGuard)
@Controller('orgs/:orgId/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @RequireOrgPermission('billing.read')
  @Get()
  list(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.subs.list(orgId);
  }

  @RequireOrgPermission('billing.manage')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext) {
    return this.subs.cancel(orgId, id, a.user.id);
  }

  @RequireOrgPermission('billing.manage')
  @HttpCode(200)
  @Post(':id/keep')
  keep(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext) {
    return this.subs.keep(orgId, id, a.user.id);
  }

  @RequireOrgPermission('billing.manage')
  @HttpCode(200)
  @Post(':id/downgrade')
  downgrade(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Downgrade)) body: z.infer<typeof Downgrade>) {
    return this.subs.downgrade(orgId, id, a.user.id, body);
  }

  @RequireOrgPermission('billing.manage')
  @HttpCode(200)
  @Post(':id/scheduled-change/withdraw')
  withdraw(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext) {
    return this.subs.withdrawChange(orgId, id, a.user.id);
  }
}

@OperatorOnly('operator_support', 'operator_finance', 'operator_admin')
@Controller('admin/subscriptions')
export class SubscriptionsAdminController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  list(@Query('status') status?: string, @Query('orgId') orgId?: string, @Query('attention') attention?: string) {
    const st = z.enum(SUBSCRIPTION_STATUSES).safeParse(status);
    const org = z.uuid().safeParse(orgId);
    return this.subs.adminList({ status: st.success ? st.data : undefined, orgId: org.success ? org.data : undefined, attention: attention === 'true' });
  }

  @OperatorOnly('operator_support', 'operator_admin')
  @HttpCode(200)
  @Post(':id/suspend')
  suspend(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.subs.operatorAction(id, a.user.id, 'suspend', body.reason);
  }

  @OperatorOnly('operator_support', 'operator_admin')
  @HttpCode(200)
  @Post(':id/resume')
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.subs.operatorAction(id, a.user.id, 'resume', body.reason);
  }
}
