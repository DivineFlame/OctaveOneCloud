# Test report — 2026-10-07

Environment: Linux x86_64 (2 vCPU, 7 GB), Node.js 22.22.2, pnpm 10.28.0, PostgreSQL 16, Redis 7.
All provider HTTP (Cashfree, ResellerClub, hosted apps, OIDC and OAuth providers) is mocked or simulated locally.
Nothing here is production certification.

| Step | Command | Result |
|---|---|---|
| Build (all packages & apps, incl. Next.js production build) | `pnpm -r run build` | ✅ pass |
| Typecheck | `pnpm -r run typecheck` | ✅ pass |
| Unit + integration + e2e tests | `pnpm -r run test` | ✅ **135 passed** (shared 29, integrations 65, worker 2, api 39), 0 failed |
| Migration drift | `pnpm db:check` | ✅ 15 migrations match `schema.prisma` + custom SQL |
| Dependency audit (prod) | `pnpm audit --prod` | ✅ no known vulnerabilities (overrides: `mysql2`, `deepmerge-ts`, `sharp`, `source-map-js`) |
| Docker images (api, worker, migrate, web) | `docker build --target …` | ✅ built (stand-in base images; official images build in CI and on Dokploy) |
| Full Compose stack | `docker-compose.yml` | ✅ all migrations applied, services healthy, password-sync restart verified |
| Browser smoke (Playwright/Chromium) | register → verify → org → billing address → invoices, subscriptions (downgrade/withdraw/cancel/keep), renewal order + reminder email, usage, approvals, connections, login; 390 px mobile | ✅ no CSP violations, no app errors (Cashfree SDK unreachable from the sandbox network) |
| Worker in containers | renewal order created and reminder emailed by the sweeper; invoice issued after payment | ✅ |
| Pre-flight | `node dist/cli/preflight.js` in the api container | ✅ runs; correctly reports NOT READY for the test configuration (exit 1) |
| Load test (indicative, build sandbox) | `node scripts/loadtest.mjs` | ✅ see `docs/evidence/load-test-2026-10-07-build-sandbox.md` — repeat on the VPS |

## Coverage by risk

| Scenario | Test |
|---|---|
| Tenant isolation (read, write, quote, probing; invoices, subscriptions, tickets, usage, approvals, connectors) | `apps/api/test/*.test.ts` |
| Manipulated totals / extra fields rejected; server-side pricing | `commerce.test.ts` |
| Duplicate and out-of-order webhooks; success after failed attempts; second payment | `integrations/test/payments.test.ts` |
| Amount/currency mismatch; payments for inactive/changed orders flagged | `payments.test.ts`, `renewals.test.ts`, `upgrades.test.ts` |
| Invalid webhook signatures / raw-body tampering | `commerce.test.ts`, `shared/test/misc.test.ts` |
| Unknown supplier outcomes; insufficient funds; live mutation guard | `integrations/test/clients.test.ts` |
| Price changes preserve accepted quotes; mixed-term baskets | `commerce.test.ts` |
| Bundle partial failure; mock adapter unreachable in production | `provisioning.test.ts`, `worker/test/adapters.test.ts` |
| GST invoices: gap-free numbering under concurrency, FY boundary, immutability, credit-note cap under concurrency | `integrations/test/invoices.test.ts`, `apps/api/test/invoices.test.ts` |
| Refunds: cap under concurrency, provider rejection, timeout → lookup → identical re-send, credit note only after success | `integrations/test/refunds.test.ts`, `apps/api/test/refunds.test.ts` |
| Cancellation at period end, downgrade at renewal, suspend/resume, adapter failure → retry, racing workers | `integrations/test/subscriptions.test.ts` |
| Renewals: notice window, idempotent orders, past due → grace → suspension → lapse, pay-to-restore, operator suspensions not lifted, re-pricing on plan change, reminders once per stage | `integrations/test/renewals.test.ts`, `apps/api/test/subscriptions.test.ts` |
| Upgrades: proration, non-upgrades refused, payment → adapter change, renewal re-priced, stale order expiry, changed-subscription payment flagged | `integrations/test/upgrades.test.ts`, `apps/api/test/subscriptions.test.ts` |
| Concurrent quota enforcement; usage packs additive and expiring; IST month periods | `usage-approvals.test.ts`, `app-usage.test.ts` |
| App API signature, timestamp window, unknown app, unprovisioned org | `apps/api/test/app-api.test.ts` |
| Approval bypass (changed inputs, reuse, wrong hash, wrong role, cross-tenant, expiry, DB immutability) | `usage-approvals.test.ts`, `app-api.test.ts` |
| Login lockout per account, no enumeration, TOTP replay, MFA failure limit | `apps/api/test/auth-hardening.test.ts` |
| OIDC: real ID-token validation against a mock IdP, verified-email linking, invite-only, forged state, open redirect, single-use flow cookie | `apps/api/test/oidc.test.ts` |
| OAuth connectors: PKCE, encrypted storage, allowed apps only, refresh under lock, revoke, roles, forged state | `apps/api/test/connectors.test.ts` |
| Launch readiness report, secrets never exposed, operator_admin only | `apps/api/test/readiness.test.ts` |

## Not covered / blocked (needs accounts or the production server)

- Cashfree sandbox and production (orders, webhooks, refunds) — needs merchant credentials.
- ResellerClub demo/live — needs account access and IP allowlisting.
- A real hosted app behind the adapter contract; a real OIDC provider; real OAuth providers.
- Automatic renewal collection with Cashfree Subscriptions mandates (not implemented; renewals are customer-paid).
- Restore drill, load test and security review on the VPS; accountant review of invoices.
