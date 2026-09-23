# Reconciliation and incident handling

## Payment received but order not paid

1. Operations console → orders in `needs_attention`, or `GET /v1/admin/orders?status=awaiting_payment`.
2. Customer or operator clicks **Check payment status** (queues `reconcile`), or wait for the sweeper (10 min).
3. The worker calls Cashfree `GET /orders/{id}` and `/payments` and applies evidence idempotently.
4. `payment.amount_mismatch` in the audit log ⇒ do not fulfil; contact the customer; refund if appropriate.
5. `payment.duplicate_success` ⇒ the customer paid twice; initiate a refund for the second payment.

## Webhook failures

- `GET /v1/admin/webhooks?status=failed` lists inbox rows with `lastError`.
- `unknown provider order` usually means a webhook for another environment or a deleted order; confirm and leave failed.
- Rows are retried by the queue with backoff and re-swept; nothing is lost if Redis is down.

## Supplier unknown outcome

A `SupplierOperation` in `unknown` means the request may or may not have executed (timeout, 5xx).

1. **Do not retry.** Check the ResellerClub panel/order search for the domain/order.
2. If it exists: `POST /v1/admin/supplier-operations/:id/resolve {"outcome":"succeeded","providerRef":"<order id>","note":"…"}`.
3. If it does not: resolve as `failed` with a note; the operation can then be retried deliberately.
4. Insufficient supplier balance ⇒ top up, then retry; the customer’s order stays `needs_attention` meanwhile.

## Provisioning failures

- `GET /v1/admin/provisioning` lists failed/partial/unknown jobs with steps and errors.
- `adapter_unconfigured` ⇒ configure the adapter; jobs in `partially_failed` retry only failed components.
- `unknown_outcome` ⇒ call the app’s `getStatus` / check the app, then re-queue.
- Never mark a component active without adapter evidence.

## Daily checks

- Supplier balance vs upcoming renewals (manual until the balance API is verified).
- Orders in `needs_attention` older than 1 hour.
- Failed webhooks, dead-lettered jobs (BullMQ failed set).
- Cashfree settlements vs recorded payments (gross, fees, refunds tracked separately).
