import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@ooc/db';
import { AppConfig, CredentialCipher, redact, roleHasPermission } from '@ooc/shared';
import { appServesOrg } from '@ooc/integrations';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { CIPHER } from '../common/common.module';
import { AuditService } from '../common/audit.service';
import { ConnectorDef, loadConnectors } from './connector-registry';

export interface ConnectorFlow {
  state: string;
  verifier: string;
  orgId: string;
  provider: string;
  userId: string;
}

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * Customer OAuth connections (e.g. a mailbox or ad account) used by hosted apps and agents.
 * Tokens are stored encrypted (AES-256-GCM, bound to the grant's org and provider) and are only released to the
 * apps listed for the connector, for organisations those apps serve. Every release is audited.
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  readonly defs: Map<string, ConnectorDef>;

  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CIPHER) private readonly cipher: CredentialCipher,
    private readonly audit: AuditService,
  ) {
    this.defs = loadConnectors(process.env, config.NODE_ENV === 'production');
  }

  get redirectUri() {
    return `${this.config.API_URL}/v1/connectors/callback`;
  }

  private def(provider: string) {
    const d = this.defs.get(provider);
    if (!d) throw new NotFoundException({ error: 'unknown_connector' });
    return d;
  }

  private aad(orgId: string, provider: string) {
    return `connector:${orgId}:${provider}`;
  }

  async list(orgId: string) {
    const grants = await this.db.connectorGrant.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return {
      providers: [...this.defs.values()].map((d) => ({ key: d.key, label: d.label, scopes: d.scopes })),
      grants: grants.map((g) => ({ id: g.id, provider: g.provider, label: this.defs.get(g.provider)?.label ?? g.provider, scopes: g.scopes, accountLabel: g.accountLabel, createdAt: g.createdAt, expiresAt: g.expiresAt, revokedAt: g.revokedAt, lastUsedAt: g.lastUsedAt, lastError: g.lastError })),
    };
  }

  start(orgId: string, provider: string, userId: string) {
    const d = this.def(provider);
    const flow: ConnectorFlow = { state: randomBytes(24).toString('base64url'), verifier: randomBytes(48).toString('base64url'), orgId, provider, userId };
    const url = new URL(d.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', d.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', d.scopes.join(' '));
    url.searchParams.set('state', flow.state);
    url.searchParams.set('code_challenge', createHash('sha256').update(flow.verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of d.extraAuthParams) url.searchParams.set(k, v);
    return { authorizeUrl: url.href, flow };
  }

  private async tokenRequest(d: ConnectorDef, params: Record<string, string>) {
    let res: Response;
    try {
      res = await fetch(d.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...params, client_id: d.clientId, client_secret: d.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ServiceUnavailableException({ error: 'connector_unreachable', message: (e as Error).name });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== 'string') {
      this.logger.warn(`Connector ${d.key} token request failed: HTTP ${res.status} ${JSON.stringify(redact(json)).slice(0, 300)}`);
      throw new BadRequestException({ error: 'connector_token_failed', providerError: typeof json.error === 'string' ? json.error : undefined });
    }
    return json;
  }

  /** OAuth callback: exchange the code (PKCE) and store the tokens encrypted. */
  async finish(flow: ConnectorFlow, code: string, actorUserId: string) {
    if (actorUserId !== flow.userId) throw new ForbiddenException({ error: 'flow_user_mismatch' });
    const m = await this.db.membership.findUnique({ where: { orgId_userId: { orgId: flow.orgId, userId: actorUserId } } });
    if (!m || !roleHasPermission(m.role, 'services.manage')) throw new ForbiddenException({ error: 'insufficient_role' });
    const d = this.def(flow.provider);
    const json = await this.tokenRequest(d, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: flow.verifier });
    const token: StoredToken = { access_token: json.access_token as string, refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, token_type: typeof json.token_type === 'string' ? json.token_type : undefined };
    const scopes = typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : d.scopes;
    const enc = this.cipher.encrypt(JSON.stringify(token), this.aad(flow.orgId, d.key));
    const grant = await this.db.$transaction(async (tx) => {
      // One active connection per organisation and provider: a reconnect replaces the old grant.
      await tx.connectorGrant.updateMany({ where: { orgId: flow.orgId, provider: d.key, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.connectorGrant.create({
        data: { orgId: flow.orgId, provider: d.key, scopes, tokenEnc: enc.ciphertext, keyId: enc.keyId, expiresAt: expiry(json), accountLabel: labelFrom(json), createdById: actorUserId },
      });
    });
    await this.audit.record({ actorId: actorUserId, actorType: 'user', orgId: flow.orgId, action: 'connector.connected', targetType: 'connector', targetId: grant.id, metadata: { provider: d.key, scopes } });
    return grant;
  }

  async revoke(orgId: string, grantId: string, actorUserId: string) {
    const r = await this.db.connectorGrant.updateMany({ where: { id: grantId, orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException();
    await this.audit.record({ actorId: actorUserId, actorType: 'user', orgId, action: 'connector.revoked', targetType: 'connector', targetId: grantId });
    return { revoked: true };
  }

  /** For hosted apps: a current access token, refreshed when close to expiry. */
  async tokenForApp(appKey: string, orgId: string, provider: string) {
    const d = this.def(provider);
    if (!d.apps.includes(appKey)) throw new ForbiddenException({ error: 'connector_not_allowed_for_app' });
    if (!(await appServesOrg(this.db, appKey, orgId))) throw new ForbiddenException({ error: 'org_not_served' });
    const result = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "ConnectorGrant" WHERE "orgId" = ${orgId}::uuid AND provider = ${d.key} AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`);
      if (rows.length === 0) throw new NotFoundException({ error: 'not_connected' });
      const g = await tx.connectorGrant.findUniqueOrThrow({ where: { id: rows[0]!.id } });
      let token = JSON.parse(this.cipher.decrypt(g.tokenEnc, this.aad(orgId, d.key))) as StoredToken;
      let expiresAt = g.expiresAt;
      if (expiresAt && expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
        if (!token.refresh_token) {
          await tx.connectorGrant.update({ where: { id: g.id }, data: { lastError: 'expired_reconnect_required' } });
          throw new BadRequestException({ error: 'reconnect_required' });
        }
        // Refresh under the row lock so concurrent callers never spend the same refresh token twice.
        const json = await this.tokenRequest(d, { grant_type: 'refresh_token', refresh_token: token.refresh_token });
        token = { access_token: json.access_token as string, refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : token.refresh_token, token_type: typeof json.token_type === 'string' ? json.token_type : token.token_type };
        expiresAt = expiry(json);
        const enc = this.cipher.encrypt(JSON.stringify(token), this.aad(orgId, d.key));
        await tx.connectorGrant.update({ where: { id: g.id }, data: { tokenEnc: enc.ciphertext, keyId: enc.keyId, expiresAt, rotatedAt: new Date(), lastError: null } });
      }
      await tx.connectorGrant.update({ where: { id: g.id }, data: { lastUsedAt: new Date() } });
      return { grantId: g.id, accessToken: token.access_token, tokenType: token.token_type ?? 'Bearer', expiresAt, scopes: g.scopes };
    }, { timeout: 30_000 });
    await this.audit.record({ actorType: 'system', orgId, action: 'connector.token_issued', targetType: 'connector', targetId: result.grantId, metadata: { app: appKey, provider: d.key } });
    return result;
  }
}

function expiry(json: Record<string, unknown>) {
  const s = Number(json.expires_in);
  return Number.isFinite(s) && s > 0 ? new Date(Date.now() + s * 1000) : null;
}

/** Cosmetic account label from an id_token's email claim, if the provider returns one (not used for trust). */
function labelFrom(json: Record<string, unknown>) {
  if (typeof json.id_token !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(json.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
    return typeof payload.email === 'string' ? payload.email.slice(0, 200) : null;
  } catch {
    return null;
  }
}
