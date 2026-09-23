## What & why

<!-- Short description of the change and the reason for it. -->

## Checklist

- [ ] `pnpm -r run typecheck` and `pnpm -r run test` pass locally
- [ ] Schema changes include a migration (`pnpm db:check` passes)
- [ ] No secrets, `.env` files, customer data or real provider responses committed
- [ ] Money stays in integer minor units; provider amounts converted only at the boundary
- [ ] New org-scoped queries filter by `orgId` and routes use `OrgGuard`
- [ ] Supplier/payment side effects are idempotent (unique key or conditional update)
- [ ] `docs/PROGRESS.md` / `docs/provider-capabilities.md` updated if scope or verification changed
