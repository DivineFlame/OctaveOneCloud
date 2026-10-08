# ResellerClub price lists

OctaveOneCloud reads two price lists from your ResellerClub account (read-only; nothing is bought or changed):

| List | ResellerClub HTTP API call | What it is |
|---|---|---|
| **Your cost** | `GET /products/reseller-cost-price.json` | What ResellerClub charges your reseller account |
| **Your selling prices** | `GET /products/customer-price.json` | The generic customer prices you set in the ResellerClub panel |

Sources: [Get Reseller Cost Pricing Details Using the API](https://www.resellerclub.com/help/article/Get-Reseller-Cost-Pricing-Details-Using-the-API),
[How to Fetch Customer Pricing Using the Products Pricing API](https://www.resellerclub.com/help/article/How-to-Fetch-Customer-Pricing-Using-the-Products-Pricing-API).
Both use your normal `auth-userid` / `api-key` and the server IP must be allowlisted.

## Setup

1. Set `RESELLERCLUB_ENV`, `RESELLERCLUB_BASE_URL`, `RESELLERCLUB_AUTH_USERID`, `RESELLERCLUB_API_KEY` (demo first).
   Live mutations stay blocked unless `RESELLERCLUB_ALLOW_LIVE_MUTATIONS=true`; fetching prices is read-only and does
   not need it.
2. `RESELLERCLUB_CURRENCY` — the currency your ResellerClub account is billed in (the API does not say; check the
   panel). Default `INR`. Only INR costs can be attached to the INR catalogue.
3. `RESELLERCLUB_PRICE_SYNC_HOURS` — automatic refresh interval, default `24`; `0` = only when you click.
4. Deploy, then **Admin → ResellerClub prices → Fetch prices now**. The worker fetches both lists in the background
   (they are large; ResellerClub recommends caching them, which is what the snapshots are).

## What you see

- Every price as a row: product key (e.g. `dotin`), category, plan / account range / certificate type, action
  (`addnewdomain`, `renewdomain`, `add`, `renew`…), term (years for domains and certificates, months for hosting,
  servers and email), your cost, your selling price where the same item exists in both lists, and the margin.
- Each row has a **reference** such as `dotin/renewdomain/1` — its path in ResellerClub's response.
- Snapshots: an identical re-fetch only updates "checked"; a changed list is stored as a new snapshot with the number
  of changed prices. The last 10 per list are kept. Demo and live data are kept apart.

## Using costs in the catalogue

When adding a catalogue price (`POST /api/v1/admin/catalogue/plan-versions/:id/prices`), pass
`"supplierCostRef": "dotin/renewdomain/1"`: the current cost from the latest snapshot **of the configured environment**
is stored with the price (`costSource = resellerclub:cost:<ref>`). Demo prices can never become the cost basis of a
live catalogue.

Selling prices are **never changed automatically** — price versions are immutable and accepted quotes keep their
price. When a new cost snapshot differs from the cost recorded on a price that is on sale, it appears under
**Cost changes behind prices on sale** with the new margin, is logged by the worker, and shows as a warning in
**Launch readiness**. You then add a new price version if you want to change the selling price.

## Not covered (yet)

- Promotional prices, premium-domain prices (priced per domain at search time) and per-customer price overrides.
- Account currency detection; supplier balance alerts.
