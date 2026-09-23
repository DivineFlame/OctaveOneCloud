import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { AuthContext, AuthedRequest, CurrentAuth, Public, clientIp } from './decorators';
import { PASSWORD_MIN } from './passwords';
import { PRISMA } from '../common/prisma.module';
import { PrismaClient } from '@ooc/db';

const email = z.email().max(254);
const password = z.string().min(PASSWORD_MIN).max(256);
const RegisterSchema = z.object({ email, password, name: z.string().trim().min(1).max(120).optional() });
const LoginSchema = z.object({ email, password: z.string().min(1).max(256) });
const TokenSchema = z.object({ token: z.string().min(10).max(200) });
const ResetRequestSchema = z.object({ email });
const ResetConfirmSchema = z.object({ token: z.string().min(10).max(200), password });
const CodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly db: PrismaClient,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>, @Req() req: AuthedRequest) {
    return this.auth.register(body, clientIp(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.cookie(this.config.SESSION_COOKIE_NAME, r.token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: r.session.expiresAt,
    });
    return { userId: r.user.id, mfaRequired: r.mfaRequired, emailVerified: Boolean(r.user.emailVerifiedAt) };
  }

  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentAuth() a: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(a.session.id);
    res.clearCookie(this.config.SESSION_COOKIE_NAME, { path: '/' });
  }

  @Get('me')
  async me(@CurrentAuth() a: AuthContext) {
    const memberships = await this.db.membership.findMany({ where: { userId: a.user.id }, include: { org: { select: { id: true, name: true, slug: true } } } });
    return {
      id: a.user.id,
      email: a.user.email,
      name: a.user.name,
      emailVerified: Boolean(a.user.emailVerifiedAt),
      operatorRole: a.user.operatorRole,
      mfaEnabled: Boolean(a.user.mfaEnabledAt),
      mfaVerified: a.session.mfaVerified,
      organizations: memberships.map((m) => ({ ...m.org, role: m.role })),
    };
  }

  @Public()
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body(new ZodPipe(TokenSchema)) body: z.infer<typeof TokenSchema>) {
    return this.auth.verifyEmail(body.token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(202)
  @Post('password-reset/request')
  async requestReset(@Body(new ZodPipe(ResetRequestSchema)) body: z.infer<typeof ResetRequestSchema>) {
    await this.auth.requestPasswordReset(body.email);
    return { accepted: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('password-reset/confirm')
  async confirmReset(@Body(new ZodPipe(ResetConfirmSchema)) body: z.infer<typeof ResetConfirmSchema>, @Req() req: AuthedRequest) {
    await this.auth.confirmPasswordReset(body.token, body.password, clientIp(req));
    return { reset: true };
  }

  @Post('mfa/setup')
  mfaSetup(@CurrentAuth() a: AuthContext) {
    return this.auth.beginMfaSetup(a.user);
  }

  @HttpCode(200)
  @Post('mfa/enable')
  async mfaEnable(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @Req() req: AuthedRequest) {
    await this.auth.enableMfa(a.user, a.session.id, body.code, clientIp(req));
    return { enabled: true };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/verify')
  async mfaVerify(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @Req() req: AuthedRequest) {
    await this.auth.verifyMfa(a.user, a.session.id, body.code, clientIp(req));
    return { verified: true };
  }
}
