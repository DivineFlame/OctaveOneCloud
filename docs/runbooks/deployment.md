# Deployment & rollback (Dokploy / Docker Compose)

Step-by-step Dokploy setup: **[docs/deploy-dokploy.md](../deploy-dokploy.md)**. This page covers release discipline.

Server egress IP(s) allowlisted at ResellerClub: _record here_

## First deployment (staging)

1. Provision a host; record its **static egress IP(s)** and allowlist them in the ResellerClub panel.
2. In Dokploy create a Compose app from this repository, compose file `docker-compose.yml`.
3. Add secrets (never commit `.env`): everything in `.env.example` plus `POSTGRES_PASSWORD`, `REDIS_PASSWORD`.
   - `NODE_ENV=production`, `COOKIE_SECURE=true`, `APP_URL=https://<domain>`, `API_URL=https://<domain>/api`.
   - Start with `CASHFREE_ENV=disabled` and `RESELLERCLUB_ENV=disabled`; enable sandbox/demo only on staging.
4. Route the domain to the `web` service (port 3000) with TLS in Dokploy/Traefik. Do **not** expose api, postgres or redis.
5. Deploy. The `migrate` service runs `prisma migrate deploy` (set `MIGRATE_MODE=fallback` if engine download is blocked).
6. `docker compose exec api node apps/api/dist/cli/create-operator.js --email … --role operator_admin` with
   `OOC_OPERATOR_PASSWORD` set for that command only; sign in and enable MFA.
7. Configure Cashfree webhook URLs: `https://<domain>/api/v1/webhooks/cashfree/pg`
   (and `/subscriptions` only when Subscriptions are enabled). Record the signing secret in `CASHFREE_WEBHOOK_SECRET`.
8. Check `GET /api/v1/…` via the operations console → Integrations; `GET /ready` from inside the network.

## Release

1. CI green (`typecheck`, tests, `db:check`).
2. Tag the commit; build images; **pin base images by digest** in `docker/Dockerfile` and `docker-compose.yml`.
3. Take a database backup (see `backup-restore.md`).
4. Deploy. Migrations must be backward compatible with the previous release (expand → migrate → contract).

## Rollback

- Application: redeploy the previous image tag. Because migrations are expand-first, the previous version runs on the
  newer schema.
- Database: never roll back by restoring a backup while payments are flowing; that loses payment records.
  If a migration must be reverted, write a forward migration. Restores are for disaster recovery only and require
  reconciliation with Cashfree/ResellerClub afterwards.

## Kill switches

- `CASHFREE_ENV=disabled` stops new checkouts (webhooks for existing orders then return 403 — prefer leaving
  payments enabled and setting products to `draft` instead).
- `RESELLERCLUB_ALLOW_LIVE_MUTATIONS=false` stops all chargeable supplier calls immediately on restart.
- Setting a product to `draft` removes it from sale without affecting existing customers.
