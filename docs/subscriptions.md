# Subscription lifecycle

Customers and operators record **intents**; the worker carries them out through the app adapters and changes the
subscription only after every adapter-backed component returned evidence. Nothing in this flow deletes customer
data, collects money or issues refunds.

| Action | Who | When it takes effect | What happens |
|---|---|---|---|
| Cancel at period end | org owner / billing (`billing.manage`) | end of the paid period | status `cancel_scheduled`; at period end the worker calls `suspendAccess(reason: subscription_ended)` on each app, revokes entitlements, status `cancelled`. Data is retained. |
| Keep subscription | same | immediately (before period end) | undoes the cancellation |
| Move to a cheaper plan | same | end of the paid period | stored as `scheduledChange`; at period end the worker calls `changePlan` with the new entitlements and swaps the grants. Only same product, same billing term, lower total; bundles must keep the same apps. |
| Withdraw scheduled change | same | immediately | |
| Upgrade | — | — | not self-service yet: needs a prorated quote and confirmed payment |
| Suspend / resume | operator (support or admin), reason required | next worker sweep (≤ 1 min) | `suspendAccess` / `resumeAccess`; entitlements revoked / restored (only the current plan's grants) |

API: `GET /v1/orgs/:orgId/subscriptions`, `POST …/:id/cancel`, `…/:id/keep`, `…/:id/downgrade {priceVersionId, quantity}`,
`…/:id/scheduled-change/withdraw`; operators `GET /v1/admin/subscriptions?status=|attention=true`,
`POST /v1/admin/subscriptions/:id/suspend|resume {reason}`. Every action is audited.

## Reliability rules

- Adapter idempotency keys are `sub:<id>:v<lifecycleVersion>:<op>:<product>`; a retry of the same transition reuses
  them, a later transition gets new ones.
- A transition commits with `UPDATE … WHERE lifecycleVersion = n` so two workers can never apply it twice.
- If any app does not confirm (failed / unknown / no evidence), the subscription is left unchanged,
  `lastLifecycleError` is set, and the worker retries after 5 minutes. Operators see these under
  **Admin → Subscriptions → Needs attention**.
- Period ends are evaluated by the worker sweep; renewals, dunning and grace periods are a later milestone, so an
  un-cancelled subscription currently stays `active` after its period end until renewal is built.
