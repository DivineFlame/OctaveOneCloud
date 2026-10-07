# GST invoices and credit notes

Status: implemented and tested against PostgreSQL; **layout, wording, SAC codes and numbering must be confirmed by the
accountant before launch** (launch gate).

## How invoices are issued

1. A payment is confirmed server-side (webhook or status API) → order gets `paidAt`.
2. The worker issues the tax invoice immediately; the one-minute sweeper retries anything missed.
   Operators can also issue one from **Admin → Invoices** (`POST /v1/admin/invoices/issue/:orderId`).
3. The invoice is built from the **frozen quote** (prices and tax exactly as accepted — never recomputed) plus a
   snapshot of seller and buyer details at issue time (legal name, address, GSTIN, state code, place of supply).

One invoice per order (`UNIQUE(orderId)`); repeated or concurrent issuing returns the existing invoice.
If the order total does not equal its quote total, issuing stops with `order_quote_total_mismatch` for review.

## Numbering

`<INVOICE_PREFIX>/<FY>/<00001>`, e.g. `OOC/26-27/00001` (≤ 16 characters as GST requires). The financial year
switches at 00:00 IST on 1 April. Numbers are allocated inside the issuing transaction from `DocumentSequence`,
so there are no gaps or duplicates even under concurrency. Credit notes use their own series (`OCN/26-27/00001`).
Do not change prefixes in the middle of a financial year.

## Immutability

Database triggers reject any change to the number, amounts, tax breakdown or billing snapshot of an issued
invoice or credit note, and reject deleting them. Corrections are made only with credit notes.

## Credit notes

`POST /v1/admin/invoices/:id/credit-notes` `{ taxableMinor, reason, refundId? }` — finance (or admin) operators,
MFA required, audited. GST is credited in the same proportion as the invoice's tax breakdown. The sum of credit
notes can never exceed the invoice's taxable value (enforced under a row lock). A credit note does not move
money; refunds are separate (refund initiation is a later milestone).

## Configuration

| Setting | Purpose |
|---|---|
| `SELLER_LEGAL_NAME`, `SELLER_ADDRESS`, `SELLER_STATE_CODE` | Required once `CASHFREE_ENV` is not `disabled`. Without them paid orders wait (admin page shows a warning). |
| `SELLER_GSTIN` | Printed when set. |
| `INVOICE_PREFIX`, `CREDIT_NOTE_PREFIX` | 1–4 capitals/digits; defaults `OOC` / `OCN`. |
| `TaxRule.sacCode` | SAC printed per line; set per tax category after accountant review (seeded rules leave it empty). |

## Customer view

**Dashboard → organisation → Invoices** (members with billing access). Each invoice has a print layout;
"Print / save as PDF" uses the browser's PDF printer. Server-generated PDF files and e-invoicing (IRN/QR, required
above the turnover threshold) are not implemented — confirm applicability with the accountant.
