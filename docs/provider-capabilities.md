# Provider capabilities

Status as of **2026-09-23**. This file is the source of truth for what may be sold or automated.
The code mirror is `packages/integrations/src/resellerclub/capabilities.ts`; keep them in sync.

A capability is **verified** only when all of the following are recorded:

1. the exact official documentation link (and API version, if applicable);
2. account eligibility confirmed in the authenticated supplier/merchant panel;
3. a sandbox (demo) test with date, request and redacted response saved under `docs/evidence/`.

Until then the product stays `draft` and cannot be activated (`GET /v1/admin/catalogue/products/:id/activation-blockers`).

> **Stage 0 is not complete.** The live OctaveOneCloud catalogue and the authenticated ResellerClub account
> could not be inspected. No supplier capability is verified. No price has been imported.

## ResellerClub (HTTP API)

General references (reviewed 2026-09-23; only the navigation was retrievable, not the article bodies):

- HTTP API overview: <https://manage.resellerclub.com/kb/answer/744>
- Access & authentication: <https://manage.resellerclub.com/kb/answer/753>

Implemented integration mechanics (`packages/integrations/src/resellerclub/client.ts`):

| Mechanism | Implementation | Verified? |
|---|---|---|
| Authentication | `auth-userid` and `api-key` request parameters from `RESELLERCLUB_AUTH_USERID` / `RESELLERCLUB_API_KEY` | Parameter names from the product plan; confirm in article 753 |
| Transport | HTTPS only; base URL from `RESELLERCLUB_BASE_URL` | — |
| Demo vs live | `RESELLERCLUB_ENV=demo|live`; live mutations also need `RESELLERCLUB_ALLOW_LIVE_MUTATIONS=true` | **Live credentials act live even on the test host** — use demo credentials for tests |
| IP allowlisting | Outbound IPs of the API/worker host must be allowlisted in the ResellerClub panel | Record the production egress IPs in `docs/runbooks/deployment.md` |
| Response handling | HTTP 200 bodies with `status: ERROR/failed` are treated as failures; 5xx/timeout ⇒ `unknown` | Error body shape to be confirmed in sandbox |
| Mutation journal | `SupplierOperation` row per operation key; `unknown` blocks retry until an operator reconciles | Implemented and unit-tested with mocked HTTP |
| Redaction | credentials removed from logs, journals and errors | Unit-tested |

Candidate base URLs (confirm before use): demo `https://test.httpapi.com/api`, live `https://httpapi.com/api`.

### Operations

| Adapter key | Product | Operation | Documentation link | API version | Account eligible | Sandbox verified | Status | Unsupported / manual fallback |
|---|---|---|---|---|---|---|---|---|
| resellerclub.domain | Domains | availability search | _to record_ (client calls `/domains/available.json` — unconfirmed) | — | unknown | no | **unverified** | Disable domain search |
| resellerclub.domain | Domains | customer / contact create & map | _to record_ | — | unknown | no | unverified | Manual service task |
| resellerclub.pricing | All | reseller **cost** price list — `GET /products/reseller-cost-price.json` (optional `reseller-id`) | <https://www.resellerclub.com/help/article/Get-Reseller-Cost-Pricing-Details-Using-the-API> (reviewed 2026-10-08) | — | unknown | no | docs confirmed; demo run pending | Operator enters supplier cost manually |
| resellerclub.pricing | All | **customer** (selling) price list — `GET /products/customer-price.json` (optional `customer-id`) | <https://www.resellerclub.com/help/article/How-to-Fetch-Customer-Pricing-Using-the-Products-Pricing-API> (reviewed 2026-10-08) | — | unknown | no | docs confirmed; demo run pending | Selling prices kept in the catalogue only |
| resellerclub.domain | Domains | register (incl. premium handling) | _to record_ | — | unknown | no | unverified | Manual service task |
| resellerclub.domain | Domains | transfer | _to record_ | — | unknown | no | unverified | Manual service task |
| resellerclub.domain | Domains | renew | _to record_ | — | unknown | no | unverified | Manual service task |
| resellerclub.domain | Domains | order details / status | _to record_ | — | unknown | no | unverified | Supplier panel check by operator |
| resellerclub.domain | Domains | DNS management | _to record_ | — | unknown | no | unverified | Support ticket |
| resellerclub.hosting | Shared / WordPress hosting | order, status, renew | _to record_ | — | unknown | no | unverified | Not sold. **Reseller-hosting packages are excluded from sale.** |
| resellerclub.vps | VPS | order, status, renew | _to record_ | — | unknown | no | unverified | Not sold |
| resellerclub.email | Business email | order, status, renew | _to record_ | — | unknown | no | unverified | Not sold |
| resellerclub.ssl | SSL certificates | order, status, renew | _to record_ | — | unknown | no | unverified | Not sold |
| — | Supplier balance | balance query for low-funds alerts | _to record_ | — | unknown | no | unverified | Operator checks panel daily |

## Cashfree

| Capability | Documentation (reviewed 2026-09-23) | Implementation | Merchant enabled | Sandbox verified |
|---|---|---|---|---|
| PG order creation (server-side) | <https://www.cashfree.com/devstudio/preview/pg/web/checkout> | `POST {base}/orders` with `x-client-id`, `x-client-secret`, `x-api-version`; amount sent as decimal from integer paise; response identity/amount/currency validated | unknown | no (mocked HTTP only) |
| Hosted checkout (browser) | same | JS SDK v3 `Cashfree({mode}).checkout({paymentSessionId})` on the order page | unknown | no |
| Get order / payments (reconciliation) | PG API reference (link to record) | `GET {base}/orders/{order_id}` and `/orders/{order_id}/payments` | unknown | no |
| Webhook signature | <https://www.cashfree.com/docs/payments/subscription/webhook-signature> | `base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody))`, constant-time compare, raw bytes | — | unit-tested only |
| Webhook idempotency | <https://www.cashfree.com/docs/payments/online/webhooks/webhook-indempotency> | inbox unique on `x-idempotency-header` (2025-01-01+) or SHA-256 of body; attempts unique on `cf_payment_id`; only `SUCCESS` fulfils | — | unit-tested only |
| Webhook API version | Webhooks overview (2025-01-01 recommended) | `CASHFREE_API_VERSION=2025-01-01` default | — | confirm in dashboard |
| Refund webhooks | Webhooks overview | `REFUND_*` events move `Refund` rows only forward | unknown | no |
| Create Refund | <https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create-refund> (reviewed 2026-10-07, page shows x-api-version 2026-01-01) | `POST /orders/{order_id}/refunds` with `refund_amount`, `refund_id` (ours, alphanumeric 3–40), `refund_note`, header `x-idempotency-key` = our refund row id; statuses SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED; refunds only within six months | unknown | no — confirm with the configured `CASHFREE_API_VERSION` in sandbox |
| Get Refund | <https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get-refund> | `GET /orders/{order_id}/refunds/{refund_id}`; used by the reconcile sweeper; a 404 for a timed-out request leads to re-sending the identical request (same idempotency key) | unknown | no |
| Dispute webhooks | Webhooks overview | `DISPUTE_*` events recorded in `Dispute` | unknown | no |
| Subscriptions (mandates) | <https://www.cashfree.com/docs/payments/subscription/introduction>, <https://www.cashfree.com/docs/payments/subscription/create> | Separate endpoint `/v1/webhooks/cashfree/subscriptions` and secret; events stored, **processing deferred to Stage 4** | unknown | no |

Open questions to settle in the Cashfree dashboard / sandbox:

- Which secret signs webhooks for this merchant (client secret vs dedicated webhook secret) and whether PG and Subscription products use different secrets.
- Unit of `x-webhook-timestamp` (ms vs s) before enabling a replay-window check (currently disabled).
- Exact PG API version to pin for orders, and whether `x-idempotency-key` is supported on order creation.
- Subscription product availability, supported mandate methods (UPI Autopay, eNACH, cards) and limits.

## Hosted app adapters

All app adapters are `unconfigured`; see `docs/app-adapter-contract.md`. No hosted app is sellable until its adapter
passes the contract tests against a real deployment and the app enforces entitlements itself.
