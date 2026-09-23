# Test report — 2026-09-23

Environment: Linux x86_64, Node.js 22.22.2, pnpm 10.28.0, PostgreSQL 16, Redis 7 (local services).
Run from a **fresh clone** with `pnpm install --frozen-lockfile`.

| Step | Command | Result |
|---|---|---|
| Build (all packages & apps, incl. Next.js production build) | see CI workflow | ✅ pass |
| Typecheck | `pnpm -r run typecheck` | ✅ pass |
| Unit + integration + e2e tests | `pnpm -r run test` | ✅ **71 passed**, 0 failed |
| Migration drift | `pnpm db:check` | ✅ migrations match `schema.prisma` (probe column correctly detected as drift) |
| Dependency audit (prod) | `pnpm audit --prod` | ✅ no known vulnerabilities (after `mysql2`/`deepmerge-ts` overrides for Prisma CLI transitive deps) |
| Browser smoke (Playwright/Chromium) | register → dashboard → create org → save billing; desktop + 390px mobile | ✅ no console errors |

## Coverage by risk (from the implementation prompt)

| Scenario | Test |
|---|---|
| Tenant isolation (read, write, quote, probing) | `apps/api/test/auth-tenancy.test.ts` |
| Manipulated totals / extra fields rejected; server-side pricing | `commerce.test.ts › prices on the server…` |
| Duplicate and out-of-order webhooks | `integrations/test/payments.test.ts` (redelivery, 8× concurrent, stale PENDING/FAILED) |
| Successful collection after failed attempts | `payments.test.ts › accepts a success after a failed attempt…` |
| Second successful payment | flagged `duplicate_payment`, no re-fulfilment |
| Amount/currency mismatch | order → `needs_attention`, no provisioning |
| Invalid webhook signatures / raw-body tampering | `commerce.test.ts`, `shared/test/misc.test.ts` |
| Unknown supplier outcomes; no blind retry of chargeable calls | `integrations/test/clients.test.ts` |
| Insufficient supplier funds | `clients.test.ts` |
| Live supplier mutation without explicit authorisation | `clients.test.ts` |
| Price changes preserve accepted quotes; DB-immutable prices | `commerce.test.ts` |
| Mixed-term baskets | `commerce.test.ts` |
| Bundle partial failure and component retry | `provisioning.test.ts` |
| Mock adapter unreachable in production | `provisioning.test.ts`, `worker/test/adapters.test.ts` |
| Concurrent quota enforcement | `usage-approvals.test.ts` (25 concurrent reservations, cap 10) |
| Approval bypass (changed inputs, reuse, cross-tenant, expiry) | `usage-approvals.test.ts` |
| Refunds only confirmed by provider evidence | `payments.test.ts` |
| Operator MFA per session; CSRF origin check | `commerce.test.ts`, `auth-tenancy.test.ts` |

## Not covered / blocked

- Mandate-without-payment, concurrent renewals, cancellation/downgrade rules, failed refunds initiated by us:
  **Stage 4 not implemented yet.**
- Cashfree and ResellerClub **sandbox** integration: no credentials; all provider HTTP is mocked.
- Docker image build, Compose deployment, load test, backup-restore rehearsal: not run in this environment.
