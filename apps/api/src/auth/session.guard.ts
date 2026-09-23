import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { AuthService } from './auth.service';
import { AuthedRequest, IS_PUBLIC, OPERATOR_ROLES_KEY } from './decorators';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: resolves the session cookie, enforces an Origin check on cookie-authenticated
 * state-changing requests (CSRF defence alongside SameSite=Lax), and enforces operator role + MFA.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const token = (req.cookies as Record<string, string> | undefined)?.[this.config.SESSION_COOKIE_NAME];

    if (token && !SAFE_METHODS.has(req.method)) this.assertTrustedOrigin(req);

    const resolved = await this.auth.resolveSession(token);
    if (resolved) req.auth = resolved;
    if (isPublic) return true;
    if (!resolved) throw new UnauthorizedException({ error: 'authentication_required' });

    const operatorRoles = this.reflector.getAllAndOverride<string[] | undefined>(OPERATOR_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (operatorRoles) {
      const role = resolved.user.operatorRole;
      if (!role || (!operatorRoles.includes('*') && !operatorRoles.includes(role) && role !== 'operator_admin')) {
        throw new ForbiddenException({ error: 'operator_role_required' });
      }
      if (!resolved.user.mfaEnabledAt || !resolved.session.mfaVerified) {
        throw new ForbiddenException({ error: 'mfa_required' });
      }
    }
    return true;
  }

  private assertTrustedOrigin(req: AuthedRequest) {
    const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
    const allowed = [new URL(this.config.APP_URL).origin, new URL(this.config.API_URL).origin];
    if (!origin || !allowed.includes(origin)) throw new ForbiddenException({ error: 'untrusted_origin' });
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
