# Backup and restore

A single host is not high availability. Backups are the recovery mechanism; restore must be rehearsed before launch.

## What to back up

| Data | Method | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump -Fc` to S3-compatible storage (encrypted, separate account) + WAL archiving if RPO < 24h is required | daily full (+ continuous WAL) | 35 days; monthly for 12 months |
| Redis | not required — queues are rebuilt from DB by the sweeper | — | — |
| Object storage | bucket versioning / replication | continuous | per retention policy |
| Secrets | password manager / Dokploy secret export (offline, encrypted) | on change | — |

Example (run from a backup container on the internal network):

```bash
pg_dump -Fc "$DATABASE_URL" | age -r "$BACKUP_PUBLIC_KEY" > ooc-$(date -u +%Y%m%dT%H%MZ).dump.age
# upload with your S3 client to a bucket the app itself cannot delete from
```

## Restore rehearsal (record results in docs/evidence/)

1. Create an empty staging database.
2. Decrypt and `pg_restore --no-owner --dbname "$STAGING_DATABASE_URL" backup.dump`.
3. Run `pnpm --filter @ooc/db migrate:deploy` (should report no pending migrations for the same release).
4. Start api/worker against staging with `CASHFREE_ENV=disabled`, `RESELLERCLUB_ENV=disabled`.
5. Verify: row counts for orders/payment attempts/services vs production at backup time; sign in as an operator;
   audit log continuity.
6. Record time-to-restore and data-loss window.

## After a real restore

Payments or supplier actions may have happened after the backup. Before re-enabling integrations:
reconcile Cashfree orders/payments/refunds and ResellerClub orders for the gap window (see `reconciliation.md`).
