import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

const hexKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes encoded as 64 hex characters');

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  CREDENTIAL_ENCRYPTION_KEY_ID: z.string().default('k1'),

  OIDC_ISSUER_URL: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,

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

  SELLER_GSTIN: optionalString,
  SELLER_STATE_CODE: optionalString,

  MODEL_GATEWAY_URL: optionalString,
  MODEL_GATEWAY_API_KEY: optionalString,
  MODEL_GATEWAY_DEFAULT_MODEL: optionalString,

  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  SENTRY_DSN: optionalString,
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
  if (c.CASHFREE_ENV !== 'disabled') {
    for (const k of ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_WEBHOOK_SECRET'] as const) {
      if (!c[k]) problems.push(`${k} is required when CASHFREE_ENV=${c.CASHFREE_ENV}`);
    }
  }
  if (c.NODE_ENV === 'production') {
    if (!c.APP_URL.startsWith('https://')) problems.push('APP_URL must use https in production');
    if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (c.CASHFREE_ENV === 'sandbox') problems.push('CASHFREE_ENV=sandbox is not allowed in production');
  } else if (c.CASHFREE_ENV === 'production') {
    problems.push('CASHFREE_ENV=production is only allowed when NODE_ENV=production');
  }
  if (problems.length) throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  return c;
}

export function cashfreeBaseUrl(env: AppConfig['CASHFREE_ENV']): string | null {
  if (env === 'sandbox') return 'https://sandbox.cashfree.com/pg';
  if (env === 'production') return 'https://api.cashfree.com/pg';
  return null;
}
