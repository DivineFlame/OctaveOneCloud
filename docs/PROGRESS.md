# Progress checklist

Last updated 2026-09-23. Legend: ✅ implemented and tested here · 🟡 implemented, not verified against a real provider · ⛔ blocked (needs access/credentials/decision) · ⬜ not started.

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
| OIDC login with existing identity provider | ⬜ | Config placeholders only |
| SMTP transport | ⬜ | Dev capture only; production refuses to drop mail |
| Invoice numbering / PDF / credit-note issuing | ⬜ | Models exist; issuing flow not built |

## Stage 2 — Paid purchase

| Item | State | Notes |
|---|---|---|
| Cashfree order creation + hosted checkout page | 🟡 | Mocked HTTP in tests; needs sandbox credentials |
| Webhook intake: raw-body signature, durable inbox, dedupe, async processing | ✅ | |
| Payment processing: idempotent, out-of-order safe, amount/currency validation, duplicate-payment flagging | ✅ | Integration tests on Postgres |
| Reconciliation via status API + periodic sweeper | 🟡 | Logic tested with mocks |
| Refund / dispute event handling | 🟡 | Refund *initiation* API not built |
| One eligible ResellerClub product end-to-end | ⛔ | Blocked on capability verification |
| Supplier journal + unknown-outcome recovery | ✅ | Operator resolve endpoint |

## Stage 3 — App subscriptions

| Item | State | Notes |
|---|---|---|
| Versioned adapter contract (HTTP, signed) + reference adapter + registry | ✅ | Reference adapter refuses production |
| Provisioning workflow with evidence, bundles, partial failure, retry of failed components | ✅ | |
| Entitlement grants with merge policies (no double-grant) | ✅ | |
| Subscription record on activation | ✅ | Lifecycle (cancel/downgrade/suspend) not built |
| One real hosted app connected | ⛔ | Needs an operational app |
| Usage metering reserve/settle, concurrent caps | ✅ | Not yet exposed via API |
| Access revocation (suspend/resume) flows | ⬜ | Adapter methods exist |

## Stage 4 — Recurrence and combos

| Item | State |
|---|---|
| Mandates (Cashfree Subscriptions), single collection owner | ⬜ (schema ready, events stored) |
| Renewals, reminders, dunning, grace periods | ⬜ (`RenewalRun` uniqueness guard exists) |
| Upgrades (prorated quote), scheduled downgrades, cancel at period end | ⬜ |
| Agent approval policies | ✅ library (`approvals.ts`); ⬜ API/UI |
| Agent runtime gateway, tool/connector scopes, budgets | ⬜ |
| Connector grants (encrypted OAuth tokens) | 🟡 cipher + schema; ⬜ OAuth flows |

## Stage 5 — Launch gates (all ⛔ until done)

- [ ] Merchant/account activation (Cashfree production, ResellerClub live)
- [ ] Production webhook URLs and secrets configured
- [ ] Every product for sale has verified capabilities and prices
- [ ] Accountant sign-off on tax rules and invoice format
- [ ] Docker images built and deployed to staging via Dokploy
- [ ] Backup restore rehearsal recorded
- [ ] Load test with measured capacity recorded
- [ ] Security review (dependency audit, headers, auth flows, pen test)
- [ ] Reconciliation sign-off (payments ↔ orders ↔ supplier records)
- [ ] Migration rehearsal for existing customers (no re-ordering, no re-charging)
- [ ] Explicit release authorisation

## Environment limitations during this build

- Docker images could not be built here (Docker Hub blocked); Dockerfile and Compose are untested.
- Prisma's native schema-engine download was blocked; migrations were generated and applied with Prisma's own Wasm
  engine (same commit) via `packages/db/scripts/schema-engine-wasm.mjs`. Standard `prisma migrate` works where
  `binaries.prisma.sh` is reachable.
- No Cashfree or ResellerClub credentials were used; provider behaviour is mocked in tests.
