import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppConfig, CredentialCipher } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { CIPHER } from '../common/common.module';
import { FlowCookie } from '../common/flow-cookie';
import { AuthService } from './auth.service';
import { AuthedRequest, Public, clientIp } from './decorators';
import { OidcFlow, OidcService } from './oidc.service';

@Public()
@Controller('auth/oidc')
export class OidcController {
  private readonly cookie: FlowCookie<OidcFlow>;

  constructor(
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CIPHER) cipher: CredentialCipher,
  ) {
    this.cookie = new FlowCookie<OidcFlow>('ooc_oidc', 'oidc-flow', cipher, config.COOKIE_SECURE);
  }

  @Get('config')
  status() {
    return { enabled: this.oidc.enabled, name: this.oidc.enabled ? this.config.OIDC_DISPLAY_NAME : null };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('start')
  async start(@Query('returnTo') returnTo: string | undefined, @Res() res: Response) {
    const { url, flow } = await this.oidc.start(returnTo ?? '/dashboard');
    this.cookie.set(res, flow);
    res.redirect(302, url);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('callback')
  async callback(@Req() req: AuthedRequest, @Res() res: Response) {
    const flow = this.cookie.take(req, res);
    const fail = (code: string) => res.redirect(302, `${this.config.APP_URL}/login?sso_error=${encodeURIComponent(code)}`);
    if (!flow) return fail('expired');
    // Rebuild the callback URL as the provider called it (public API_URL, original query string).
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    try {
      const user = await this.oidc.finish(new URL(`${this.oidc.redirectUri}${query}`), flow, clientIp(req));
      const s = await this.auth.startSession(user, { ip: clientIp(req), userAgent: req.headers['user-agent'] }, 'auth.login', { via: 'oidc' });
      res.cookie(this.config.SESSION_COOKIE_NAME, s.token, { httpOnly: true, secure: this.config.COOKIE_SECURE, sameSite: 'lax', path: '/', expires: s.session.expiresAt });
      return res.redirect(302, `${this.config.APP_URL}${s.mfaRequired ? `/login?mfa=1&next=${encodeURIComponent(flow.returnTo)}` : flow.returnTo}`);
    } catch (e) {
      const code = (e as { response?: { error?: string } }).response?.error ?? 'oidc_failed';
      return fail(code);
    }
  }
}
