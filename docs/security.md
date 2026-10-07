# Security overview

What the application enforces, so a reviewer can verify it. Nothing here replaces the launch-gate security review
and penetration test.

## Accounts and sessions

| Control | Implementation |
|---|---|
| Passwords | Argon2id; minimum length enforced server-side |
| Sessions | Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` required in production); only its SHA-256 is stored; expiry `SESSION_TTL_HOURS`; all sessions revoked on password reset |
| CSRF | State-changing requests must carry an `Origin`/`Referer` matching `APP_URL`/`API_URL`, plus `SameSite=Lax` |
| Login brute force | Per client IP: 10 attempts/min. Per account: 10 consecutive failures lock sign-in for 15 minutes (any IP) and email the owner. Locked, unknown, disabled and wrong-password logins get the same `invalid_credentials` response. Password reset unlocks. |
| Account enumeration | Login and password-reset responses do not reveal whether an email exists. Registration does answer `email_in_use` (a usual sign-up trade-off), rate-limited to 10/min per IP. |
| Operator MFA | TOTP required for every operator route (`operator_support`, `operator_finance`, `operator_admin`); secret encrypted with `CREDENTIAL_ENCRYPTION_KEY`; a code is accepted once (replays rejected); 5 wrong codes end the session |
| Roles | Org roles owner/admin/billing/member with a permission matrix; operators are separate and never inferred from org roles |
| Tenant isolation | Every `/orgs/:orgId/*` route checks membership (non-members get 404); queries are scoped by `orgId`; covered by e2e tests |

## Transport and browser

- HTTPS terminates at Traefik (Dokploy). `Strict-Transport-Security: max-age=31536000` on all pages.
- `Content-Security-Policy`: own origin only, plus `sdk.cashfree.com` (script) and `*.cashfree.com`
  (connect/frame/form); `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`. Next.js needs
  `'unsafe-inline'` for its bootstrap scripts; no third-party inline code is used.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (camera/microphone/geolocation off). The API adds Helmet defaults.
- The API is not published: browsers reach it only through the web proxy (`/api/*`), so cookies stay first-party.
- Rate limits key on the client IP from `X-Forwarded-For` as set by Traefik (one trusted hop: the web proxy).
  In the IP:port trial mode there is no Traefik, so all visitors share one bucket.
- `OOC_DISABLE_THROTTLE` (tests) is ignored when `NODE_ENV=production`.

## Payments and suppliers

- Totals are computed on the server from frozen quotes; the browser only receives a Cashfree payment session id.
- Webhooks: signature checked over the raw body with the configured secret, stored in a durable inbox before
  acknowledgement, processed idempotently; browser redirects never mark anything paid.
- Refunds: finance operators only (MFA), capped at the confirmed paid amount under a row lock, idempotent provider
  calls, audited.
- ResellerClub: live mutations need `RESELLERCLUB_ENV=live` **and** `RESELLERCLUB_ALLOW_LIVE_MUTATIONS=true`;
  credentials are redacted from logs.
- Configuration refuses to mix production with sandbox/demo credentials and refuses live providers in the IP:port
  trial mode.

## Data and secrets

- Secrets only in Dokploy environment variables; `.env` files are git-ignored; startup validation never prints values.
- Customer OAuth tokens and MFA secrets are encrypted (AES-256-GCM) with `CREDENTIAL_ENCRYPTION_KEY`, key id stored
  for rotation.
- Logs are structured JSON with redaction of credentials, tokens and signatures; mail bodies (which contain one-time
  links) are never logged.
- Audit log is append-only (database trigger); issued invoices and credit notes are immutable (triggers).
- PostgreSQL and Redis are on the internal Docker network only; Redis requires a password.
- Containers run as non-root with `no-new-privileges`; images are rebuilt from the lockfile.

## Dependencies

- `pnpm audit --prod --audit-level high` runs in CI. On 2026-10-07 two high advisories reached through Next.js
  (`sharp` < 0.35.5, `source-map-js` < 1.2.2) were fixed with `pnpm.overrides`; the audit is clean.
- Re-run before each release; Dependabot or Renovate is recommended on the GitHub repository.

## Known limits / to review

- CSP allows `'unsafe-inline'` scripts (Next.js); a nonce-based CSP needs dynamic rendering of every page.
- No WAF or bot protection beyond rate limits; consider Cloudflare in front of Traefik for DDoS absorption.
- OIDC login for staff is not implemented yet (password + TOTP only).
