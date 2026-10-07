import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient, User, isUniqueViolation } from '@ooc/db';
import { AppConfig, CredentialCipher, generateTotpSecret, randomToken, sha256Hex, totpMatchStep } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { CIPHER } from '../common/common.module';
import { AuditService } from '../common/audit.service';
import { MailService } from './mail.service';
import { hashPassword, verifyPassword } from './passwords';

const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;

const LOGIN_LOCK_THRESHOLD = 10;
const LOGIN_LOCK_MS = 15 * 60_000;
const MFA_MAX_FAILURES = 5;

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CIPHER) private readonly cipher: CredentialCipher,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async register(input: { email: string; password: string; name?: string }, ip: string | null) {
    const email = input.email.trim().toLowerCase();
    try {
      const user = await this.db.user.create({ data: { email, name: input.name, passwordHash: await hashPassword(input.password) } });
      await this.issueEmailVerification(user);
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'user.registered', targetType: 'user', targetId: user.id, ip });
      return { id: user.id, email: user.email };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ error: 'email_in_use' });
      throw e;
    }
  }

  private async issueEmailVerification(user: User) {
    const token = randomToken();
    await this.db.userToken.create({ data: { userId: user.id, purpose: 'email_verification', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
    await this.mail.trySend({ to: user.email, subject: 'Verify your OctaveOneCloud email', text: `${this.config.APP_URL}/verify-email?token=${token}` });
  }

  async verifyEmail(token: string) {
    const record = await this.consumeToken(token, 'email_verification');
    await this.db.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    return { verified: true };
  }

  private async consumeToken(token: string, purpose: 'email_verification' | 'password_reset') {
    const tokenHash = sha256Hex(token);
    // Conditional update makes one-time tokens single-use under concurrency.
    const updated = await this.db.userToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (updated.count !== 1) throw new BadRequestException({ error: 'invalid_or_expired_token' });
    return this.db.userToken.findUniqueOrThrow({ where: { tokenHash } });
  }

  async login(input: { email: string; password: string }, meta: { ip: string | null; userAgent?: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.db.user.findUnique({ where: { email } });
    // Always verify (constant work) so timing does not reveal whether the account exists or is locked.
    const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
    const now = new Date();
    const locked = !!user?.loginLockedUntil && user.loginLockedUntil > now;
    if (!user || !ok || user.disabledAt || locked) {
      await this.audit.record({ actorType: 'user', action: locked ? 'auth.login_locked' : 'auth.login_failed', metadata: { email }, ip: meta.ip });
      if (user && !locked && !ok) await this.recordFailedLogin(user.id, user.email, now);
      // Same response for unknown, wrong password, disabled and locked accounts (no enumeration).
      throw new UnauthorizedException({ error: 'invalid_credentials' });
    }
    if (user.failedLogins || user.loginLockedUntil) await this.db.user.update({ where: { id: user.id }, data: { failedLogins: 0, loginLockedUntil: null } });
    return this.startSession(user, meta, 'auth.login');
  }

  /** Creates a new session (fresh random token; only its hash is stored). Used by password and OIDC sign-in. */
  async startSession(user: User, meta: { ip: string | null; userAgent?: string }, action: string, metadata?: Record<string, unknown>) {
    const token = randomToken();
    const session = await this.db.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3600_000),
      },
    });
    await this.audit.record({ actorId: user.id, actorType: user.operatorRole ? 'operator' : 'user', action, targetType: 'session', targetId: session.id, ip: meta.ip, metadata });
    return { token, session, user, mfaRequired: Boolean(user.mfaEnabledAt) };
  }

  /** After LOGIN_LOCK_THRESHOLD consecutive failures the account is locked for LOGIN_LOCK_MS, whatever the client IP. */
  private async recordFailedLogin(userId: string, email: string, now: Date) {
    const rows = await this.db.$queryRaw<{ failedLogins: number }[]>`
      UPDATE "User" SET "failedLogins" = "failedLogins" + 1, "updatedAt" = now() WHERE id = ${userId}::uuid RETURNING "failedLogins"`;
    if ((rows[0]?.failedLogins ?? 0) < LOGIN_LOCK_THRESHOLD) return;
    const until = new Date(now.getTime() + LOGIN_LOCK_MS);
    const r = await this.db.user.updateMany({ where: { id: userId, failedLogins: { gte: LOGIN_LOCK_THRESHOLD } }, data: { failedLogins: 0, loginLockedUntil: until } });
    if (r.count === 1) {
      await this.audit.record({ actorId: userId, actorType: 'system', action: 'auth.account_locked', targetType: 'user', targetId: userId, metadata: { until: until.toISOString() } });
      await this.mail.trySend({
        to: email,
        subject: 'Sign-in temporarily blocked on your OctaveOneCloud account',
        text: `There were ${LOGIN_LOCK_THRESHOLD} failed sign-in attempts on your account, so sign-in is blocked for ${LOGIN_LOCK_MS / 60_000} minutes.\nIf this was not you, reset your password: ${this.config.APP_URL}/forgot-password`,
      });
    }
  }

  async resolveSession(token: string | undefined) {
    if (!token) return null;
    const session = await this.db.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) return null;
    const { user, ...s } = session;
    return { user, session: s };
  }

  async logout(sessionId: string) {
    await this.db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  async requestPasswordReset(emailRaw: string) {
    const user = await this.db.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() } });
    if (!user || user.disabledAt) return; // no account enumeration
    const token = randomToken();
    await this.db.userToken.create({ data: { userId: user.id, purpose: 'password_reset', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
    await this.mail.trySend({ to: user.email, subject: 'Reset your OctaveOneCloud password', text: `${this.config.APP_URL}/reset-password?token=${token}` });
  }

  async confirmPasswordReset(token: string, password: string, ip: string | null) {
    const record = await this.consumeToken(token, 'password_reset');
    await this.db.$transaction([
      this.db.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), failedLogins: 0, loginLockedUntil: null } }),
      this.db.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorId: record.userId, actorType: 'user', action: 'auth.password_reset', ip });
  }

  // ── MFA (TOTP) ──
  async beginMfaSetup(user: User) {
    if (user.mfaEnabledAt) throw new ConflictException({ error: 'mfa_already_enabled' });
    const secret = generateTotpSecret();
    const enc = this.cipher.encrypt(secret, `mfa:${user.id}`);
    await this.db.user.update({ where: { id: user.id }, data: { mfaSecretEnc: enc.ciphertext, mfaKeyId: enc.keyId } });
    const label = encodeURIComponent(`OctaveOneCloud:${user.email}`);
    return { otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=OctaveOneCloud&algorithm=SHA1&digits=6&period=30` };
  }

  async enableMfa(user: User, sessionId: string, code: string, ip: string | null) {
    if (!user.mfaSecretEnc) throw new BadRequestException({ error: 'mfa_setup_not_started' });
    const step = totpMatchStep(this.cipher.decrypt(user.mfaSecretEnc, `mfa:${user.id}`), code);
    if (step === null) throw new ForbiddenException({ error: 'invalid_mfa_code' });
    await this.db.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date(), mfaLastStep: step } });
    await this.db.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
    await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.mfa_enabled', ip });
  }

  async verifyMfa(user: User, sessionId: string, code: string, ip: string | null) {
    if (!user.mfaEnabledAt || !user.mfaSecretEnc) throw new BadRequestException({ error: 'mfa_not_enabled' });
    const step = totpMatchStep(this.cipher.decrypt(user.mfaSecretEnc, `mfa:${user.id}`), code);
    // A code is accepted once: steps at or before the last accepted one are replays.
    const accepted = step !== null && (user.mfaLastStep === null || step > user.mfaLastStep)
      ? (await this.db.user.updateMany({ where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } })).count === 1
      : false;
    if (!accepted) {
      await this.audit.record({ actorId: user.id, actorType: 'user', action: step === null ? 'auth.mfa_failed' : 'auth.mfa_replay', ip });
      const s = await this.db.session.update({ where: { id: sessionId }, data: { mfaFailures: { increment: 1 } } });
      if (s.mfaFailures >= MFA_MAX_FAILURES) {
        // Too many wrong codes on this session: end it (the password must be entered again).
        await this.db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
        await this.audit.record({ actorId: user.id, actorType: 'system', action: 'auth.session_revoked_mfa_failures', targetType: 'session', targetId: sessionId, ip });
        throw new ForbiddenException({ error: 'mfa_attempts_exceeded' });
      }
      throw new ForbiddenException({ error: 'invalid_mfa_code' });
    }
    await this.db.session.update({ where: { id: sessionId }, data: { mfaVerified: true, mfaFailures: 0 } });
  }
}
