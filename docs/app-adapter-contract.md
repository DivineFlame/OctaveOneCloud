# Hosted app adapter contract — version `2026-09`

OctaveOneCloud does not rebuild business apps. Each hosted app exposes this contract so the platform can provision
tenants and push entitlements. **The app must enforce entitlements server-side.**

## Transport

`POST {APP_ADAPTER_<NAME>_URL}/ooc/2026-09/{operation}` with JSON body and headers:

| Header | Meaning |
|---|---|
| `x-ooc-timestamp` | Unix ms when signed |
| `x-ooc-signature` | `hex(HMAC-SHA256(APP_ADAPTER_<NAME>_SECRET, "<timestamp>.<raw body>"))` |
| `x-ooc-idempotency-key` | Same key ⇒ same effect and same response; store and replay |
| `x-ooc-correlation-id` | Provisioning job correlation id, for logs and callbacks |
| `x-ooc-contract-version` | `2026-09` |

Apps should reject signatures older than 5 minutes and must compare signatures in constant time.

## Operations

Every request includes `orgId`, `correlationId`, `idempotencyKey`.

| Operation | Extra fields | Success evidence (required) |
|---|---|---|
| `provisionTenant` | `planVersionId`, `entitlements[]`, `configuration?` | app tenant id, timestamp |
| `grantEntitlements` | `entitlements[]` (`{featureKey, limit}`; `null` = boolean) | count applied |
| `changePlan` | `planVersionId`, `entitlements[]` | new plan version |
| `suspendAccess` | `reason` | state `suspended` (data retained) |
| `resumeAccess` | — | state `active` |
| `getStatus` | — | `{ state }` |
| `requestDeletion` | `retentionDays` | state `deletion_requested` |

## Response

```json
{ "outcome": "succeeded" | "pending" | "failed" | "unknown", "evidence": { }, "externalRef": "...", "error": "..." }
```

- `succeeded` without `evidence` is treated as `unknown`.
- Network errors, timeouts and HTTP 5xx are treated as `unknown`: the job stops and is reconciled via `getStatus`
  before any retry.
- HTTP 4xx ⇒ `failed`.

## Registering an adapter

1. Deploy the app with the contract; keep it on a private network.
2. Set `APP_ADAPTER_<NAME>_URL` and `APP_ADAPTER_<NAME>_SECRET` for the worker (adapter key `app.<name>`).
3. Run the contract tests against it (see `packages/integrations/test/provisioning.test.ts` for expected behaviour).
4. Set the `AppAdapter` row to `sandbox`, then `active` after acceptance; only then can products activate.

The in-memory `ReferenceAppAdapter` exists for tests/local development and throws if constructed in production.

## Calling OctaveOneCloud (app service API)

Apps must enforce entitlements themselves and meter usage through OctaveOneCloud. Requests go to the public site
(`https://app.example.com/api/v1/app-api/...`), are `POST` with a JSON body, and are signed with the same secret:

| Header | Value |
|---|---|
| `x-ooc-app` | the adapter key, e.g. `app.crm` (from `APP_ADAPTER_CRM_SECRET`) |
| `x-ooc-timestamp` | unix seconds; requests more than 5 minutes off are rejected |
| `x-ooc-signature` | `hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))` |

The secret must be at least 32 characters. An app can only act for organisations it has been provisioned for
(an active provisioning step for one of its products), otherwise `403 org_not_served`.

| Endpoint | Body | Result |
|---|---|---|
| `entitlements` | `{ orgId }` | `{ entitlements: [{ featureKey, limit, mergePolicy }], subscriptions: [{ id, status, currentPeriodEnd }] }` — revoked/expired grants are excluded, so an empty list means no access |
| `usage/reserve` | `{ orgId, resource, quantity, idempotencyKey, ttlSeconds? }` | `{ reservationId, expiresAt, periodEnd }`, or `409 quota_exceeded` with `limit/used/reserved`. Reserve **before** doing the work. |
| `usage/settle` | `{ reservationId, actualQuantity, sourceEventId }` | bills `min(actual, reserved)`; repeating the same `sourceEventId` is a no-op |
| `usage/release` | `{ reservationId }` | returns unused capacity (failed run) |

Quotas are per calendar month (IST) for metered features (`Feature.metered`), limited by the merged entitlement:
plan grants plus usage packs (additive, expiring). Unsettled reservations expire after their TTL. Overage is never
billed automatically; customers see usage under **Organisation → Usage**.
