# Load test — build sandbox (indicative only, NOT the launch gate)

- Date: 2026-10-07
- Target: full `docker-compose.yml` stack on the build sandbox (2 vCPU, 7 GB RAM), stand-in base images,
  plain HTTP on localhost, client on the same machine. **Repeat on the production VPS for the launch gate.**
- Command: `node scripts/loadtest.mjs http://localhost:3000 --duration 15 --concurrency 20 --login-email loadtest@example.test`

| Scenario | Concurrency | Requests | req/s | p50 ms | p95 ms | p99 ms | Statuses |
|---|---|---|---|---|---|---|---|
| home (`/`) | 20 | 7 984 | 531.6 | 33 | 69 | 90 | 200 × 7 984 |
| pricing (`/pricing`) | 20 | 2 754 | 182.6 | 106 | 169 | 210 | 200 × 2 754 |
| catalogue API via proxy | 20 | 11 462 | 763.6 | 21 | 57 | 123 | 200 × 281, 429 × 11 181 |
| login, wrong password | 4 | 10 369 | — | 4 | 11 | 18 | 401 × 10, 429 × 10 359 |

Observations

- Page rendering is not the bottleneck at this size; `/pricing` caches the catalogue for 60 s server-side.
- The API's per-IP limits work: 300 requests/min per client IP overall, 10 login attempts/min per IP; all extra
  requests got `429`. A single load-test client therefore cannot measure API throughput — use several source IPs
  or raise the limit temporarily on a staging deployment (`OOC_DISABLE_THROTTLE` is ignored when `NODE_ENV=production`).
- Behind Traefik the API sees the client IP from `X-Forwarded-For` (Next.js passes it through unchanged). In the
  IP:port trial mode (no Traefik) every visitor shares one rate-limit bucket — acceptable for a trial only.
