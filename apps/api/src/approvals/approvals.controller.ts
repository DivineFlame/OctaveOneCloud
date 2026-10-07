import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Membership, PrismaClient } from '@ooc/db';
import { APPROVER_PERMISSION, ApprovalActionType, ApprovalError, decideApproval } from '@ooc/integrations';
import { roleHasPermission } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';
import { AuthContext, CurrentAuth } from '../auth/decorators';
import { CurrentMembership, OrgGuard, RequireOrgPermission } from '../orgs/org.guard';

const Decide = z.object({ approve: z.boolean(), actionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** Customers review and decide agent actions that need human approval. */
@UseGuards(OrgGuard)
@RequireOrgPermission('services.read')
@Controller('orgs/:orgId/approvals')
export class ApprovalsController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentMembership() m: Membership, @Query('status') status?: string) {
    const rows = await this.db.approvalRequest.findMany({
      where: { orgId, ...(status === 'pending' ? { status: 'pending', expiresAt: { gt: new Date() } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      summary: a.summary,
      requestedBy: a.requestedBy,
      agentRunId: a.agentRunId,
      payload: a.payload,
      actionHash: a.actionHash,
      status: a.status,
      expiresAt: a.expiresAt,
      decidedAt: a.decidedAt,
      executedAt: a.executedAt,
      createdAt: a.createdAt,
      canDecide: a.status === 'pending' && roleHasPermission(m.role, APPROVER_PERMISSION[a.actionType as ApprovalActionType] ?? 'services.manage'),
    }));
  }

  @HttpCode(200)
  @Post(':approvalId/decide')
  async decide(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
    @CurrentAuth() a: AuthContext,
    @CurrentMembership() m: Membership,
    @Body(new ZodPipe(Decide)) body: z.infer<typeof Decide>,
  ) {
    const req = await this.db.approvalRequest.findFirst({ where: { id: approvalId, orgId } });
    if (!req) throw new NotFoundException();
    const needed = APPROVER_PERMISSION[req.actionType as ApprovalActionType] ?? 'services.manage';
    if (!roleHasPermission(m.role, needed)) throw new ForbiddenException({ error: 'insufficient_role', required: needed });
    if (req.actionHash !== body.actionHash) throw new BadRequestException({ error: 'action_changed', message: 'Reload: the action is not the one you reviewed' });
    try {
      await decideApproval(this.db, { orgId, approvalId, userId: a.user.id, approve: body.approve, actionHash: body.actionHash });
    } catch (e) {
      if (e instanceof ApprovalError) throw new BadRequestException({ error: 'not_pending', message: 'This request is no longer pending (decided or expired)' });
      throw e;
    }
    await this.audit.record({ actorId: a.user.id, actorType: 'user', orgId, action: body.approve ? 'approval.approved' : 'approval.rejected', targetType: 'approval', targetId: approvalId, metadata: { actionType: req.actionType, actionHash: req.actionHash } });
    return { id: approvalId, status: body.approve ? 'approved' : 'rejected' };
  }
}
