import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Membership, OrgRole, PrismaClient, isUniqueViolation } from '@ooc/db';
import { AppConfig, canAssignRole, randomToken, sha256Hex } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';
import { MailService } from '../auth/mail.service';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)}`;
}

@Injectable()
export class OrgsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async create(userId: string, input: { name: string }, ip: string | null) {
    return this.db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: input.name, slug: slugify(input.name) } });
      await tx.membership.create({ data: { orgId: org.id, userId, role: 'owner' } });
      await this.audit.record({ actorId: userId, actorType: 'user', orgId: org.id, action: 'org.created', targetType: 'organization', targetId: org.id, ip }, tx);
      return org;
    });
  }

  get(orgId: string) {
    return this.db.organization.findUniqueOrThrow({ where: { id: orgId } });
  }

  async updateBilling(orgId: string, actorId: string, input: { legalName?: string; gstin?: string | null; billingEmail?: string; billingAddress?: Record<string, string>; stateCode?: string; country?: string }, ip: string | null) {
    const org = await this.db.organization.update({ where: { id: orgId }, data: input });
    await this.audit.record({ actorId, actorType: 'user', orgId, action: 'org.billing_updated', targetType: 'organization', targetId: orgId, metadata: { fields: Object.keys(input) }, ip });
    return org;
  }

  listMembers(orgId: string) {
    return this.db.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  }

  async invite(orgId: string, actor: Membership, input: { email: string; role: OrgRole }, ip: string | null) {
    if (!canAssignRole(actor.role, input.role)) throw new ForbiddenException({ error: 'cannot_assign_role' });
    const email = input.email.trim().toLowerCase();
    const existing = await this.db.membership.findFirst({ where: { orgId, user: { email } } });
    if (existing) throw new ConflictException({ error: 'already_member' });
    const token = randomToken();
    const invitation = await this.db.invitation.create({
      data: { orgId, email, role: input.role, tokenHash: sha256Hex(token), invitedById: actor.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    await this.mail.send({ to: email, subject: 'You have been invited to OctaveOneCloud', text: `${this.config.APP_URL}/invitations/accept?token=${token}` });
    await this.audit.record({ actorId: actor.userId, actorType: 'user', orgId, action: 'member.invited', targetType: 'invitation', targetId: invitation.id, metadata: { email, role: input.role }, ip });
    return { id: invitation.id, email, role: input.role, expiresAt: invitation.expiresAt };
  }

  async acceptInvitation(userId: string, userEmail: string, token: string, ip: string | null) {
    const inv = await this.db.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) throw new BadRequestException({ error: 'invalid_or_expired_invitation' });
    // Invitation is bound to the invited address; a leaked link cannot be used by another account.
    if (inv.email !== userEmail.toLowerCase()) throw new ForbiddenException({ error: 'invitation_email_mismatch' });
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException({ error: 'invalid_or_expired_invitation' });
      try {
        const m = await tx.membership.create({ data: { orgId: inv.orgId, userId, role: inv.role } });
        await this.audit.record({ actorId: userId, actorType: 'user', orgId: inv.orgId, action: 'member.joined', targetType: 'membership', targetId: m.id, ip }, tx);
        return m;
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException({ error: 'already_member' });
        throw e;
      }
    });
  }

  async changeRole(orgId: string, actor: Membership, memberId: string, role: OrgRole, ip: string | null) {
    const target = await this.db.membership.findFirst({ where: { id: memberId, orgId } });
    if (!target) throw new NotFoundException();
    if (!canAssignRole(actor.role, role) || (target.role === 'owner' && actor.role !== 'owner')) throw new ForbiddenException({ error: 'cannot_assign_role' });
    if (target.role === 'owner' && role !== 'owner') await this.assertAnotherOwner(orgId, target.id);
    const m = await this.db.membership.update({ where: { id: target.id }, data: { role } });
    await this.audit.record({ actorId: actor.userId, actorType: 'user', orgId, action: 'member.role_changed', targetType: 'membership', targetId: target.id, metadata: { from: target.role, to: role }, ip });
    return m;
  }

  async removeMember(orgId: string, actor: Membership, memberId: string, ip: string | null) {
    const target = await this.db.membership.findFirst({ where: { id: memberId, orgId } });
    if (!target) throw new NotFoundException();
    if (target.role === 'owner' && actor.role !== 'owner') throw new ForbiddenException({ error: 'cannot_remove_owner' });
    if (target.role === 'owner') await this.assertAnotherOwner(orgId, target.id);
    await this.db.membership.delete({ where: { id: target.id } });
    await this.audit.record({ actorId: actor.userId, actorType: 'user', orgId, action: 'member.removed', targetType: 'membership', targetId: target.id, ip });
  }

  private async assertAnotherOwner(orgId: string, excludingId: string) {
    const owners = await this.db.membership.count({ where: { orgId, role: 'owner', id: { not: excludingId } } });
    if (owners === 0) throw new BadRequestException({ error: 'organization_requires_an_owner' });
  }
}
