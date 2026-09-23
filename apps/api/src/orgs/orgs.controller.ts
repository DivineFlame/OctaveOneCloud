import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Membership } from '@ooc/db';
import { ORG_ROLES } from '@ooc/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AuthContext, AuthedRequest, CurrentAuth, clientIp } from '../auth/decorators';
import { CurrentMembership, OrgGuard, RequireOrgPermission } from './org.guard';
import { OrgsService } from './orgs.service';

const CreateOrg = z.object({ name: z.string().trim().min(2).max(120) });
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;
const UpdateBilling = z
  .object({
    legalName: z.string().trim().min(2).max(200).optional(),
    // Format check only; validity must be confirmed with the GST registry during operations.
    gstin: z.string().trim().toUpperCase().regex(GSTIN, 'GSTIN format invalid').nullable().optional(),
    billingEmail: z.email().optional(),
    billingAddress: z.record(z.string(), z.string().max(200)).optional(),
    stateCode: z.string().regex(/^\d{2}$/).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
  })
  .refine((v) => !v.gstin || !v.stateCode || v.gstin.slice(0, 2) === v.stateCode, { message: 'GSTIN state prefix does not match stateCode' });
const Invite = z.object({ email: z.email(), role: z.enum(ORG_ROLES) });
const ChangeRole = z.object({ role: z.enum(ORG_ROLES) });
const Accept = z.object({ token: z.string().min(10).max(200) });

@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post()
  create(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(CreateOrg)) body: z.infer<typeof CreateOrg>, @Req() req: AuthedRequest) {
    return this.orgs.create(a.user.id, body, clientIp(req));
  }

  @HttpCode(200)
  @Post('invitations/accept')
  accept(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(Accept)) body: z.infer<typeof Accept>, @Req() req: AuthedRequest) {
    return this.orgs.acceptInvitation(a.user.id, a.user.email, body.token, clientIp(req));
  }

  @UseGuards(OrgGuard)
  @Get(':orgId')
  get(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgs.get(orgId);
  }

  @UseGuards(OrgGuard)
  @RequireOrgPermission('billing.manage')
  @Patch(':orgId/billing')
  updateBilling(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentAuth() a: AuthContext, @Body(new ZodPipe(UpdateBilling)) body: z.infer<typeof UpdateBilling>, @Req() req: AuthedRequest) {
    return this.orgs.updateBilling(orgId, a.user.id, body, clientIp(req));
  }

  @UseGuards(OrgGuard)
  @Get(':orgId/members')
  members(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgs.listMembers(orgId);
  }

  @UseGuards(OrgGuard)
  @RequireOrgPermission('members.manage')
  @Post(':orgId/invitations')
  invite(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentMembership() m: Membership, @Body(new ZodPipe(Invite)) body: z.infer<typeof Invite>, @Req() req: AuthedRequest) {
    return this.orgs.invite(orgId, m, body, clientIp(req));
  }

  @UseGuards(OrgGuard)
  @RequireOrgPermission('members.manage')
  @Patch(':orgId/members/:memberId')
  changeRole(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('memberId', ParseUUIDPipe) memberId: string, @CurrentMembership() m: Membership, @Body(new ZodPipe(ChangeRole)) body: z.infer<typeof ChangeRole>, @Req() req: AuthedRequest) {
    return this.orgs.changeRole(orgId, m, memberId, body.role, clientIp(req));
  }

  @UseGuards(OrgGuard)
  @RequireOrgPermission('members.manage')
  @HttpCode(204)
  @Delete(':orgId/members/:memberId')
  remove(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('memberId', ParseUUIDPipe) memberId: string, @CurrentMembership() m: Membership, @Req() req: AuthedRequest) {
    return this.orgs.removeMember(orgId, m, memberId, clientIp(req));
  }
}
