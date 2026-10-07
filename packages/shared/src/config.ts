import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** Whole days with bounds; blank → default. */
const days = (fallback: number, min: number, max: number) =>
  z.preprocess((v) => (v === '' || v === undefined ? fallback : v), z.coerce.number().int().min(min).max(max));

/** Blank → default, so an empty line in a Dokploy env block does not fail startup. */
const docPrefix = (fallback: string) =>
  z.preprocess((v) => (v === '' || v === undefined ? fallback : v), z.string().regex(/^[A-Z0-9]{1,4}$/, 'must be 1-4 uppercase letters/digits'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

const hexKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes encoded as 64 hex characters');

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Deployment tier. A production build can run as `staging` to use provider sandboxes. */
  APP_ENV: z.enum(['development', 'staging', 'production']).optional(),
  APP_URL: z.url(),
  API_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SESSION_COOKIE_NAME: z.string().default('ooc_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  COOKIE_SECURE: bool,
  /** Root key for encrypting stored credentials (OAuth tokens, TOTP secrets). Rotate via key id. */
  CREDENTIAL_ENCRYPTION_KEY: hexKey,
  CREDENTIAL_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  /** Retired keys still needed to decrypt older data during rotation: "k1:<64 hex>,k2:<64 hex>". */
  CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: optionalString,

  OIDC_ISSUER_URL: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  // Button label on the login page, e.g. "Google Workspace" or "Octave staff login".
  OIDC_DISPLAY_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(60).default('single sign-on')),
  OIDC_SCOPES: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('openid email profile')),
  // Create a new account on first OIDC sign-in (otherwise only existing accounts with the same verified email link).
  OIDC_ALLOW_SIGNUP: bool,

  RESELLERCLUB_ENV: z.enum(['disabled', 'demo', 'live']).default('disabled'),
  RESELLERCLUB_BASE_URL: optionalString,
  RESELLERCLUB_AUTH_USERID: optionalString,
  RESELLERCLUB_API_KEY: optionalString,
  /** Second, explicit switch required before any chargeable live supplier action. */
  RESELLERCLUB_ALLOW_LIVE_MUTATIONS: bool,

  CASHFREE_ENV: z.enum(['disabled', 'sandbox', 'production']).default('disabled'),
  CASHFREE_CLIENT_ID: optionalString,
  CASHFREE_CLIENT_SECRET: optionalString,
  CASHFREE_API_VERSION: z.string().default('2025-01-01'),
  CASHFREE_WEBHOOK_SECRET: optionalString,
  CASHFREE_SUBSCRIPTIONS_ENABLED: bool,
  CASHFREE_SUBSCRIPTION_CLIENT_ID: optionalString,
  CASHFREE_SUBSCRIPTION_CLIENT_SECRET: optionalString,
  CASHFREE_SUBSCRIPTION_API_VERSION: optionalString,
  CASHFREE_SUBSCRIPTION_WEBHOOK_SECRET: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  SMTP_URL: optionalString,
  MAIL_FROM: optionalString,
  /** Where new support tickets and customer replies are announced (optional). */
  SUPPORT_NOTIFY_EMAIL: optionalString,
  // Customer-paid renewals: order + reminder N days before period end; access continues for the grace period
  // after it; the subscription ends if still unpaid after the lapse period.
  RENEWAL_NOTICE_DAYS: days(7, 1, 60),
  RENEWAL_GRACE_DAYS: days(7, 0, 30),
  RENEWAL_LAPSE_DAYS: days(30, 1, 180),

  SELLER_GSTIN: optionalString,
  SELLER_STATE_CODE: optionalString,
  /** Seller identity printed on GST invoices (accountant to confirm). Required once payments are enabled. */
  SELLER_LEGAL_NAME: optionalString,
  SELLER_ADDRESS: optionalString,
  /** Invoice / credit-note number prefixes (1–4 letters/digits; keeps numbers within GST's 16-character limit). */
  INVOICE_PREFIX: docPrefix('OOC'),
  CREDIT_NOTE_PREFIX: docPrefix('OCN'),

  MODEL_GATEWAY_URL: optionalString,
  MODEL_GATEWAY_API_KEY: optionalString,
  MODEL_GATEWAY_DEFAULT_MODEL: optionalString,

  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  SENTRY_DSN: optionalString,
  /** Lets the production build run over plain HTTP on localhost only (docker-compose.local.yml). */
  OOC_ALLOW_INSECURE_LOCAL: bool,
  /**
   * Lets a production build run over plain HTTP on an IP address and port (e.g. http://203.0.113.10:8585)
   * before a domain exists. Refused together with live payments or live supplier actions.
   */
  OOC_ALLOW_INSECURE_HTTP: bool,
});

export type AppConfig = z.infer<typeof baseEnvSchema>;

export class ConfigError extends Error {}

/**
 * Validates configuration at startup. Error messages name the variable but never echo its value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = baseEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const problems: string[] = [];

  if (c.RESELLERCLUB_ENV !== 'disabled') {
    for (const k of ['RESELLERCLUB_BASE_URL', 'RESELLERCLUB_AUTH_USERID', 'RESELLERCLUB_API_KEY'] as const) {
      if (!c[k]) problems.push(`${k} is required when RESELLERCLUB_ENV=${c.RESELLERCLUB_ENV}`);
    }
    if (c.RESELLERCLUB_BASE_URL && !c.RESELLERCLUB_BASE_URL.startsWith('https://')) {
      problems.push('RESELLERCLUB_BASE_URL must use https');
    }
  }
  if (c.RESELLERCLUB_ENV !== 'live' && c.RESELLERCLUB_ALLOW_LIVE_MUTATIONS) {
    problems.push('RESELLERCLUB_ALLOW_LIVE_MUTATIONS may only be set when RESELLERCLUB_ENV=live');
  }
  const oidc = [c.OIDC_ISSUER_URL, c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET].filter(Boolean).length;
  if (oidc > 0 && oidc < 3) problems.push('OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together');
  if (c.OIDC_ISSUER_URL && !c.OIDC_ISSUER_URL.startsWith('https://') && c.NODE_ENV === 'production') {
    problems.push('OIDC_ISSUER_URL must use https');
  }
  if (c.CASHFREE_ENV !== 'disabled') {
    for (const k of ['SELLER_LEGAL_NAME', 'SELLER_ADDRESS', 'SELLER_STATE_CODE'] as const) {
      if (!c[k]) problems.push(`${k} is required when payments are enabled (printed on GST invoices)`);
    }
    for (const k of ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_WEBHOOK_SECRET'] as const) {
      if (!c[k]) problems.push(`${k} is required when CASHFREE_ENV=${c.CASHFREE_ENV}`);
    }
  }
  try {
    const prev = previousEncryptionKeys(c);
    if (c.CREDENTIAL_ENCRYPTION_KEY_ID in prev) problems.push('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must not reuse the current CREDENTIAL_ENCRYPTION_KEY_ID');
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (c.SMTP_URL) {
    if (!/^smtps?:\/\//.test(c.SMTP_URL)) problems.push('SMTP_URL must start with smtp:// or smtps://');
    if (!c.MAIL_FROM) problems.push('MAIL_FROM is required when SMTP_URL is set');
  }
  if (c.NODE_ENV === 'production') {
    const localOnly = c.OOC_ALLOW_INSECURE_LOCAL && ['localhost', '127.0.0.1'].includes(new URL(c.APP_URL).hostname);
    if (c.OOC_ALLOW_INSECURE_LOCAL && !localOnly) problems.push('OOC_ALLOW_INSECURE_LOCAL is only permitted with a localhost APP_URL');
    const insecureHttp = localOnly || c.OOC_ALLOW_INSECURE_HTTP;
    if (!insecureHttp && !c.APP_URL.startsWith('https://')) problems.push('APP_URL must use https in production (or set OOC_ALLOW_INSECURE_HTTP=true for an IP:port trial)');
    if (!insecureHttp && !c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (c.OOC_ALLOW_INSECURE_HTTP) {
      if (c.APP_URL.startsWith('http://') && c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be false when APP_URL uses http:// (browsers drop secure cookies over HTTP)');
      if (c.CASHFREE_ENV === 'production') problems.push('OOC_ALLOW_INSECURE_HTTP cannot be used with CASHFREE_ENV=production');
      if (c.RESELLERCLUB_ENV === 'live') problems.push('OOC_ALLOW_INSECURE_HTTP cannot be used with RESELLERCLUB_ENV=live');
    }
    if (!c.SMTP_URL) problems.push('SMTP_URL is required in production (verification, password reset and invitation emails)');
  }
  const tier = appEnv(c);
  if (tier === 'production' && c.CASHFREE_ENV === 'sandbox') problems.push('CASHFREE_ENV=sandbox is not allowed when APP_ENV=production (use APP_ENV=staging)');
  if (tier !== 'production' && c.CASHFREE_ENV === 'production') problems.push('CASHFREE_ENV=production is only allowed when APP_ENV=production');
  if (tier !== 'production' && c.RESELLERCLUB_ENV === 'live') problems.push('RESELLERCLUB_ENV=live is only allowed when APP_ENV=production');
  if (problems.length) throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  return c;
}

/** Parses CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS ("id:hex,id:hex") without echoing key material in errors. */
export function previousEncryptionKeys(c: Pick<AppConfig, 'CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (c.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9_-]{1,32}):([0-9a-fA-F]{64})$/.exec(part);
    if (!m) throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a comma-separated list of id:64-hex-characters');
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** All keys for the credential cipher: previous ones (decrypt only) plus the current one (encrypt + decrypt). */
export function encryptionKeys(c: Pick<AppConfig, 'CREDENTIAL_ENCRYPTION_KEY' | 'CREDENTIAL_ENCRYPTION_KEY_ID' | 'CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS'>): Record<string, string> {
  return { ...previousEncryptionKeys(c), [c.CREDENTIAL_ENCRYPTION_KEY_ID]: c.CREDENTIAL_ENCRYPTION_KEY };
}

/** True when the app is deliberately served without HTTPS (IP:port trial or local run). */
export function isInsecureHttp(c: Pick<AppConfig, 'APP_URL'>): boolean {
  return c.APP_URL.startsWith('http://');
}

/** Effective deployment tier: APP_ENV if set, otherwise production for NODE_ENV=production, else development. */
export function appEnv(c: Pick<AppConfig, 'APP_ENV' | 'NODE_ENV'>): 'development' | 'staging' | 'production' {
  return c.APP_ENV ?? (c.NODE_ENV === 'production' ? 'production' : 'development');
}

export interface SellerProfile {
  legalName: string;
  address: string;
  gstin: string | null;
  stateCode: string;
  invoicePrefix: string;
  creditNotePrefix: string;
}

/** Seller identity for GST documents, or null while it is not configured. */
export interface RenewalSettings {
  noticeDays: number;
  graceDays: number;
  lapseDays: number;
}

export function renewalSettings(c: AppConfig): RenewalSettings {
  return { noticeDays: c.RENEWAL_NOTICE_DAYS, graceDays: c.RENEWAL_GRACE_DAYS, lapseDays: Math.max(c.RENEWAL_LAPSE_DAYS, c.RENEWAL_GRACE_DAYS + 1) };
}

export function sellerProfile(c: AppConfig): SellerProfile | null {
  if (!c.SELLER_LEGAL_NAME || !c.SELLER_ADDRESS || !c.SELLER_STATE_CODE) return null;
  return { legalName: c.SELLER_LEGAL_NAME, address: c.SELLER_ADDRESS, gstin: c.SELLER_GSTIN ?? null, stateCode: c.SELLER_STATE_CODE, invoicePrefix: c.INVOICE_PREFIX, creditNotePrefix: c.CREDIT_NOTE_PREFIX };
}

export function cashfreeBaseUrl(env: AppConfig['CASHFREE_ENV']): string | null {
  if (env === 'sandbox') return 'https://sandbox.cashfree.com/pg';
  if (env === 'production') return 'https://api.cashfree.com/pg';
  return null;
}
