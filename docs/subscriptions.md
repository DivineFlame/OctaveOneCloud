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
- Scheduled downgrades fall due at `scheduledChangeDueAt` (the period boundary they were scheduled for), so they still
  apply on time when the renewal was paid early.

## Renewals (customer-paid)

Cashfree Subscriptions mandates are not enabled yet, so renewals are orders the customer pays through the normal
hosted checkout. Nothing is debited automatically.

| When (relative to period end T) | What the worker does |
|---|---|
| T − `RENEWAL_NOTICE_DAYS` (7) | Creates one `RenewalRun` (unique per subscription + period) and a renewal order and quote at the subscription's price version — or at the scheduled downgrade's price. Emails the org's billing email, owners and billing members. |
| T − 1 day | Reminder "due tomorrow" |
| T, unpaid | Status `past_due`, `graceEndsAt = T + RENEWAL_GRACE_DAYS`; access continues; "overdue" reminder |
| grace end − 2 days | "Access will be suspended" reminder |
| grace end, unpaid | Suspension requested with reason `non_payment`; the lifecycle worker switches access off (data kept) |
| T + `RENEWAL_LAPSE_DAYS` (30), unpaid | Renewal order expires; the subscription ends through the normal cancellation path |

Paying (dashboard → Subscriptions → **Pay renewal**) extends the subscription **from T** (continuous service),
issues the tax invoice, and — if access was suspended for non-payment — resumes it. A suspension for any other
reason (operator decision) is not lifted by paying. Each reminder stage is sent at most once; after downtime only
the latest applicable reminder goes out.

Changing plan or cancelling while a renewal order is unpaid cancels that order (a new one is created at the new
terms; a cancelled subscription gets none). A payment that arrives for a cancelled/expired renewal order, or after
the subscription ended, is never silently kept or applied: the order is set to `needs_attention` for refund or a
manual extension.

Existing customers keep their plan's price version on renewal ("grandfathered") until they change plan.
Operator-suspended subscriptions get no renewal order while suspended.

API: `POST /v1/orgs/:orgId/orders/:orderId/pay {phone}` opens (or re-uses) a Cashfree checkout session for any
order awaiting payment; the subscription list includes `renewal { dueAt, graceEndsAt, orderId, totalMinor, problem }`.
