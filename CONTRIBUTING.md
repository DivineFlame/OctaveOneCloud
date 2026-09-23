# Contributing

1. Node.js 22 (`.nvmrc`) and pnpm via Corepack: `corepack enable`.
2. `pnpm install`, then follow **Local development** in the README.
3. Branch from `main`; keep PRs focused; fill in the PR checklist.
4. Before pushing: `pnpm -r run typecheck && pnpm -r run test && pnpm db:check`.

Conventions

- TypeScript strict mode everywhere; validate request bodies with Zod (`ZodPipe`).
- Money: integer minor units (`BigInt` columns); never floats.
- Tenant data: always filter by `orgId`; org routes must use `OrgGuard` with the right permission.
- External side effects (payments, supplier orders, app provisioning) must be idempotent and journaled.
- Schema changes: edit `packages/db/prisma/schema.prisma`, create a migration
  (`pnpm db:migrate:dev -- --name <change>` where Prisma's engine can be downloaded), commit both, run `pnpm db:check`.
  Hand-written SQL migrations start with `-- ooc:custom-sql`.
- Never mark a provider capability as verified without evidence in `docs/evidence/`.
