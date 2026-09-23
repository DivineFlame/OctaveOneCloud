# Architecture

## Shape

A TypeScript **modular monolith**: one API process, one worker process, one web process, sharing packages.

```
Browser ──> web (Next.js, only public service) ──/api/*──> api (NestJS) ──> PostgreSQL
                                                              │  enqueue ids
                                                              ▼
Cashfree ──signed webhooks──> api ──> WebhookInbox ──> Redis/BullMQ ──> worker ──> app adapters / ResellerClub
```

- **PostgreSQL** is the source of truth. Queues carry only ids; a sweeper re-enqueues anything that missed its message.
- **Ownership:** the application owns commercial subscriptions and entitlements; Cashfree owns payment and mandate
  events; ResellerClub owns upstream service state. Reconciliation joins them.
- GPU inference and agent execution are **outside** this system, behind an authenticated private gateway
  (`MODEL_GATEWAY_*`). Payment/provisioning workers never share a queue or host pool with GPU jobs.

## Modules

| Concern | Where |
|---|---|
| Identity, sessions, MFA | `apps/api/src/auth` |
| Tenancy & roles | `apps/api/src/orgs` (`OrgGuard`), `packages/shared/src/roles.ts` |
| Catalogue, plan/price versions, activation rules | `apps/api/src/catalogue` |
| Pricing, GST, quotes | `packages/shared/src/{pricing,tax,quote}.ts`, `apps/api/src/quotes` |
| Checkout | `apps/api/src/checkout` |
| Webhook intake | `apps/api/src/webhooks` |
| Payment processing & reconciliation | `packages/integrations/src/payments/processor.ts` |
| Provisioning workflow | `packages/integrations/src/provisioning/engine.ts` |
| App adapter contract | `packages/integrations/src/adapters/contract.ts`, `docs/app-adapter-contract.md` |
| Supplier client & journal | `packages/integrations/src/resellerclub/client.ts` |
| Usage metering | `packages/integrations/src/usage.ts` |
| Agent approvals | `packages/integrations/src/approvals.ts` |
| Audit | `AuditService`, append-only table |

## State machines (local concepts, not provider enums)

- Order: `draft → awaiting_payment → paid → provisioning → active | delayed | needs_attention` (+ `cancelled`, `expired`).
  A paid order never returns to `awaiting_payment`.
- Provisioning job/step: `queued → running → active | partially_failed | failed | unknown_outcome`; `compensating` reserved.
- Subscription: `pending_activation, trialing, active, past_due, grace, suspended, cancel_scheduled, cancelled`.
- Refund: `requested → pending → success | failed | cancelled` — only provider evidence reaches `success`.

## Exactly-once *effects*

Distributed calls are at-least-once. Effects are made idempotent by:
unique keys (`cf_payment_id`, inbox dedupe key, `order-item:<id>` provisioning key, usage `source+sourceEventId`,
`operationKey` for supplier calls, `(org, idempotencyKey)` for checkout) and **conditional updates**
(`UPDATE … WHERE status IN (…)`), backed by database constraints.

## Security notes

- Session cookie: opaque random token, SHA-256 stored, `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- CSRF: cookie-authenticated mutations require an `Origin`/`Referer` matching `APP_URL`/`API_URL`.
- Operators: separate role column, TOTP MFA per session, audited actions.
- Secrets only from environment; config errors name variables but never print values; logs are redacted.
- Customer OAuth tokens: AES-256-GCM with key id (rotation) and tenant-bound AAD.
- Non-root containers, read-only root FS for api/worker, private network for DB/Redis/API.

## Versions

Pinned in `package.json` files and `pnpm-lock.yaml` (2026-09-23): Node 22 LTS, TypeScript 5.9.3, NestJS 11.2.x,
Next.js 16.3.6, React 19.3, Prisma 7.10.0 (+ `@prisma/adapter-pg`), BullMQ 5.81.5, Zod 4.6.5, Vitest 4.1.11,
PostgreSQL 16, Redis 7.4. NestJS 12 and TypeScript 7 were released recently; upgrading is a tracked follow-up once
their ecosystem (SWC/decorator metadata, Nest plugins) is validated.
