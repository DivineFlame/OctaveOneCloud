import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, NotFoundException, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Membership, PrismaClient } from '@ooc/db';
import { OrgPermission, roleHasPermission } from '@ooc/shared';
import { PRISMA } from '../common/prisma.module';
import { AuthedRequest } from '../auth/decorators';

export const ORG_PERMISSION = 'ooc:orgPermission';
export const RequireOrgPermission = (p: OrgPermission) => SetMetadata(ORG_PERMISSION, p);

export type OrgRequest = AuthedRequest & { membership?: Membership };

/**
 * Tenant boundary. Never trusts a client-supplied organisation id: the :orgId route param is
 * accepted only if the authenticated user holds a membership with the required permission.
 * Non-members receive 404 so organisation ids cannot be probed.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(PRISMA) private readonly db: PrismaClient) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OrgRequest>();
    const orgId = req.params?.orgId;
    const permission = this.reflector.getAllAndOverride<OrgPermission | undefined>(ORG_PERMISSION, [ctx.getHandler(), ctx.getClass()]) ?? 'org.read';
    if (!req.auth || typeof orgId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new NotFoundException();
    const membership = await this.db.membership.findUnique({ where: { orgId_userId: { orgId, userId: req.auth.user.id } } });
    if (!membership) throw new NotFoundException();
    if (!roleHasPermission(membership.role, permission)) throw new ForbiddenException({ error: 'insufficient_role', required: permission });
    req.membership = membership;
    return true;
  }
}

export const CurrentMembership = createParamDecorator((_d: unknown, ctx: ExecutionContext): Membership => {
  const m = ctx.switchToHttp().getRequest<OrgRequest>().membership;
  if (!m) throw new Error('CurrentMembership requires OrgGuard');
  return m;
});
