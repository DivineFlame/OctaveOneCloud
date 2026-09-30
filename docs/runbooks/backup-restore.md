# Backup and restore (PostgreSQL in the app stack)

A single VPS is not high availability. Backups are the recovery mechanism; restores must be rehearsed.

## What is backed up, and how

| Data | Mechanism | Where | Frequency | Retention |
|---|---|---|---|---|
| PostgreSQL (`pgdata`) | `db-backup` service: `pg_dump -Fc`, verified with `pg_restore --list` | `pgbackups` volume on the VPS | daily at `BACKUP_HOUR_UTC` (default 21:00 UTC = 02:30 IST) + on every deploy | `BACKUP_KEEP_DAYS` (default 14); pruning only after a successful dump |
| Off-site copy | Dokploy **Volume Backups** of `pgbackups` → S3 destination | your S3/R2/B2 bucket | daily, after the dump (e.g. 22:00 UTC) | set in Dokploy / bucket lifecycle (35 days + monthly) |
| Redis | not backed up — job queues are rebuilt from the database by the sweeper | — | — | — |
| Secrets | password manager (`CREDENTIAL_ENCRYPTION_KEY`, DB/Redis passwords, provider keys) | offline | on change | — |

The `db-backup` container turns **unhealthy** when no dump succeeded in 26 hours — Dokploy shows this on the service.

Do **not** use a Dokploy Volume Backup of `pgdata` itself as the primary backup: copying a live database directory
can produce an inconsistent snapshot. Back up the dumps in `pgbackups` instead.

## Everyday commands (on the VPS, as root)

The helper lives in the repository; Dokploy keeps a checkout on the server, or download it:

```bash
curl -fsSLo restore.sh https://raw.githubusercontent.com/DivineFlame/OctaveOneCloud/main/deploy/postgres/restore.sh
chmod +x restore.sh

./restore.sh list                 # dumps + time of last success
./restore.sh backup               # dump now (e.g. before a risky release)
./restore.sh drill                # restore newest dump into a scratch DB, compare row counts, drop it
./restore.sh drill ooc-20261001T210000Z.dump
./restore.sh replace ooc-20261001T210000Z.dump   # DESTRUCTIVE — see below
```

If several OctaveOneCloud stacks run on the server (e.g. production and staging), add `-p <dokploy-app-name>`.

Copy a dump off the server:

```bash
docker cp "$(docker ps --filter label=com.docker.compose.service=db-backup -q)":/backups/ooc-<timestamp>.dump .
```

## Monthly restore drill (launch gate)

1. `./restore.sh drill` — it prints restore time, live vs. backup row counts and the latest migration.
2. Record date, dump name, duration and counts in `docs/evidence/restore-drill-YYYY-MM.md`.
3. Once a quarter, also restore an **off-site** copy: download it from S3, `docker cp` it into the `db-backup`
   container's `/backups`, and run `./restore.sh drill <name>`.

## Full restore (`replace`)

`replace` stops web/api/worker, takes a safety dump of the current database, drops and recreates `ooc`,
restores the chosen dump and starts the app again. You must type the project name to confirm.

Before running it:

- Set `CASHFREE_ENV=disabled` and `RESELLERCLUB_ENV=disabled` in Dokploy (payments and supplier actions after the
  dump time are not in the backup).
- Note the dump timestamp: everything after it must be reconciled.

## After a real restore

Payments or supplier actions may have happened after the backup. Before re-enabling integrations,
reconcile Cashfree orders/payments/refunds and ResellerClub orders for the gap window (see `reconciliation.md`).
Customers who signed up after the dump must register again.

## Losing the whole server

1. New VPS → `deploy/vps/setup-ubuntu.sh` → Dokploy → same Compose service and **the same environment values**
   (especially `CREDENTIAL_ENCRYPTION_KEY` and `POSTGRES_PASSWORD`).
2. Deploy with `SEED_DRAFT_CATALOGUE=false`.
3. Download the latest off-site dump, `docker cp` it into the `db-backup` container and run `./restore.sh replace <name>`.
4. Point DNS at the new IP; update the ResellerClub IP allowlist.
