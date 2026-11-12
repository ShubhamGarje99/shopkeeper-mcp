/**
 * Read-only preflight against a real Shopify store. Sends no mutations.
 *   SHOPIFY_STORE=... SHOPIFY_ADMIN_TOKEN=... npm run shopify:check
 * Exercises every read path the server uses and prints what it found, so you
 * can compare it with the Shopify admin before enabling writes.
 */
import { systemClock } from "../src/clock.js";
import { ShopError } from "../src/errors.js";
import { ShopifyClient } from "../src/shopify/client.js";
import { resolveShopifySettings } from "../src/shopify/config.js";
import { ShopifyStore } from "../src/shopify/store.js";
import { getOrder, invokeShopifyTool, listOrders, salesReport, searchCustomers, type ShopifyToolContext } from "../src/shopify/tools.js";

let settings;
try {
  settings = resolveShopifySettings();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(64);
}
const store = new ShopifyStore(new ShopifyClient(settings));
// Writes are forced off here regardless of the environment.
const ctx: ShopifyToolContext = { store, settings: { ...settings, writesEnabled: false }, clock: systemClock, actor: "preflight" };

let failed = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    console.log(`ok    ${label}`);
    return out;
  } catch (err) {
    failed++;
    const msg = err instanceof ShopError ? `${err.code}/${err.reason}: ${err.message}` : err instanceof Error ? err.message : String(err);
    console.log(`FAIL  ${label}\n      ${msg}`);
    return undefined;
  }
}

const shop = await step("connect (store, token, API version)", () => store.shopInfo());
if (shop) console.log(`      ${shop.name} (${shop.domain}), currency ${shop.currency}, API ${settings.apiVersion}`);

const list = await step("list_orders (newest 5)", () => invokeShopifyTool(listOrders, ctx, { limit: 5 }));
for (const o of list?.data.orders ?? []) {
  console.log(`      ${o.name}  ${o.status.padEnd(9)}  ${o.currency} total ${o.total_cents} refunded ${o.refunded_cents}  ${o.customer_name ?? "(no customer)"}`);
}
if (list && list.data.orders.length === 0) console.log("      no orders found - create a few test orders, then re-run");

const first = list?.data.orders[0];
if (first) {
  const detail = await step(`get_order ${first.id}`, () => invokeShopifyTool(getOrder, ctx, { order_id: first.id }));
  if (detail) console.log(`      ${detail.summary}`);
  if (first.customer_name && first.customer_name.length >= 2) {
    const found = await step(`search_customers "${first.customer_name}"`, () => invokeShopifyTool(searchCustomers, ctx, { query: first.customer_name as string }));
    if (found) console.log(`      ${found.summary}`);
  }
}

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const report = await step(`sales_report ${monthAgo}..${today}`, () => invokeShopifyTool(salesReport, ctx, { from: monthAgo, to: today, group_by: "week" }));
if (report) console.log(`      ${report.summary}`);

console.log(failed === 0 ? "\nAll read checks passed. Compare the numbers above with the Shopify admin before enabling writes." : `\n${failed} check(s) failed. Fix these before using the server.`);
process.exit(failed === 0 ? 0 : 1);
