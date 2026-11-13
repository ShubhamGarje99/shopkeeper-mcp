# Shopify backend

Run Shopkeeper against a **live Shopify store** instead of the bundled demo database.

```bash
npm install && npm run build
SHOPIFY_STORE=your-shop.myshopify.com \
SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... \
node dist/index.js --backend shopify
```

Two ways to authenticate:

- **Dev Dashboard app (current Shopify default):** set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (app > Settings > Credentials). The server exchanges them for a 24-hour Admin API token (client credentials grant), caches it, and refreshes it automatically. The app must be installed on the store, and the app and store must be in the same Shopify organization.
- **Legacy custom app:** set `SHOPIFY_ADMIN_TOKEN` (`shpat_...`). Used in preference when set.

**Read-only by default.** Write tools (`update_order_status`, `issue_refund`) refuse with `WRITES_DISABLED` until you also set `SHOPKEEPER_SHOPIFY_WRITES=1`. Try everything read-only first.

## Claude Code / Claude Desktop

```bash
claude mcp add shopkeeper-shopify \
  -e SHOPIFY_STORE=your-shop.myshopify.com -e SHOPIFY_CLIENT_ID=... -e SHOPIFY_CLIENT_SECRET=... \
  -- node /ABSOLUTE/PATH/TO/shopkeeper-mcp/dist/index.js --backend shopify
```

Credentials live only in the environment of the server process. They are never printed, logged, or put in an error message (there are tests for this).

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `SHOPIFY_STORE` | required | `<name>.myshopify.com` |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | one auth method required | Dev Dashboard app credentials; exchanged for auto-refreshing 24-hour tokens |
| `SHOPIFY_ADMIN_TOKEN` | one auth method required | Static Admin API token from a legacy custom app |
| `SHOPIFY_API_VERSION` | `2026-04` | Admin GraphQL API version |
| `SHOPKEEPER_SHOPIFY_WRITES` | off | `1` enables the two write tools |
| `SHOPKEEPER_MAX_REFUND_MINOR` | `100000` | Per-refund cap in minor units (100000 = 1,000.00 USD) |
| `SHOPKEEPER_AUDIT_FILE` | none | Append every write to this JSONL file (also echoed to stderr) |

## Access scopes for the app

`read_orders`, `write_orders`, `read_customers`, `read_fulfillments`, `write_fulfillments`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`. Add `read_all_orders` if you need orders older than 60 days (without it Shopify only returns the last 60 days). **Protected customer data (required, or every order read fails with "not approved to access the Order object").** In the Partner Dashboard, open the app > API access requests > Protected customer data access. In step 1, select **Protected customer data** and the **Name**, **Email** and **Address** fields, each with a reason (e.g. customer service, store management). On development stores this is immediate; step 2 (data protection details) and review are only for App Store apps.

## Tools in Shopify mode

| Tool | Notes |
|---|---|
| `search_customers` | Shopify customer search + local fuzzy ranking; flags ambiguity |
| `get_order` | `order_id` is the order number (1042 for `#1042`) |
| `list_orders` | Filters status / customer / date / total; scans at most the newest 1000 matches (`scan_truncated`) |
| `sales_report` | Group by day / week / month / customer; excludes pending and cancelled; refuses mixed currencies |
| `update_order_status` | pending->paid (manual payment), pending->cancelled, paid->shipped (creates fulfilment, no email), shipped->delivered (delivered event) |
| `issue_refund` | Amount-only refund against the original payment; no restock, no email |

Not available in Shopify mode: `create_invoice`, `low_stock_alerts` (Shopify has no invoice object or reorder thresholds), product-level sales grouping, late-delivery fields (Shopify has no promised delivery date).

## Guardrails (same ideas as the demo store, enforced before anything is sent to Shopify)

- Writes off unless explicitly enabled.
- Refund must be > 0, within the refundable remainder (never more than the payments actually received), and under the per-refund cap.
- Unpaid, cancelled and fully refunded orders are refused.
- Idempotency: a refund's `idempotency_key` is stored in the refund note on the Shopify order. The same key + amount replays the original refund; the same key with a different amount is a `CONFLICT`. The mutation also carries a deterministic `@idempotent` key, which Shopify requires from API 2026-04. Keys are checked per order.
- Status moves follow the state machine; `refunded` is only reached through refunds; a paid order is unwound with a refund, never a cancel.
- After a status change the order is re-read; if Shopify has not caught up (e.g. cancellation runs as a background job) the result says `pending_confirmation`.

## What is verified and what is not

**Verified against Shopify's published schema.** `npm run shopify:validate` downloads the Admin GraphQL schema for the configured API version from Shopify's public docs endpoint and validates every query, mutation, input field and enum value this backend uses. All pass on `2026-04`. This check caught and fixed two real errors (a removed `orderCancel` argument and a misplaced `@idempotent` directive), so run it again before changing `SHOPIFY_API_VERSION`.

**Verified by automated tests (33).** Money parsing, status derivation, every guardrail above, idempotent replay, the order state machine, MCP schema and structured-output validation, error mapping, and credentials never leaking, client-credentials token exchange and refresh. These run against `tests/shopify-fake.ts`, an in-memory imitation of the Admin API, which refuses any document that is not in the schema-validated set.

**Verified on a live development store (13 Nov 2026), read path.** `npm run shopify:check` passed end to end against a real dev store on API 2026-04: client-credentials token exchange, `list_orders`, `get_order`, `search_customers` and `sales_report`, with statuses and totals matching the Shopify admin. The live run found two problems the schema check could not (protected customer data access, and a `product` field needing an extra scope); both are fixed and the validator now rejects fields that need undocumented scopes.

**Verified on a live development store (13 Nov 2026), write path.** `npm run shopify:write-check -- --confirm` passed 9 of 9 checks: a 1.00 refund; the same refund replayed without paying twice (one refund in Shopify); key reuse with a different amount refused; over-refund refused; paid -> shipped -> delivered; delivered -> paid blocked; a pending order cancelled (Shopify's background job confirmed within seconds, reported as `pending_confirmation` first, exactly as designed); a refund on the cancelled order refused.

**Not yet exercised live:** pending -> paid (`orderMarkAsPaid`), which needs a second pending order; it is schema-validated and unit-tested. A live failure would come back as `UPSTREAM_ERROR` with Shopify's message.

## Live test checklist (development store, ~20 minutes)

1. In the Dev Dashboard (dev.shopify.com), create a dev store from **Stores** (tick "Generate test data").
2. Create an app under **Apps** with the scopes above, release a version, and install it on the store (Apps list > ⋯ > Install app).
3. In the Partner Dashboard, set up protected customer data access (see above).
4. Create 3 test orders in the store admin: two marked as paid, one with payment due later.
5. Run the read-only preflight and compare its output with the admin:
   `SHOPIFY_STORE=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... npm run shopify:check`
   It sends no mutations and forces writes off.
6. Run the scripted write check: `npm run shopify:write-check` prints its plan without changing anything; add `-- --confirm` to run it. It refuses any store Shopify does not report as a development store. Or test by hand: connect the server to Claude with `SHOPKEEPER_SHOPIFY_WRITES=1`. On a paid order: refund a small amount; ask for the same refund again (expect `replayed: true` and one refund in the admin); try an over-refund (expect a refusal).
7. Walk the other paid order paid -> shipped -> delivered; cancel the pending one (expect confirmed or `pending_confirmation`).
8. Note any `UPSTREAM_ERROR` and fix the operation it points at in `src/shopify/operations.ts`.

The Shopify backend is stdio-only. The optional HTTP transport has no authentication and refuses to start with `--backend shopify`.
