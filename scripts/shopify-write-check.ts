/**
 * Live WRITE check against a Shopify DEVELOPMENT store. Exercises refunds,
 * idempotent replay, guardrail refusals and order status changes through the
 * same tool code the MCP server uses.
 *
 *   SHOPIFY_STORE=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... npm run shopify:write-check            # plan only
 *   SHOPIFY_STORE=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... npm run shopify:write-check -- --confirm
 *
 * Safety: refuses to run unless Shopify reports the store as a development
 * store (shop.plan.partnerDevelopment). Without --confirm it changes nothing.
 * Refunds are 1.00 each. Shipping/delivering/cancelling consumes test orders,
 * so a re-run needs fresh orders for those steps (it skips them otherwise).
 */
import { parseArgs } from "node:util";
import { systemClock } from "../src/clock.js";
import { ShopError } from "../src/errors.js";
import { ShopifyClient } from "../src/shopify/client.js";
import { resolveShopifySettings } from "../src/shopify/config.js";
import { ShopifyStore } from "../src/shopify/store.js";
import { getOrder, invokeShopifyTool, issueRefund, listOrders, updateOrderStatus, type ShopifyToolContext } from "../src/shopify/tools.js";

const { values } = parseArgs({ options: { confirm: { type: "boolean", default: false } } });

let settings;
try {
  settings = resolveShopifySettings();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(64);
}
const store = new ShopifyStore(new ShopifyClient(settings));
// Writes forced on for this script only; the refund cap stays as configured.
const ctx: ShopifyToolContext = { store, settings: { ...settings, writesEnabled: true }, clock: systemClock, actor: "write-check" };

type Outcome = "ok" | "FAIL" | "skip";
const results: Outcome[] = [];
function report(outcome: Outcome, label: string, detail?: string): void {
  results.push(outcome);
  console.log(`${outcome.padEnd(5)} ${label}${detail ? `\n      ${detail}` : ""}`);
}
function describe(err: unknown): string {
  return err instanceof ShopError ? `${err.code}/${err.reason}: ${err.message}` : err instanceof Error ? err.message : String(err);
}
/** Run a call that must be refused with `reason`; anything else is a failure. */
async function expectRefusal(label: string, reason: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    report("FAIL", label, `expected ${reason}, but the call succeeded`);
  } catch (err) {
    if (err instanceof ShopError && err.reason === reason) report("ok", label, `refused as expected (${reason})`);
    else report("FAIL", label, `expected ${reason}, got ${describe(err)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Safety gate --------------------------------------------------------
const shop = await store.shopInfo().catch((err: unknown) => {
  console.error(`Could not connect: ${describe(err)}`);
  process.exit(1);
});
console.log(`Store: ${shop.name} (${shop.domain}), plan ${shop.plan}, currency ${shop.currency}`);
if (!shop.isDevelopmentStore) {
  console.error("REFUSED: Shopify does not report this as a development store. This script only runs on dev stores.");
  process.exit(2);
}

// ---- 2. Pick test orders -----------------------------------------------------
const recent = (await invokeShopifyTool(listOrders, ctx, { limit: 100 })).data.orders;
const paid = recent.filter((o) => o.status === "paid" && o.total_cents - o.refunded_cents >= 500);
const refundOrder = paid[paid.length - 1]; // oldest qualifying paid order
const shipOrder = paid.find((o) => o.id !== refundOrder?.id) ?? undefined;
const pending = recent.filter((o) => o.status === "pending");
const cancelOrder = pending[0];
const markPaidOrder = pending[1];

console.log("\nPlan:");
console.log(`  refunds + guardrails on ${refundOrder ? refundOrder.name : "(no paid order with 5.00+ refundable: will skip)"}`);
console.log(`  paid -> shipped -> delivered on ${shipOrder ? shipOrder.name : "(no second paid order: will skip)"}`);
console.log(`  pending -> cancelled on ${cancelOrder ? cancelOrder.name : "(no pending order: will skip)"}`);
console.log(`  pending -> paid on ${markPaidOrder ? markPaidOrder.name : "(no second pending order: will skip)"}`);
if (!values.confirm) {
  console.log("\nDry run: nothing was changed. Re-run with -- --confirm to make these changes on the dev store.");
  process.exit(0);
}
console.log("");

// ---- 3. Refunds --------------------------------------------------------------
if (refundOrder) {
  const id = refundOrder.id;
  const key = `write-check-${Date.now()}`;
  const before = (await invokeShopifyTool(getOrder, ctx, { order_id: id })).data;
  const refundsBefore = before.refunds.length;
  try {
    const r = await invokeShopifyTool(issueRefund, ctx, { order_id: id, amount_cents: 100, reason: "Shopkeeper write check", idempotency_key: key });
    const delta = r.data.order.refunded_cents - before.financials.refunded_cents;
    report(!r.data.replayed && delta === 100 ? "ok" : "FAIL", `refund 1.00 on ${refundOrder.name}`, r.summary);
  } catch (err) {
    report("FAIL", `refund 1.00 on ${refundOrder.name}`, describe(err));
  }
  try {
    const again = await invokeShopifyTool(issueRefund, ctx, { order_id: id, amount_cents: 100, reason: "Shopkeeper write check", idempotency_key: key });
    const after = (await invokeShopifyTool(getOrder, ctx, { order_id: id })).data;
    const oneNew = after.refunds.length === refundsBefore + 1;
    report(again.data.replayed && oneNew ? "ok" : "FAIL", "same refund again is replayed, not paid twice", `${again.summary} Refunds on order: ${refundsBefore} -> ${after.refunds.length}.`);
  } catch (err) {
    report("FAIL", "same refund again is replayed, not paid twice", describe(err));
  }
  await expectRefusal("same key, different amount", "IDEMPOTENCY_KEY_REUSED", () =>
    invokeShopifyTool(issueRefund, ctx, { order_id: id, amount_cents: 200, reason: "Shopkeeper write check", idempotency_key: key }),
  );
  const now = (await invokeShopifyTool(getOrder, ctx, { order_id: id })).data;
  await expectRefusal("over-refund", "REFUND_EXCEEDS_REFUNDABLE", () =>
    invokeShopifyTool(issueRefund, ctx, { order_id: id, amount_cents: now.financials.refundable_cents + 1, reason: "Shopkeeper write check", idempotency_key: `${key}-over` }),
  );
} else report("skip", "refunds", "no paid order with at least 5.00 refundable");

// ---- 4. Status changes -------------------------------------------------------
if (shipOrder) {
  for (const target of ["shipped", "delivered"] as const) {
    try {
      const r = await invokeShopifyTool(updateOrderStatus, ctx, { order_id: shipOrder.id, status: target, note: "Shopkeeper write check" });
      report(r.data.status === target ? "ok" : "FAIL", `${shipOrder.name} -> ${target}`, r.summary);
    } catch (err) {
      report("FAIL", `${shipOrder.name} -> ${target}`, describe(err));
      break;
    }
  }
  await expectRefusal(`${shipOrder.name}: delivered -> paid is blocked`, "INVALID_STATUS_TRANSITION", () =>
    invokeShopifyTool(updateOrderStatus, ctx, { order_id: shipOrder.id, status: "paid" }),
  );
} else report("skip", "ship / deliver", "needs a second unfulfilled paid order");

if (cancelOrder) {
  try {
    const r = await invokeShopifyTool(updateOrderStatus, ctx, { order_id: cancelOrder.id, status: "cancelled", note: "Shopkeeper write check" });
    let status = r.data.status;
    for (let i = 0; i < 6 && status !== "cancelled"; i++) {
      await sleep(2000); // orderCancel runs as a background job
      status = (await invokeShopifyTool(getOrder, ctx, { order_id: cancelOrder.id })).data.order.status;
    }
    report(status === "cancelled" ? "ok" : "FAIL", `${cancelOrder.name} -> cancelled`, `${r.summary} Final status: ${status}.`);
  } catch (err) {
    report("FAIL", `${cancelOrder.name} -> cancelled`, describe(err));
  }
  await expectRefusal(`${cancelOrder.name}: refund on a cancelled unpaid order is blocked`, "ORDER_NOT_REFUNDABLE", () =>
    invokeShopifyTool(issueRefund, ctx, { order_id: cancelOrder.id, amount_cents: 100, reason: "Shopkeeper write check", idempotency_key: `write-check-cancelled-${Date.now()}` }),
  );
} else report("skip", "cancel", "no pending order");

if (markPaidOrder) {
  try {
    const r = await invokeShopifyTool(updateOrderStatus, ctx, { order_id: markPaidOrder.id, status: "paid", note: "Shopkeeper write check" });
    report(r.data.status === "paid" ? "ok" : "FAIL", `${markPaidOrder.name} -> paid`, r.summary);
  } catch (err) {
    report("FAIL", `${markPaidOrder.name} -> paid`, describe(err));
  }
} else report("skip", "mark as paid", "needs a second pending order");

const failed = results.filter((r) => r === "FAIL").length;
const skipped = results.filter((r) => r === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`);
process.exit(failed === 0 ? 0 : 1);
