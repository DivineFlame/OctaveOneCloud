import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient, User, isUniqueViolation } from '@ooc/db';
import { AppConfig, CredentialCipher, generateTotpSecret, randomToken, sha256Hex, verifyTotp } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { CIPHER } from '../common/common.module';
import { AuditService } from '../common/audit.service';
import { MailService } from './mail.service';
import { hashPassword, verifyPassword } from './passwords';

const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;

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
    await this.mail.send({ to: user.email, subject: 'Verify your OctaveOneCloud email', text: `${this.config.APP_URL}/verify-email?token=${token}` });
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
    const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
    if (!user || !ok || user.disabledAt) {
      await this.audit.record({ actorType: 'user', action: 'auth.login_failed', metadata: { email }, ip: meta.ip });
      throw new UnauthorizedException({ error: 'invalid_credentials' });
    }
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
    await this.audit.record({ actorId: user.id, actorType: user.operatorRole ? 'operator' : 'user', action: 'auth.login', targetType: 'session', targetId: session.id, ip: meta.ip });
    return { token, session, user, mfaRequired: Boolean(user.mfaEnabledAt) };
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
    await this.mail.send({ to: user.email, subject: 'Reset your OctaveOneCloud password', text: `${this.config.APP_URL}/reset-password?token=${token}` });
  }

  async confirmPasswordReset(token: string, password: string, ip: string | null) {
    const record = await this.consumeToken(token, 'password_reset');
    await this.db.$transaction([
      this.db.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } }),
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
    if (!verifyTotp(this.cipher.decrypt(user.mfaSecretEnc, `mfa:${user.id}`), code)) throw new ForbiddenException({ error: 'invalid_mfa_code' });
    await this.db.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
    await this.db.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
    await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.mfa_enabled', ip });
  }

  async verifyMfa(user: User, sessionId: string, code: string, ip: string | null) {
    if (!user.mfaEnabledAt || !user.mfaSecretEnc) throw new BadRequestException({ error: 'mfa_not_enabled' });
    if (!verifyTotp(this.cipher.decrypt(user.mfaSecretEnc, `mfa:${user.id}`), code)) {
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.mfa_failed', ip });
      throw new ForbiddenException({ error: 'invalid_mfa_code' });
    }
    await this.db.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
  }
}
