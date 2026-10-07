# Environment variables — complete reference

Every setting OctaveOneCloud reads, generated from the code (`packages/shared/src/config.ts`, `docker-compose.yml`,
the worker and API modules). Names are OctaveOneCloud settings, not provider SDK field names.

**Where to put them.** In Dokploy: Compose service → **Environment**. Dokploy writes them to `.env` next to
`docker-compose.yml`; Compose uses them in two ways:

- **Compose-level** values are substituted into `docker-compose.yml` (passwords, Postgres tuning, backups, ports).
- **Application** values are passed to the `api`, `worker` and `migrate` containers via `env_file: .env`.

Startup validates everything. An invalid value stops the service with a message naming the variable (never its
value) — check the `api`/`worker`/`migrate` logs in Dokploy. After changing anything, click **Deploy** again.
Values must not contain quotes; blank lines like `SELLER_GSTIN=` mean "not set".

Legend — **Required**: ✅ always · ◐ in some situations (see notes) · — optional.
Types: *bool* accepts `true`/`false`/`1`/`0` (blank = false); *URL* must be absolute.

---

## 1. Ready-to-copy sets

Generate the three secrets once and store them in a password manager:

```bash
node scripts/generate-secrets.mjs      # prints POSTGRES_PASSWORD, REDIS_PASSWORD, CREDENTIAL_ENCRYPTION_KEY(+_ID)
```

### A. Trial on the server IP (no domain, plain HTTP — testing only)

```env
APP_ENV=production
APP_URL=http://203.0.113.10:8585
API_URL=http://203.0.113.10:8585/api
COOKIE_SECURE=false
OOC_ALLOW_INSECURE_HTTP=true
WEB_PUBLISH=8585
POSTGRES_PASSWORD=<generated>
REDIS_PASSWORD=<generated>
CREDENTIAL_ENCRYPTION_KEY=<generated>
CREDENTIAL_ENCRYPTION_KEY_ID=k1
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=OctaveOneCloud <no-reply@example.com>
```

(Replace `203.0.113.10` with your server IP; also run `ufw allow 8585/tcp`. Live payments are refused in this mode.)

### B. Production on a domain (HTTPS through Dokploy/Traefik)

```env
APP_ENV=production
APP_URL=https://app.example.com
API_URL=https://app.example.com/api
COOKIE_SECURE=true
POSTGRES_PASSWORD=<generated>
REDIS_PASSWORD=<generated>
CREDENTIAL_ENCRYPTION_KEY=<generated>
CREDENTIAL_ENCRYPTION_KEY_ID=k1
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=OctaveOneCloud <no-reply@example.com>
SUPPORT_NOTIFY_EMAIL=support@example.com
```

Do **not** set `OOC_ALLOW_INSECURE_HTTP` or `WEB_PUBLISH` here; add the domain in Dokploy (service `web`, port 3000).

### C. Add when taking payments (after the Cashfree account is verified)

```env
SELLER_LEGAL_NAME=Octave Cloud Private Limited
SELLER_ADDRESS=12 MG Road, Bengaluru, Karnataka 560001
SELLER_STATE_CODE=29
SELLER_GSTIN=29ABCDE1234F1Z5
CASHFREE_ENV=production
CASHFREE_CLIENT_ID=<from Cashfree dashboard>
CASHFREE_CLIENT_SECRET=<from Cashfree dashboard>
CASHFREE_API_VERSION=2025-01-01
CASHFREE_WEBHOOK_SECRET=<from Cashfree dashboard>
```

For a **staging** project use `APP_ENV=staging` and `CASHFREE_ENV=sandbox` with sandbox keys instead.

---

## 2. Application core

| Variable | Req. | Default | Values / example | What it does |
|---|---|---|---|---|
| `APP_ENV` | — | `production` when `NODE_ENV=production`, else `development` | `production`, `staging`, `development` | Deployment tier. `production` refuses sandbox Cashfree; `staging` refuses live Cashfree/ResellerClub. |
| `APP_URL` | ✅ | — | `https://app.example.com` | Public address of the site. Used in emails, redirects, CORS and the Origin (CSRF) check. Must be `https://` in production unless an insecure mode below is on. No trailing slash. |
| `API_URL` | ✅ | — | `https://app.example.com/api` | Public address of the API **through the web proxy** (= `APP_URL` + `/api`). Used for webhook, SSO and OAuth callback URLs. |
| `LOG_LEVEL` | — | `info` | `fatal` `error` `warn` `info` `debug` `trace` | Log verbosity (JSON logs; secrets redacted). |
| `NODE_ENV` | set by Compose | `production` in containers | — | Do not set in Dokploy; Compose sets it for every app container. |

## 3. Security and sessions

| Variable | Req. | Default | Values / example | What it does |
|---|---|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | ✅ | — | 64 hex characters (32 bytes) | Encrypts MFA secrets and customer OAuth tokens (AES-256-GCM). **Never lose or change it without the rotation steps below** — data encrypted with a missing key cannot be read. |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | — | `k1` | 1–32 of `A-Z a-z 0-9 _ -` | Label stored with each ciphertext so keys can be rotated. |
| `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` | — | — | `k1:<64 hex>,k0:<64 hex>` | Retired keys kept for decrypting older data during rotation. Must not reuse the current id. |
| `COOKIE_SECURE` | ◐ | `false` | bool | Sends the session cookie only over HTTPS. **Must be `true` in production**; must be `false` in the IP:port HTTP trial. |
| `SESSION_TTL_HOURS` | — | `168` (7 days) | positive integer | Session lifetime. |
| `SESSION_COOKIE_NAME` | — | `ooc_session` | text | Name of the session cookie. Changing it signs everyone out. |
| `OOC_ALLOW_INSECURE_HTTP` | — | `false` | bool | Allows the production build on plain `http://IP:port` for a trial. Refused together with `CASHFREE_ENV=production` or `RESELLERCLUB_ENV=live`. Remove when you move to a domain. |
| `OOC_ALLOW_INSECURE_LOCAL` | — | `false` | bool | Plain HTTP only when `APP_URL` is `localhost`/`127.0.0.1` (set automatically by `docker-compose.local.yml`). Never on a server. |

**Rotating `CREDENTIAL_ENCRYPTION_KEY`:** generate a new key; set `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS=k1:<old key>`,
`CREDENTIAL_ENCRYPTION_KEY=<new key>`, `CREDENTIAL_ENCRYPTION_KEY_ID=k2`; deploy. New data uses `k2`, old data still
decrypts with `k1`. Keep the previous key configured for as long as any old data exists (MFA secrets stay on the
old key until the operator re-enrols MFA; connector tokens move to the new key when refreshed or reconnected).

## 4. Database, Redis and Compose

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | — | hex from `generate-secrets` | Password of the `ooc` database user. Compose builds `DATABASE_URL` from it. Use hex/URL-safe characters only. Changing it later is safe: Postgres re-applies it on each start. |
| `REDIS_PASSWORD` | ✅ | — | hex from `generate-secrets` | Redis `requirepass`; Compose builds `REDIS_URL` from it. |
| `DATABASE_URL` | set by Compose | `postgresql://ooc:${POSTGRES_PASSWORD}@postgres:5432/ooc` | — | Only set yourself when running outside Compose (or for an external database). |
| `REDIS_URL` | set by Compose | `redis://:${REDIS_PASSWORD}@redis:6379/0` | — | Same as above. |
| `WEB_PUBLISH` | — | `127.0.0.1:3100` | `8585` or `0.0.0.0:8585` | Host port for the web container. Default keeps it private (Traefik routes the domain). Set `8585` only for the IP:port trial. |
| `MIGRATE_MODE` | — | `fallback` | `fallback`, `native` | How migrations run: `fallback` uses Prisma's Wasm engine (no binary download), `native` uses `prisma migrate deploy`. |
| `SEED_DRAFT_CATALOGUE` | — | `false` | bool | Inserts the **draft** example catalogue (nothing sellable) on deploy. Idempotent; leave `false` in production once you have real products. |
| `IMAGE_TAG` | — | `local` | `v1.2.0` | Tag of images when using pre-built images (see deploy guide). |
| `WEB_PORT` | — | `3000` | `3000` | `docker-compose.local.yml` only: local port on 127.0.0.1. |

### PostgreSQL tuning and backups (Compose)

| Variable | Default | What it does |
|---|---|---|
| `PG_SHARED_BUFFERS` | `512MB` | ≈ 25 % of RAM (1GB on 8 GB, 2GB on 16 GB). |
| `PG_EFFECTIVE_CACHE_SIZE` | `1536MB` | ≈ 50 % of RAM. |
| `PG_WORK_MEM` | `8MB` | Per sort/hash operation. |
| `PG_MAINTENANCE_WORK_MEM` | `128MB` | Vacuum/index builds. |
| `PG_MAX_CONNECTIONS` | `100` | Connection limit. |
| `PG_LOG_SLOW_MS` | `1000` | Log queries slower than this (ms). |
| `BACKUP_HOUR_UTC` | `21` | Hour of the nightly `pg_dump` (21 UTC = 02:30 IST). |
| `BACKUP_KEEP_DAYS` | `14` | Days of dumps kept in the `pgbackups` volume. |
| `BACKUP_ON_START` | `true` | Take a dump each time the backup service starts (i.e. on each deploy). |

## 5. Email

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `SMTP_URL` | ✅ in production | — | `smtps://user:pass@smtp.example.com:465` or `smtp://user:pass@host:587` | Verification, password reset, invitations, tickets, renewal reminders, approval requests, lockout notices. URL-encode special characters in user/password (`@` → `%40`). |
| `MAIL_FROM` | ◐ (with `SMTP_URL`) | — | `OctaveOneCloud <no-reply@example.com>` | Sender; use a domain with SPF/DKIM set up at your mail provider. |
| `SUPPORT_NOTIFY_EMAIL` | — | — | `support@example.com` | Receives new tickets and customer replies. Without it tickets are only visible in **Admin → Support**. |

## 6. Seller, GST invoices

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `SELLER_LEGAL_NAME` | ◐ when `CASHFREE_ENV` ≠ `disabled` | — | `Octave Cloud Private Limited` | Supplier name on invoices. Until set, paid orders wait without invoices. |
| `SELLER_ADDRESS` | ◐ same | — | `12 MG Road, Bengaluru, Karnataka 560001` | One line. |
| `SELLER_STATE_CODE` | ◐ same (also needed for quotes) | — | `29` (Karnataka) | Two-digit GST state code; decides CGST+SGST vs IGST. |
| `SELLER_GSTIN` | — | — | `29ABCDE1234F1Z5` | Printed when set; confirm registration with your accountant. |
| `INVOICE_PREFIX` | — | `OOC` | 1–4 capitals/digits | Invoice numbers `OOC/26-27/00001`. Do not change during a financial year. |
| `CREDIT_NOTE_PREFIX` | — | `OCN` | 1–4 capitals/digits | Credit note numbers `OCN/26-27/00001`. |

## 7. Payments — Cashfree

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `CASHFREE_ENV` | — | `disabled` | `disabled`, `sandbox`, `production` | `sandbox` only with `APP_ENV=staging`/`development`; `production` only with `APP_ENV=production` and HTTPS. |
| `CASHFREE_CLIENT_ID` | ◐ when enabled | — | from dashboard | Sent as `x-client-id` (server side only). |
| `CASHFREE_CLIENT_SECRET` | ◐ when enabled | — | from dashboard | Sent as `x-client-secret`. |
| `CASHFREE_API_VERSION` | — | `2025-01-01` | `2025-01-01` | Sent as `x-api-version`; confirm in the dashboard. |
| `CASHFREE_WEBHOOK_SECRET` | ◐ when enabled | — | from dashboard | Verifies `x-webhook-signature` on `https://<domain>/api/v1/webhooks/cashfree/pg`. |
| `CASHFREE_SUBSCRIPTIONS_ENABLED` | — | `false` | bool | Accepts Cashfree Subscriptions webhooks at `/api/v1/webhooks/cashfree/subscriptions` (stored for later). Automatic mandate collection is **not implemented**; renewals stay customer-paid. |
| `CASHFREE_SUBSCRIPTION_WEBHOOK_SECRET` | ◐ with the flag | — | from dashboard | Verifies Subscriptions webhooks. |
| `CASHFREE_SUBSCRIPTION_CLIENT_ID`, `CASHFREE_SUBSCRIPTION_CLIENT_SECRET`, `CASHFREE_SUBSCRIPTION_API_VERSION` | — | — | — | Reserved for mandate collection; not used yet. |

## 8. Renewals (customer-paid)

| Variable | Default | Range | What it does |
|---|---|---|---|
| `RENEWAL_NOTICE_DAYS` | `7` | 1–60 | Renewal order + first reminder this many days before the period ends. |
| `RENEWAL_GRACE_DAYS` | `7` | 0–30 | Access continues this long after an unpaid period end, then is suspended (data kept). |
| `RENEWAL_LAPSE_DAYS` | `30` | 1–180 | Subscription ends if still unpaid this many days after the period end (at least grace + 1). |

## 9. Supplier — ResellerClub

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `RESELLERCLUB_ENV` | — | `disabled` | `disabled`, `demo`, `live` | `live` only with `APP_ENV=production` and HTTPS. |
| `RESELLERCLUB_BASE_URL` | ◐ when enabled | — | demo `https://test.httpapi.com/api`, live `https://httpapi.com/api` (verify in docs) | Must be https. |
| `RESELLERCLUB_AUTH_USERID` | ◐ when enabled | — | reseller id | Sent as `auth-userid`; redacted from logs. |
| `RESELLERCLUB_API_KEY` | ◐ when enabled | — | API key | Sent as `api-key`. Use **demo** keys for demo: the test host does not protect live accounts. Allowlist the server IP in the panel. |
| `RESELLERCLUB_ALLOW_LIVE_MUTATIONS` | — | `false` | bool | Second switch required before any chargeable live action; only valid with `live`. Set after release sign-off. |

## 10. Hosted apps (adapters)

One pair per app; the adapter key becomes `app.<name>` in lower case (`APP_ADAPTER_CRM_*` → `app.crm`).

| Variable | Req. | Example | What it does |
|---|---|---|---|
| `APP_ADAPTER_<NAME>_URL` | ◐ per app | `https://crm.internal.example.com/ooc-adapter` | Where the worker sends provisioning/plan-change/suspend calls. |
| `APP_ADAPTER_<NAME>_SECRET` | ◐ per app | ≥ 32 random characters | HMAC secret for both directions: signs our calls to the app, and authenticates the app's calls to `/api/v1/app-api/*` (entitlements, usage, approvals, connector tokens). |

After deploying with these set, an operator admin sets the adapter to `sandbox` (testing) or `active` under
**Admin → Operations console → App adapters**; products using it can only be sold while it is `active`. The console
refuses `sandbox`/`active` while the URL or secret is missing, and `active` without https in production.

## 11. Single sign-on (OIDC)

All three of issuer, client id and secret must be set together. Register the redirect URI
`<API_URL>/v1/auth/oidc/callback` at the identity provider.

| Variable | Req. | Default | Example | What it does |
|---|---|---|---|---|
| `OIDC_ISSUER_URL` | — | — | `https://accounts.google.com` | Issuer (discovery at `/.well-known/openid-configuration`); https in production. |
| `OIDC_CLIENT_ID` | ◐ | — | from the provider | Confidential web client. |
| `OIDC_CLIENT_SECRET` | ◐ | — | from the provider | |
| `OIDC_DISPLAY_NAME` | — | `single sign-on` | `Google Workspace` | Text of the "Sign in with …" button (max 60). |
| `OIDC_SCOPES` | — | `openid email profile` | | Requested scopes. |
| `OIDC_ALLOW_SIGNUP` | — | `false` | bool | `true` creates accounts on first SSO sign-in; `false` only links existing accounts with the same **verified** email. |

## 12. Customer connections (OAuth)

One block per provider; the provider key is `<NAME>` in lower case. Endpoints come from the provider's OAuth
documentation. Register `<API_URL>/v1/connectors/callback` as the redirect URI.

| Variable | Req. | Example | What it does |
|---|---|---|---|
| `CONNECTOR_<NAME>_AUTHORIZE_URL` | ◐ | provider's authorization endpoint | https in production. |
| `CONNECTOR_<NAME>_TOKEN_URL` | ◐ | provider's token endpoint | Client credentials are sent in the form body. |
| `CONNECTOR_<NAME>_CLIENT_ID` | ◐ | | |
| `CONNECTOR_<NAME>_CLIENT_SECRET` | ◐ | | |
| `CONNECTOR_<NAME>_SCOPES` | ◐ | space-separated | Ask for the least privilege needed. |
| `CONNECTOR_<NAME>_APPS` | — | `app.crm,app.marketing` | Only these apps may obtain the customer's token. Empty = none. |
| `CONNECTOR_<NAME>_LABEL` | — | `Gmail` | Name shown to customers. |
| `CONNECTOR_<NAME>_EXTRA_AUTH_PARAMS` | — | `access_type=offline&prompt=consent` | Extra provider-specific authorization parameters. |

If any of the first five is missing for a defined connector, the API refuses to start and names it.

## 13. Reserved (accepted, not used by any feature yet)

`S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — file storage ·
`MODEL_GATEWAY_URL`, `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_DEFAULT_MODEL` — agent runtime gateway ·
`OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` — tracing/error tracking ·
`CASHFREE_SUBSCRIPTION_CLIENT_ID/SECRET/API_VERSION` — mandates. Setting them changes nothing today.

## 14. Set automatically — do not set in Dokploy

| Variable | Set by | Value |
|---|---|---|
| `NODE_ENV` | Compose | `production` |
| `PORT` | Compose (api) | `4000` |
| `API_INTERNAL_URL` | Compose (web) | `http://api:4000` — baked into the web build |
| `DATABASE_URL`, `REDIS_URL` | Compose | built from the passwords |
| `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` | Compose (db-backup) | internal |
| `POSTGRES_USER`, `POSTGRES_DB` | Compose (postgres) | `ooc` |

## 15. Commands and development only

| Variable | Where | What it does |
|---|---|---|
| `OOC_OPERATOR_PASSWORD` | one-off, in the api container terminal | Password for `node dist/cli/create-operator.js --email … --role operator_admin`. Not stored in Dokploy. |
| `OOC_ENABLE_REFERENCE_ADAPTERS` | development only | Comma-separated adapter keys served by the in-memory reference app; ignored when `NODE_ENV=production`. |
| `OOC_DISABLE_THROTTLE` | tests only | Turns off rate limits; ignored when `NODE_ENV=production`. |
| `TEST_DATABASE_URL` | tests | Database for the test suite and `pnpm db:check`. |

---

## Validation rules (startup refuses to run if broken)

- `APP_URL`, `API_URL`, `DATABASE_URL`, `REDIS_URL`, `CREDENTIAL_ENCRYPTION_KEY` (64 hex) are required.
- Production: `APP_URL` https and `COOKIE_SECURE=true`, unless `OOC_ALLOW_INSECURE_HTTP=true` (then `COOKIE_SECURE`
  must be `false` for an `http://` URL) or `OOC_ALLOW_INSECURE_LOCAL=true` with a localhost URL. `SMTP_URL` required.
- `SMTP_URL` must start with `smtp://` or `smtps://`; `MAIL_FROM` required with it.
- `CASHFREE_ENV` ≠ `disabled` ⇒ client id, secret, webhook secret, `SELLER_LEGAL_NAME`, `SELLER_ADDRESS`,
  `SELLER_STATE_CODE` required.
- `APP_ENV=production` forbids `CASHFREE_ENV=sandbox`; only `APP_ENV=production` allows `CASHFREE_ENV=production`
  and `RESELLERCLUB_ENV=live`. `OOC_ALLOW_INSECURE_HTTP` forbids both live modes.
- `RESELLERCLUB_ENV` ≠ `disabled` ⇒ base URL (https), user id and API key required;
  `RESELLERCLUB_ALLOW_LIVE_MUTATIONS` only with `live`.
- OIDC issuer, client id and secret all-or-nothing; issuer https in production.
- Prefixes 1–4 capitals/digits; renewal days within their ranges; connector blocks complete.

After deploying, **Admin → Launch readiness** (or `node dist/cli/preflight.js` in the api container) shows what
is still missing for real customers.
