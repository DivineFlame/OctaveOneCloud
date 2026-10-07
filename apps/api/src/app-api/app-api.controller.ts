import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, NotFoundException, Post, Req, UseGuards, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { PrismaClient } from '@ooc/db';
import { APPROVAL_ACTION_TYPES, APPROVER_PERMISSION, ApprovalError, AppUsageError, appEntitlements, appRelease, appReserve, appServesOrg, appSettle, consumeApproval, requestApproval } from '@ooc/integrations';
import { roleHasPermission } from '@ooc/shared';
import { MailService } from '../auth/mail.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { PRISMA } from '../common/prisma.module';
import { Public } from '../auth/decorators';
import { AppRequest, AppSignatureGuard } from './app-signature.guard';

const Org = z.object({ orgId: z.uuid() }).strict();
const Reserve = z.object({
  orgId: z.uuid(),
  resource: z.string().min(1).max(100),
  quantity: z.number().int().positive().max(1_000_000_000),
  idempotencyKey: z.string().min(8).max(200),
  ttlSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();
const Settle = z.object({ reservationId: z.uuid(), actualQuantity: z.number().int().min(0).max(1_000_000_000), sourceEventId: z.string().min(1).max(200) }).strict();
const Release = z.object({ reservationId: z.uuid() }).strict();
const ActionType = z.enum(APPROVAL_ACTION_TYPES as unknown as ['outbound_message', 'publish_campaign', 'delete', 'spend']);
const Payload = z.record(z.string(), z.unknown()).refine((p) => JSON.stringify(p).length <= 32_000, 'payload too large');
const ApprovalReq = z.object({
  orgId: z.uuid(),
  actionType: ActionType,
  payload: Payload,
  summary: z.string().trim().min(3).max(300),
  agentRunId: z.string().max(200).optional(),
  ttlSeconds: z.number().int().min(60).max(7 * 86_400).optional(),
}).strict();
const ConnectorToken = z.object({ orgId: z.uuid(), provider: z.string().regex(/^[a-z0-9_]{1,40}$/) }).strict();
const ApprovalRef = z.object({ orgId: z.uuid(), approvalId: z.uuid() }).strict();
const ApprovalConsume = z.object({ orgId: z.uuid(), approvalId: z.uuid(), actionType: ActionType, payload: Payload }).strict();

function mapError(e: unknown): unknown {
  if (!(e instanceof AppUsageError)) return e;
  const body = { error: e.code, message: e.message, ...(e.details ?? {}) };
  if (e.code === 'org_not_served') return new ForbiddenException(body);
  if (e.code === 'reservation_not_found') return new NotFoundException(body);
  if (e.code === 'quota_exceeded' || e.code === 'reservation_not_open' || e.code === 'idempotency_conflict') return new ConflictException(body);
  return new BadRequestException(body);
}

/** Service API for hosted apps and the agent runtime (HMAC-signed, no cookies). */
@Public()
@SkipThrottle()
@UseGuards(AppSignatureGuard)
@Controller('app-api')
export class AppApiController {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mail: MailService,
    private readonly connectors: ConnectorsService,
  ) {}

  /** A customer's OAuth access token for a connector this app is allowed to use (refreshed if needed, audited). */
  @HttpCode(200)
  @Post('connectors/token')
  connectorToken(@Req() req: AppRequest, @Body(new ZodPipe(ConnectorToken)) body: z.infer<typeof ConnectorToken>) {
    return this.connectors.tokenForApp(req.appKey!, body.orgId, body.provider);
  }

  private async served(app: string, orgId: string) {
    if (!(await appServesOrg(this.db, app, orgId))) throw new ForbiddenException({ error: 'org_not_served' });
  }

  /** Asks the organisation's approvers; the app must not act until `approvals/consume` succeeds. */
  @Post('approvals/request')
  async approvalRequest(@Req() req: AppRequest, @Body(new ZodPipe(ApprovalReq)) body: z.infer<typeof ApprovalReq>) {
    await this.served(req.appKey!, body.orgId);
    const a = await requestApproval(this.db, { orgId: body.orgId, actionType: body.actionType, payload: body.payload, summary: body.summary, agentRunId: body.agentRunId, requestedBy: req.appKey, ttlMs: (body.ttlSeconds ?? 86_400) * 1000 });
    await this.db.auditEvent.create({ data: { actorType: 'system', orgId: body.orgId, action: 'approval.requested', targetType: 'approval', targetId: a.id, metadata: { app: req.appKey, actionType: body.actionType, actionHash: a.actionHash } } });
    // Tell the people who can decide (best effort; the request is visible in the dashboard regardless).
    const members = await this.db.membership.findMany({ where: { orgId: body.orgId }, include: { user: { select: { email: true } } } });
    const to = members.filter((m) => roleHasPermission(m.role, APPROVER_PERMISSION[body.actionType])).map((m) => m.user.email);
    for (const email of to) {
      await this.mail.trySend({ to: email, subject: `Approval needed: ${body.summary.slice(0, 80)}`, text: `An assistant wants to perform an action that needs your approval:\n\n${body.summary}\n\nReview it: ${this.config.APP_URL}/dashboard/orgs/${body.orgId}/approvals\n\nNothing happens unless you approve. The request expires at ${a.expiresAt.toISOString()}.` });
    }
    return { approvalId: a.id, status: a.status, actionHash: a.actionHash, expiresAt: a.expiresAt };
  }

  @HttpCode(200)
  @Post('approvals/status')
  async approvalStatus(@Req() req: AppRequest, @Body(new ZodPipe(ApprovalRef)) body: z.infer<typeof ApprovalRef>) {
    const a = await this.db.approvalRequest.findFirst({ where: { id: body.approvalId, orgId: body.orgId, requestedBy: req.appKey } });
    if (!a) throw new NotFoundException({ error: 'approval_not_found' });
    const status = a.status === 'pending' && a.expiresAt <= new Date() ? 'expired' : a.status;
    return { approvalId: a.id, status, decidedAt: a.decidedAt, expiresAt: a.expiresAt };
  }

  /** Atomically consumes the approval for exactly this action; execute only after this returns 200. */
  @HttpCode(200)
  @Post('approvals/consume')
  async approvalConsume(@Req() req: AppRequest, @Body(new ZodPipe(ApprovalConsume)) body: z.infer<typeof ApprovalConsume>) {
    const own = await this.db.approvalRequest.findFirst({ where: { id: body.approvalId, orgId: body.orgId, requestedBy: req.appKey }, select: { id: true } });
    if (!own) throw new NotFoundException({ error: 'approval_not_found' });
    try {
      const a = await consumeApproval(this.db, body);
      await this.db.auditEvent.create({ data: { actorType: 'system', orgId: body.orgId, action: 'approval.executed', targetType: 'approval', targetId: a.id, metadata: { app: req.appKey, actionType: a.actionType } } });
      return { approvalId: a.id, status: 'executed' };
    } catch (e) {
      if (e instanceof ApprovalError) throw new ConflictException({ error: e.code });
      throw e;
    }
  }

  @HttpCode(200)
  @Post('entitlements')
  async entitlements(@Req() req: AppRequest, @Body(new ZodPipe(Org)) body: z.infer<typeof Org>) {
    try {
      return await appEntitlements(this.db, req.appKey!, body.orgId);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/reserve')
  async reserve(@Req() req: AppRequest, @Body(new ZodPipe(Reserve)) body: z.infer<typeof Reserve>) {
    try {
      return await appReserve(this.db, req.appKey!, body);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/settle')
  async settle(@Req() req: AppRequest, @Body(new ZodPipe(Settle)) body: z.infer<typeof Settle>) {
    try {
      return await appSettle(this.db, req.appKey!, body);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/release')
  async release(@Req() req: AppRequest, @Body(new ZodPipe(Release)) body: z.infer<typeof Release>) {
    try {
      return await appRelease(this.db, req.appKey!, body.reservationId);
    } catch (e) {
      throw mapError(e);
    }
  }
}
