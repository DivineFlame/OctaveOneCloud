# Deploying OctaveOneCloud on Dokploy

This deploys the whole stack (PostgreSQL, Redis, migrations, API, worker, web) as one Dokploy **Compose**
service built from your GitHub repository. Only the web container is routed publicly; everything else stays on
the private Docker network.

```
Internet ──HTTPS──> Dokploy Traefik ──> web:3000 ──/api/*──> api:4000 ──> postgres, redis
                                                               worker ──> postgres, redis, Cashfree, ResellerClub, apps
```

## 0. Server requirements

> New server? Start with **[deploy-vps.md](deploy-vps.md)** — it prepares Ubuntu 24.04, installs Dokploy and
> links back here for the app steps.

- A Dokploy server (Docker 24+ with Compose v2.24+). **4 GB RAM minimum** — the Next.js build needs ~2 GB;
  8 GB is more comfortable. 2 vCPU, 40 GB disk.
- A domain pointing (A/AAAA record) at the server, e.g. `app.example.com`.
- The server's **static outbound IP** — ResellerClub only accepts API calls from allowlisted IPs.
  Find it with `curl -s https://api.ipify.org` on the server and record it in `docs/runbooks/deployment.md`.

## 1. GitHub repository

Repository: <https://github.com/DivineFlame/OctaveOneCloud> (branch `main`).

```bash
git clone https://github.com/DivineFlame/OctaveOneCloud.git
```

Keep the repository **private**. Check that GitHub Actions CI goes green (tests, Docker builds, audit).

## 2. Connect GitHub to Dokploy

Dokploy → **Settings → Git → GitHub** → create/install the GitHub App and grant it access to the repository.

## 3. Create the Compose service

1. Dokploy → **Projects → Create project** (e.g. `octaveonecloud`) → **Create Service → Compose**.
2. **Provider:** GitHub → repository → branch `main`.
3. **Compose path:** `./docker-compose.yml`. Compose type: **Docker Compose**.
4. **Advanced → Isolated Deployments: ON** (Dokploy then connects Traefik to this stack's own network, so the
   compose file needs no `dokploy-network` wiring).

## 4. Environment variables

Generate secrets on any machine with Node 22:

```bash
node scripts/generate-secrets.mjs
```

Open `deploy/dokploy.env.example`, fill in every `<…>` and paste the result into the service's **Environment**
tab. Dokploy writes it to `.env` next to the compose file; the compose file loads it with `env_file` and builds
`DATABASE_URL` / `REDIS_URL` from `POSTGRES_PASSWORD` / `REDIS_PASSWORD`.

Required in production (the API refuses to start otherwise — the log names the missing variable, never its value):

| Variable | Notes |
|---|---|
| `APP_URL` | `https://app.example.com` |
| `API_URL` | `https://app.example.com/api` (webhook URLs are derived from it) |
| `COOKIE_SECURE` | `true` |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | hex from the generator (must be URL-safe) |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 hex chars; **back it up** — encrypted MFA secrets/tokens are unreadable without it |
| `SMTP_URL`, `MAIL_FROM` | e.g. `smtps://user:pass@smtp.provider.com:465`; used for verification, reset and invitation emails |

Keep `CASHFREE_ENV=disabled` and `RESELLERCLUB_ENV=disabled` until those accounts are verified
(`docs/provider-capabilities.md`). Set `SEED_DRAFT_CATALOGUE=true` for the first deployment only.

## 5. Domain

Service → **Domains → Add domain**:

- **Service name:** `web`
- **Host:** `app.example.com`
- **Container port:** `3000`
- **HTTPS:** on, certificate: Let's Encrypt

Do **not** add domains for `api`, `postgres` or `redis`.

## 6. Deploy

Click **Deploy**. Order of events (see the Logs tab):

1. Images build on the server (first build ~5–10 min).
2. `postgres` and `redis` become healthy.
3. `migrate` applies `packages/db/prisma/migrations` and exits `0` (and seeds the draft catalogue if enabled);
   `db-backup` takes its first dump.
4. `api` and `worker` start; `api` becomes healthy (`/health`).
5. `web` starts once `api` is healthy.

Then set `SEED_DRAFT_CATALOGUE=false` in the Environment tab (it takes effect on the next deploy; re-running the seed is harmless but resets draft product names/notes).

Check: open `https://app.example.com` → register → you should receive the verification email.

## 7. Create the first operator

Dokploy → service → **Terminal** (or SSH to the server) into the `api` container:

```bash
OOC_OPERATOR_PASSWORD='a-long-unique-password' node dist/cli/create-operator.js --email you@example.com --role operator_admin
```

Sign in at `https://app.example.com/login`, open **Dashboard → Security**, enable two-factor authentication, then open
`/admin`. Every operator endpoint requires MFA.

## 8. Backups

- The `db-backup` service dumps PostgreSQL nightly into the `pgbackups` volume (verified, 14-day retention).
- Dokploy → service → **Volume Backups**: copy `<appName>_pgbackups` (not `pgdata`) to an S3 destination daily.
  Details and restore commands: `docs/runbooks/backup-restore.md`.
- Store `CREDENTIAL_ENCRYPTION_KEY` and the other secrets in a password manager.
- Rehearse a restore on a second Dokploy project before launch.

## 9. Going live with payments and supplier (later)

1. Create a second Dokploy project **staging** (own domain, own database) with `APP_ENV=staging`,
   `CASHFREE_ENV=sandbox` + sandbox keys and `RESELLERCLUB_ENV=demo` + **demo** credentials. Production config
   refuses sandbox keys, and staging refuses live Cashfree/ResellerClub, so the two cannot be mixed up.
   Record sandbox evidence in `docs/evidence/`.
2. In the Cashfree dashboard set the webhook URL to `https://app.example.com/api/v1/webhooks/cashfree/pg` and copy
   the signing secret into `CASHFREE_WEBHOOK_SECRET`.
3. ResellerClub: allowlist the server IP, fill `docs/provider-capabilities.md` with evidence, then set
   `RESELLERCLUB_ENV=live` and, only after release sign-off, `RESELLERCLUB_ALLOW_LIVE_MUTATIONS=true`.
4. Review tax rules as `operator_finance`, add prices, publish plan versions and activate products from `/admin`.

## Updating

- Push to `main` → Dokploy **Deploy** (or enable Auto Deploy / webhook in the service's General tab).
- Migrations run automatically before the API starts. Write backward-compatible (expand → contract) migrations so the
  previous version keeps working during the switch.
- Rollback: `git revert` the change on `main` and deploy again (or point the service at a previous commit/tag).
  Do not restore database backups to roll back code.

## Using pre-built images instead (optional)

Tagging `vX.Y.Z` runs `.github/workflows/release.yml`, which pushes
`ghcr.io/<owner>/<repo>/{api,worker,migrate,web}:X.Y.Z`. To deploy those instead of building on the server, add a
Dokploy registry credential for `ghcr.io` and replace each `build:` block in a copy of the compose file with
`image: ghcr.io/<owner>/<repo>/<target>:X.Y.Z`. Note the web image bakes `API_INTERNAL_URL=http://api:4000` at build time.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `api` restarting, log says `Invalid configuration: …` | Missing/invalid variable named in the message |
| `required variable POSTGRES_PASSWORD is missing a value` | Environment tab is empty or not saved — paste `deploy/dokploy.env.example` values and Save |
| No domain yet | Use `http://<ip>:8080` (docs/deploy-vps.md, "Run on IP:port") or `<ip-with-dashes>.sslip.io` with HTTPS |
| `migrate` exits non-zero | Read its log; `…previously failed` means a failed migration must be resolved before redeploying |
| 404/502 on the domain | Domain must target service `web`, port `3000`; Isolated Deployments on (or add `dokploy-network` to `web`) |
| Emails not arriving | Check `SMTP_URL` credentials/port and SPF/DKIM for the `MAIL_FROM` domain; API logs `Mail delivery failed` |
| Build killed / out of memory | Server needs ≥4 GB RAM or add swap |
| ResellerClub calls rejected | Server outbound IP not allowlisted |

### Without Isolated Deployments

Add the external Dokploy network to the `web` service in your compose file:

```yaml
services:
  web:
    networks: [default, dokploy-network]
networks:
  dokploy-network:
    external: true
```
