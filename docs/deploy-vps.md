# OctaveOneCloud on a VPS with Dokploy — start here

End-to-end guide: fresh Ubuntu 24.04 VPS → hardened server → Dokploy → OctaveOneCloud with PostgreSQL,
Redis, API, worker and web in one Compose stack, nightly database backups and off-site copies.

```
                 ┌──────────────────────────── VPS (Ubuntu 24.04) ────────────────────────────┐
Internet ─443──> │ Traefik (Dokploy) ──> web:3000 ──/api/*──> api:4000 ──┬──> postgres:5432  │
                 │                                   worker ─────────────┤    (pgdata vol)   │
                 │ Dokploy panel (:3000 → own domain)                    └──> redis:6379     │
                 │                                   db-backup ── nightly pg_dump ──> pgbackups vol ──> S3 (Dokploy) │
                 └────────────────────────────────────────────────────────────────────────────┘
```

Only ports 22, 80 and 443 are open once setup is finished. PostgreSQL and Redis are never reachable from the
internet.

## 1. Choose the VPS

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB (+4 GB swap) | 8 GB |
| Disk | 40 GB SSD | 80 GB NVMe |
| OS | **Ubuntu 24.04 LTS** (64-bit, x86_64) | same |
| Location | India region (Mumbai/Bangalore) for latency to customers and Indian payment/supplier APIs | |

Also needed: a **static IPv4 address** (ResellerClub allowlists it), your SSH public key added in the provider's
panel, and an S3-compatible bucket for off-site backups (AWS S3, Cloudflare R2, Backblaze B2, Wasabi…).

PostgreSQL sizing in `docker-compose.yml` defaults to a 4–8 GB server. For larger servers set in Dokploy:

| RAM | `PG_SHARED_BUFFERS` | `PG_EFFECTIVE_CACHE_SIZE` | `PG_MAINTENANCE_WORK_MEM` |
|---|---|---|---|
| 4 GB | 512MB (default) | 1536MB (default) | 128MB (default) |
| 8 GB | 1GB | 4GB | 256MB |
| 16 GB | 2GB | 8GB | 512MB |

## 2. DNS

Create two A records pointing at the VPS IP (TTL 300 while setting up):

| Record | Purpose |
|---|---|
| `app.example.com` (or the apex `octaveonecloud.com`) | the OctaveOneCloud site |
| `dokploy.example.com` | the Dokploy admin panel |

## 3. Prepare the server (one command)

SSH in as root and run the bootstrap script — read it first, it is short:

```bash
ssh root@<server-ip>
curl -fsSLo setup-ubuntu.sh https://raw.githubusercontent.com/DivineFlame/OctaveOneCloud/main/deploy/vps/setup-ubuntu.sh
less setup-ubuntu.sh
bash setup-ubuntu.sh
```

It will: update the system and enable automatic security updates; add a 4 GB swap file; tune kernel settings for
Redis/Postgres; create a sudo user `ooc` with your SSH key; disable SSH password login (only when a key is present);
enable fail2ban; enable the firewall (22, 80, 443, and 3000 temporarily for the Dokploy panel); set Docker log
rotation; install Dokploy with its official installer; and print the server IP.

(If the repository is private, copy the script with `scp deploy/vps/setup-ubuntu.sh root@<ip>:` instead of curl.)

## 4. Secure the Dokploy panel

1. Open `http://<server-ip>:3000` **immediately** and create the admin account (enable 2FA in your profile).
2. Dokploy → **Settings → Web Server / Server domain**: set `dokploy.example.com` with Let's Encrypt HTTPS.
3. Confirm `https://dokploy.example.com` works, then close the raw port on the server:

   ```bash
   docker service update --publish-rm "published=3000,target=3000,mode=host" dokploy
   ufw delete allow 3000/tcp
   ```

## 5. Deploy OctaveOneCloud

Follow **[deploy-dokploy.md](deploy-dokploy.md), steps 2–7**: connect GitHub, create the Compose service from
`DivineFlame/OctaveOneCloud` (`./docker-compose.yml`, Isolated Deployments on), paste the environment from
`deploy/dokploy.env.example`, add the domain `app.example.com` → service `web`, port `3000`, deploy, and create the
first operator account.

PostgreSQL needs nothing extra: the `postgres` service creates the `ooc` database on first start using
`POSTGRES_PASSWORD`, the `migrate` service applies all migrations, and data lives in the `pgdata` volume.

After the first deploy you should see these services in Dokploy: `postgres`, `redis`, `migrate` (exited 0),
`api` (healthy), `worker`, `web` (healthy), `db-backup` (healthy after its first dump).

## Run on IP:port (no domain yet)

For a first trial you can open the app at `http://<server-ip>:8585` without a domain. Traffic is **not encrypted**
(passwords and sessions travel in clear text), so use it only for testing — the app logs a warning and refuses to
combine this mode with live Cashfree or live ResellerClub.

1. Open the port on the VPS firewall: `ufw allow 8585/tcp`
   (Docker-published ports bypass ufw anyway, but keep the rule set explicit.)
2. In Dokploy → service → **Environment** use (with your IP):

   ```
   APP_ENV=production
   APP_URL=http://203.0.113.10:8585
   API_URL=http://203.0.113.10:8585/api
   COOKIE_SECURE=false
   OOC_ALLOW_INSECURE_HTTP=true
   WEB_PUBLISH=8585
   ```

   plus the usual `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `CREDENTIAL_ENCRYPTION_KEY`, `SMTP_URL`, `MAIL_FROM`.
   Do not add a Dokploy domain in this mode. Port 3000 is the Dokploy panel and 8080 is Traefik's dashboard, so the app uses 8585. Any other free port works:
   change `WEB_PUBLISH`, `APP_URL`, `API_URL` and the ufw rule together.
3. Deploy and open `http://203.0.113.10:8585`.

Moving to HTTPS later: add the domain in Dokploy (service `web`, port 3000, HTTPS on), set
`APP_URL`/`API_URL` to `https://…`, `COOKIE_SECURE=true`, remove `OOC_ALLOW_INSECURE_HTTP` and `WEB_PUBLISH`,
run `ufw delete allow 8585/tcp`, and redeploy. Accounts and data are kept.
No domain but want HTTPS? Use `203-0-113-10.sslip.io` as the domain (your IP with dashes) — it works with Let's Encrypt.

## 6. Off-site backups (do this before real customers)

1. Dokploy → **Settings → S3 Destinations → Add**: your bucket, region, access key (use a key that can write but
   ideally not delete; enable versioning/object lock on the bucket).
2. Compose service → **Volume Backups → Add**: volume `<appName>_pgbackups` (Dokploy prefixes the Compose app name),
   destination = that bucket, "turn off container" not needed (dumps are complete files), schedule
   `0 22 * * *` (22:00 UTC, after the 21:00 UTC dump), keep ≥ 35 copies.
3. Test it: on the server run `./restore.sh backup` (see [runbooks/backup-restore.md](runbooks/backup-restore.md)),
   trigger the volume backup manually in Dokploy, and check the file appears in the bucket.
4. Run the first restore drill: `./restore.sh drill`, and record it in `docs/evidence/`.

## 7. Monitoring (minimum)

- Dokploy → **Monitoring**: CPU/RAM/disk per service; set notifications (email/Telegram/Slack) for failed deploys.
- An external uptime check (e.g. UptimeRobot, Better Stack) on `https://app.example.com/` every 1–5 min.
- Weekly glance: `db-backup` healthy, disk < 70 % (`df -h`), `./restore.sh list` shows recent dumps.
- `SENTRY_DSN` is available in the environment for error tracking once you add a Sentry project.

## 8. Maintenance

| Task | How |
|---|---|
| Deploy a new version | push to `main` → Dokploy Deploy (or Auto Deploy); migrations run first automatically |
| Before risky releases | `./restore.sh backup` |
| OS security updates | automatic; reboot monthly in a quiet hour: `sudo reboot` (containers restart automatically) |
| Dokploy updates | Dokploy → Settings → Update |
| PostgreSQL minor updates | bump `postgres:16.x-alpine` tag in `docker-compose.yml` and deploy (same data volume) |
| PostgreSQL major upgrade (16 → 17) | dump → new volume → restore; plan it, never just change the major tag |
| Rotate `POSTGRES_PASSWORD` | `ALTER USER ooc PASSWORD '…'` inside postgres, then update Dokploy env and redeploy |
| Disk filling up | `docker system prune -af --volumes=false` removes old images (never `--volumes`) |

## 9. Checklist

- [ ] `https://app.example.com` loads with a valid certificate; registration email arrives
- [ ] Dokploy panel only on its HTTPS domain; `ufw status` shows 22, 80, 443 only
- [ ] `ssh root@…` with a password is refused
- [ ] Operator created and MFA enabled
- [ ] `db-backup` healthy; off-site copy visible in the bucket; first restore drill recorded
- [ ] Secrets (especially `CREDENTIAL_ENCRYPTION_KEY`) stored in a password manager
- [ ] Server IP recorded in `docs/runbooks/deployment.md` (for the ResellerClub allowlist)
- [ ] `CASHFREE_ENV` / `RESELLERCLUB_ENV` still `disabled` until those accounts are verified
