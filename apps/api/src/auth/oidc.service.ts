import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as client from 'openid-client';
import { PrismaClient, User } from '@ooc/db';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { AuditService } from '../common/audit.service';

export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/**
 * Sign-in with an existing identity provider (OpenID Connect, authorization code + PKCE).
 * ID tokens are validated by openid-client (signature via JWKS, issuer, audience, expiry, nonce).
 * Identities link by issuer + subject. A first sign-in links to an existing account only when the provider
 * asserts `email_verified`; new accounts are created only with OIDC_ALLOW_SIGNUP=true.
 * Operator routes still require OctaveOneCloud TOTP.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  get enabled() {
    return Boolean(this.config.OIDC_ISSUER_URL && this.config.OIDC_CLIENT_ID && this.config.OIDC_CLIENT_SECRET);
  }

  get redirectUri() {
    return `${this.config.API_URL}/v1/auth/oidc/callback`;
  }

  /** Discovery is cached; a failure is retried on the next request. */
  private discovery(): Promise<client.Configuration> {
    if (!this.enabled) throw new NotFoundException({ error: 'oidc_disabled' });
    this.configPromise ??= client
      .discovery(new URL(this.config.OIDC_ISSUER_URL!), this.config.OIDC_CLIENT_ID!, this.config.OIDC_CLIENT_SECRET!, undefined,
        this.config.OIDC_ISSUER_URL!.startsWith('http://') && this.config.NODE_ENV !== 'production' ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((e) => {
        this.configPromise = null;
        this.logger.error(`OIDC discovery failed: ${(e as Error).message}`);
        throw new BadRequestException({ error: 'oidc_unavailable' });
      });
    return this.configPromise;
  }

  async start(returnTo: string): Promise<{ url: string; flow: OidcFlow }> {
    const cfg = await this.discovery();
    const flow: OidcFlow = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), returnTo: safeReturnTo(returnTo) };
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: this.redirectUri,
      scope: this.config.OIDC_SCOPES,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, flow };
  }

  /** Completes the code flow and returns the local user to sign in. */
  async finish(callbackUrl: URL, flow: OidcFlow, ip: string | null): Promise<User> {
    const cfg = await this.discovery();
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(cfg, callbackUrl, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      claims = tokens.claims();
    } catch (e) {
      this.logger.warn(`OIDC callback rejected: ${(e as Error).message}`);
      throw new UnauthorizedException({ error: 'oidc_failed' });
    }
    if (!claims?.sub) throw new UnauthorizedException({ error: 'oidc_failed' });
    const issuer = String(claims.iss);
    const subject = String(claims.sub);
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    const emailVerified = claims.email_verified === true;

    const linked = await this.db.userIdentity.findUnique({ where: { issuer_subject: { issuer, subject } }, include: { user: true } });
    let user: User;
    if (linked) {
      user = linked.user;
      await this.db.userIdentity.update({ where: { id: linked.id }, data: { lastLoginAt: new Date(), email } });
    } else {
      if (!email || !emailVerified) throw new UnauthorizedException({ error: 'oidc_email_not_verified', message: 'Your identity provider did not confirm your email address' });
      const existing = await this.db.user.findUnique({ where: { email } });
      if (existing) {
        user = existing;
      } else if (this.config.OIDC_ALLOW_SIGNUP) {
        user = await this.db.user.create({ data: { email, name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : undefined, emailVerifiedAt: new Date() } });
        await this.audit.record({ actorId: user.id, actorType: 'user', action: 'user.registered', targetType: 'user', targetId: user.id, ip, metadata: { via: 'oidc', issuer } });
      } else {
        throw new UnauthorizedException({ error: 'oidc_no_account', message: 'No account exists for this email; ask an administrator to invite you' });
      }
      await this.db.userIdentity.create({ data: { userId: user.id, issuer, subject, email, lastLoginAt: new Date() } });
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.identity_linked', targetType: 'user', targetId: user.id, ip, metadata: { issuer } });
    }
    if (user.disabledAt) throw new UnauthorizedException({ error: 'invalid_credentials' });
    if (!user.emailVerifiedAt && emailVerified && email === user.email) await this.db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return user;
  }
}

/** Only same-site relative paths, never another origin (no open redirect). */
export function safeReturnTo(v: string | undefined) {
  return v && /^\/(?!\/)[\w\-/?=&.%]*$/.test(v) && !v.startsWith('/\\') ? v : '/dashboard';
}
