# Shopify backend

Run Shopkeeper against a **live Shopify store** instead of the bundled demo database.

```bash
npm install && npm run build
SHOPIFY_STORE=your-shop.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_... \
node dist/index.js --backend shopify
```

**Read-only by default.** Write tools (`update_order_status`, `issue_refund`) refuse with `WRITES_DISABLED` until you also set `SHOPKEEPER_SHOPIFY_WRITES=1`. Try everything read-only first.

## Claude Code / Claude Desktop

```bash
claude mcp add shopkeeper-shopify \
  -e SHOPIFY_STORE=your-shop.myshopify.com -e SHOPIFY_ADMIN_TOKEN=shpat_... \
  -- node /ABSOLUTE/PATH/TO/shopkeeper-mcp/dist/index.js --backend shopify
```

The token lives only in the environment of the server process. It is never printed, logged, or put in an error message (there is a test for this).

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `SHOPIFY_STORE` | required | `<name>.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | required | Admin API access token from a custom app |
| `SHOPIFY_API_VERSION` | `2026-04` | Admin GraphQL API version |
| `SHOPKEEPER_SHOPIFY_WRITES` | off | `1` enables the two write tools |
| `SHOPKEEPER_MAX_REFUND_MINOR` | `100000` | Per-refund cap in minor units (100000 = 1,000.00 USD) |
| `SHOPKEEPER_AUDIT_FILE` | none | Append every write to this JSONL file (also echoed to stderr) |

## Access scopes for the custom app

`read_orders`, `write_orders`, `read_customers`, `read_fulfillments`, `write_fulfillments`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`. Add `read_all_orders` if you need orders older than 60 days (without it Shopify only returns the last 60 days). Reading customer names/emails may also require protected-customer-data access depending on your app type.

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

**Verified by automated tests (29).** Money parsing, status derivation, every guardrail above, idempotent replay, the order state machine, MCP schema and structured-output validation, error mapping, and the token never leaking. These run against `tests/shopify-fake.ts`, an in-memory imitation of the Admin API, which refuses any document that is not in the schema-validated set.

**Not yet verified on a live store.** Schema validity proves Shopify will parse the calls, not that they behave as intended. Still to confirm on a development store: required access scopes, how quickly `orderCancel` shows up, refunds against the Bogus gateway, and `fulfillmentEventCreate` marking an order delivered. A live failure comes back as `UPSTREAM_ERROR` with Shopify's message.

## Live test checklist (development store, ~20 minutes)

1. Create a free Shopify development store; enable the Bogus Gateway (Settings > Payments > test mode).
2. Create a custom app with the scopes above; copy the Admin API token.
3. Create 3 test orders: two paid, one pending (manual payment).
4. Run the read-only preflight and compare its output with the admin:
   `SHOPIFY_STORE=... SHOPIFY_ADMIN_TOKEN=... npm run shopify:check`
   It sends no mutations and forces writes off.
5. Connect the server to Claude with `SHOPKEEPER_SHOPIFY_WRITES=1`. On a paid order: refund a small amount; ask for the same refund again (expect `replayed: true` and one refund in the admin); try an over-refund (expect a refusal).
6. Walk the other paid order paid -> shipped -> delivered; cancel the pending one (expect confirmed or `pending_confirmation`).
7. Note any `UPSTREAM_ERROR` and fix the operation it points at in `src/shopify/operations.ts`.

The Shopify backend is stdio-only. The optional HTTP transport has no authentication and refuses to start with `--backend shopify`.
