import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Session, User } from '@ooc/db';

export const IS_PUBLIC = 'ooc:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const OPERATOR_ROLES_KEY = 'ooc:operatorRoles';
export const OperatorOnly = (...roles: string[]) => SetMetadata(OPERATOR_ROLES_KEY, roles.length ? roles : ['*']);

export interface AuthContext {
  user: User;
  session: Session;
}

export type AuthedRequest = Request & { auth?: AuthContext; rawBody?: Buffer };

export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('CurrentAuth used on an unauthenticated route');
  return req.auth;
});

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
