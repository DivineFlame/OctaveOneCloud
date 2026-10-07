# Progress checklist

Last updated 2026-10-07. Legend: ✅ implemented and tested here · 🟡 implemented, not verified against a real provider · ⛔ blocked (needs access/credentials/decision) · ⬜ not started.

Nothing here is production-certified. No real purchase, payment collection, DNS change or customer migration has been performed.

## Stage 0 — Discovery

| Item | State | Notes |
|---|---|---|
| Inventory current octaveonecloud.com catalogue | ⛔ | Site catalogue not retrievable during research; need an export or admin access |
| Inventory authenticated ResellerClub account products & eligibility | ⛔ | Needs panel access; see `provider-capabilities.md` |
| Existing customer / service mapping (IDs, renewal dates) | ⛔ | Needs legacy data export; import path is `Service.importedFromLegacy` |
| App onboarding contracts per hosted app | ⛔ | Which apps are operational and licensed? |
| Verify Cashfree merchant capabilities (PG, Subscriptions) | ⛔ | Needs merchant dashboard |
| Provider capability matrix document | ✅ | `docs/provider-capabilities.md` (all rows unverified) |
| Pinned dependency versions + lockfile | ✅ | `pnpm-lock.yaml`; see `docs/architecture.md#versions` |

## Stage 1 — Foundation

| Item | State | Notes |
|---|---|---|
| Monorepo (web / api / worker / shared / db / integrations) | ✅ | pnpm workspaces |
| Startup configuration validation, secrets never echoed | ✅ | `packages/shared/src/config.ts` |
| Data model (orgs → audit, 50+ entities) + migrations | ✅ | Prisma 7; drift check `pnpm db:check` |
| DB invariants (CHECKs, immutable prices/published features, append-only audit, one paid PaymentOrder per order) | ✅ | `20260923000100_invariants` |
| Auth: register, login, logout, hashed sessions, email verification, password reset | ✅ | Argon2id; SameSite=Lax + Origin check |
| Operator roles + TOTP MFA enforced on admin routes | ✅ | |
| Organisations, memberships, invitations (email-bound), owner/admin/billing/member | ✅ | |
| Tenant isolation on every org route (404 for non-members) | ✅ | e2e tests |
| Catalogue: draft products, plan versions, immutable price versions, publish, activation blockers | ✅ | |
| Tax: accountant-reviewable rules; unreviewed rules refused for live quotes | ✅ | Seeded GST rules are placeholders pending review |
| Quotes: server-side pricing, frozen snapshot, expiry, mixed-term grouping | ✅ | |
| Admin console (integrations, catalogue readiness) | ✅ | Minimal UI |
| Structured redacted logs, health/readiness | ✅ | |
| Security hardening: CSP/HSTS, per-account login lockout, TOTP replay protection, MFA failure limit, clean dependency audit | ✅ | `docs/security.md` |
| Load-test script + indicative baseline | ✅ | `scripts/loadtest.mjs`; VPS run still required (`docs/evidence/`) |
| VPS bootstrap (Ubuntu 24.04 hardening + Dokploy install) | 🟡 | `deploy/vps/setup-ubuntu.sh`; shellcheck-clean, not yet run on a real VPS |
| PostgreSQL in stack: tuning, nightly verified dumps, restore/drill tooling | ✅ | `db-backup` service + `deploy/postgres/restore.sh`; backup, drill and full replace tested on the Compose stack |
| OIDC login with existing identity provider | ⬜ | Config placeholders only |
| SMTP transport | ✅ | nodemailer via `SMTP_URL`; required in production |
| GST invoices: auto-issue on payment, gap-free FY numbering, immutability, credit notes, printable view | ✅ | `docs/invoicing.md`; accountant sign-off pending; no e-invoicing (IRN) |
| Support tickets (customer + operator queue, internal notes, email) | ✅ | |

## Stage 2 — Paid purchase

| Item | State | Notes |
|---|---|---|
| Cashfree order creation + hosted checkout page | 🟡 | Mocked HTTP in tests; needs sandbox credentials |
| Webhook intake: raw-body signature, durable inbox, dedupe, async processing | ✅ | |
| Payment processing: idempotent, out-of-order safe, amount/currency validation, duplicate-payment flagging | ✅ | Integration tests on Postgres |
| Reconciliation via status API + periodic sweeper | 🟡 | Logic tested with mocks |
| Refund / dispute event handling | 🟡 | Webhooks + status API; mocked in tests |
| Refund initiation (finance operators, capped, idempotent, timeout-safe, credit note on confirmation) | 🟡 | `docs/invoicing.md#refunds`; Cashfree mocked — needs sandbox run |
| One eligible ResellerClub product end-to-end | ⛔ | Blocked on capability verification |
| Supplier journal + unknown-outcome recovery | ✅ | Operator resolve endpoint |

## Stage 3 — App subscriptions

| Item | State | Notes |
|---|---|---|
| Versioned adapter contract (HTTP, signed) + reference adapter + registry | ✅ | Reference adapter refuses production |
| Provisioning workflow with evidence, bundles, partial failure, retry of failed components | ✅ | |
| Entitlement grants with merge policies (no double-grant) | ✅ | |
| Subscription record on activation | ✅ | |
| Subscription lifecycle: cancel at period end, scheduled downgrade, operator suspend/resume (worker → adapters, evidence-gated, retried) | ✅ | `docs/subscriptions.md`; reference adapter only |
| One real hosted app connected | ⛔ | Needs an operational app |
| Usage metering reserve/settle, concurrent caps | ✅ | |
| Signed app service API (entitlements, reserve/settle/release), monthly quotas, usage packs, customer usage page | ✅ | `docs/app-adapter-contract.md#calling-octaveonecloud-app-service-api` |
| Access revocation (suspend/resume) flows | ✅ | Entitlements revoked/restored; data never deleted |

## Stage 4 — Recurrence and combos

| Item | State |
|---|---|
| Mandates (Cashfree Subscriptions), single collection owner | ⬜ (schema ready, events stored) |
| Customer-paid renewals: renewal orders, reminders, past due → grace → suspension → lapse, pay-to-restore | ✅ (`docs/subscriptions.md#renewals-customer-paid`) |
| Automatic renewal collection via mandates | ⬜ (needs Cashfree Subscriptions) |
| Scheduled downgrades, cancel at period end | ✅ |
| Upgrades (prorated quote + payment) | ⬜ |
| Agent approval policies | ✅ library (`approvals.ts`); ⬜ API/UI |
| Agent runtime gateway, tool/connector scopes, budgets | ⬜ |
| Connector grants (encrypted OAuth tokens) | 🟡 cipher + schema; ⬜ OAuth flows |

## Stage 5 — Launch gates (all ⛔ until done)

Automated part: **Admin → Launch readiness** / `node dist/cli/preflight.js` (exit 1 while any check fails).


- [ ] Merchant/account activation (Cashfree production, ResellerClub live)
- [ ] Production webhook URLs and secrets configured
- [ ] Every product for sale has verified capabilities and prices
- [ ] Accountant sign-off on tax rules and invoice format
- [ ] Deployed to a staging Dokploy project (`APP_ENV=staging`) and smoke-tested
- [ ] Backup restore rehearsal recorded (`restore.sh drill` on the VPS + one off-site copy)
- [ ] Load test with measured capacity recorded
- [ ] Security review (dependency audit, headers, auth flows, pen test)
- [ ] Reconciliation sign-off (payments ↔ orders ↔ supplier records)
- [ ] Migration rehearsal for existing customers (no re-ordering, no re-charging)
- [ ] Explicit release authorisation

## Environment limitations during this build

- Docker Hub was unreachable, so the four images were built and the full `docker-compose.yml` stack was run with
  locally assembled stand-ins for the `node`, `postgres` and `redis` base images (same Node 22.22.2 / PostgreSQL 16 /
  Redis binaries). Migrations, seed, API, worker, web, SMTP email delivery, registration → verification →
  org creation → password reset, and webhook raw-body signature verification through the web proxy all passed.
  The first build against the official images happens in GitHub Actions (`docker` job) and on Dokploy.
- Prisma's native schema-engine download was blocked; migrations were generated and applied with Prisma's own Wasm
  engine (same commit) via `packages/db/scripts/schema-engine-wasm.mjs`. Standard `prisma migrate` works where
  `binaries.prisma.sh` is reachable.
- No Cashfree or ResellerClub credentials were used; provider behaviour is mocked in tests.
