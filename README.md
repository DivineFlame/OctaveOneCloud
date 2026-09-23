# OctaveOneCloud

Multi-tenant subscription commerce and customer management platform for Indian businesses:
conventional web products (via ResellerClub), hosted business apps and agentic bundles, paid through Cashfree.

> **Status:** foundation + paid-purchase + app-provisioning core, tested locally against PostgreSQL and Redis.
> Not production-certified. No provider credentials have been used. See [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Layout

```
apps/api            NestJS HTTP API (auth, tenancy, catalogue, quotes, checkout, webhooks, admin)
apps/worker         BullMQ worker (webhook inbox, provisioning, reconciliation, sweeper)
apps/web            Next.js storefront, customer dashboard, operations console
packages/shared     Pure domain logic: money, pricing, GST calc, state machines, config, crypto, redaction
packages/db         Prisma schema, migrations, seed, client factory
packages/integrations  Cashfree & ResellerClub clients, payment processor, provisioning engine,
                    app-adapter contract, usage metering, approvals
docs/               Capability matrix, architecture, runbooks, adapter contract, OpenAPI, test report
docker/             Multi-target Dockerfile (api, worker, web, migrate)
```

## Local development

Requirements: Node.js 22.12+, pnpm 10 (`corepack enable`), Docker (for Postgres/Redis) or local installs.

```bash
cp .env.example .env                       # then generate CREDENTIAL_ENCRYPTION_KEY (see comment in file)
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm db:generate
pnpm db:migrate                            # or: pnpm --filter @ooc/db migrate:deploy:fallback
pnpm db:seed                               # draft catalogue only — nothing is purchasable
pnpm -r build
pnpm dev:api    # http://localhost:4000
pnpm dev:worker
pnpm dev:web    # http://localhost:3000  (proxies /api/* to the API)
```

Create an operator (then enable MFA under Dashboard → Security):

```bash
OOC_OPERATOR_PASSWORD='a-long-password' pnpm operator:create --email you@example.com --role operator_admin
```

To exercise provisioning locally without a real app, set `OOC_ENABLE_REFERENCE_ADAPTERS=app.crm` for the worker
(ignored in production).

## Tests

```bash
createdb ooc_test        # tests refuse to touch a database whose name lacks "test"
pnpm -r test             # unit + integration (Postgres) + API e2e (Postgres + Redis)
pnpm db:check            # migrations ↔ schema.prisma drift check
```

## Key rules baked into the code

- Money is integer paise (`BigInt` in Postgres); decimals only at provider boundaries, parsed exactly.
- Browser redirects never mark anything paid; only signed webhooks or the Cashfree status API do.
- Every supplier mutation is journaled; timeouts become `unknown` and must be reconciled before retry.
- Products stay `draft` until adapters, verified supplier capabilities, prices and reviewed tax rules exist.
- Published plan features and price versions are immutable (enforced by database triggers).
- Agent actions needing approval bind to a hash of the exact inputs and are single-use.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/runbooks/`](docs/runbooks).
