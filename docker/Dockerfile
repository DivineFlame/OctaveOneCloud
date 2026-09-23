# Multi-target image for the OctaveOneCloud monorepo: targets api, worker, web, migrate.
# Pin the base image by digest at release time (docs/runbooks/deployment.md).
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
# Next.js rewrites are resolved at build time: the web image proxies /api/* to this internal URL.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
COPY . .
# Client generation does not need the native schema engine binary.
RUN pnpm --filter @ooc/db run generate \
 && pnpm --filter @ooc/shared run build \
 && pnpm --filter @ooc/db run build \
 && pnpm --filter @ooc/integrations run build \
 && pnpm --filter @ooc/api run build \
 && pnpm --filter @ooc/worker run build \
 && pnpm --filter @ooc/web run build
# Self-contained production bundles (prod dependencies only, workspace packages copied in).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @ooc/api deploy --prod --legacy /out/api \
 && pnpm --filter @ooc/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @ooc/db deploy --prod --legacy /out/db

# ── Runtime images run as the unprivileged "node" user ──
# PID 1 signal handling: run with `init: true` (docker-compose.yml) or `docker run --init`.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
USER node
CMD ["node", "dist/main.js"]

FROM runtime AS migrate
COPY --from=build --chown=node:node /out/db /app
USER node
# MIGRATE_MODE=fallback (default): applies prisma/migrations with node-postgres and records them in
#   _prisma_migrations exactly like `prisma migrate deploy` (no engine download at deploy time).
# MIGRATE_MODE=native: runs `prisma migrate deploy` (downloads Prisma's schema engine).
# SEED_DRAFT_CATALOGUE=true additionally runs the idempotent draft-catalogue seed (first deployment only).
ENV MIGRATE_MODE=fallback SEED_DRAFT_CATALOGUE=false
CMD ["sh", "-c", "set -e; if [ \"$MIGRATE_MODE\" = native ]; then node_modules/.bin/prisma migrate deploy; else node --no-warnings scripts/schema-engine-wasm.mjs deploy; fi; if [ \"$SEED_DRAFT_CATALOGUE\" = true ]; then node dist/seed.js; fi"]

FROM runtime AS web
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
