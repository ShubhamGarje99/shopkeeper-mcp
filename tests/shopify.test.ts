import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock.js";
import type { ObjectSchema } from "../src/tools/types.js";
import { ShopError } from "../src/errors.js";
import { ShopifyClient } from "../src/shopify/client.js";
import { resolveShopifySettings } from "../src/shopify/config.js";
import { decimalToMinor, minorToDecimal } from "../src/shopify/money.js";
import { createShopifyServer } from "../src/shopify/server.js";
import { ShopifyStore, deriveStatus, orderNumberFromName, shopifyIdempotencyKey } from "../src/shopify/store.js";
import { getOrder, invokeShopifyTool, issueRefund, listOrders, salesReport, searchCustomers, updateOrderStatus, type ShopifyToolContext, type ShopifyToolSpec } from "../src/shopify/tools.js";
import { fakeShopify, makeOrder } from "./shopify-fake.js";

const SETTINGS = { shop: "demo.myshopify.com", adminToken: "shpat_SECRET", apiVersion: "2026-04" };

function setup(orders = defaultOrders(), over: Partial<ShopifyToolContext["settings"]> = {}) {
  const fake = fakeShopify(orders);
  const store = new ShopifyStore(new ShopifyClient(SETTINGS, fake.fetch, async () => {}));
  const ctx: ShopifyToolContext = {
    store,
    settings: { writesEnabled: true, maxRefundMinor: 100_000, auditFile: undefined, ...over },
    clock: fixedClock("2026-09-30T18:00:00Z"),
    actor: "test",
  };
  return { fake, ctx };
}

function defaultOrders() {
  return [
    makeOrder({ number: 1042, createdAt: "2026-09-10T10:00:00Z" }),
    makeOrder({ number: 1043, createdAt: "2026-09-12T10:00:00Z", displayFinancialStatus: "PENDING", transactions: [], netPaymentSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } }, totalPriceSet: { shopMoney: { amount: "58.95", currencyCode: "USD" } }, subtotalPriceSet: { shopMoney: { amount: "58.95", currencyCode: "USD" } }, totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } } }),
    makeOrder({ number: 1044, createdAt: "2026-08-02T10:00:00Z", customer: { id: "gid://shopify/Customer/35", displayName: "Morgan Ellis", defaultEmailAddress: { emailAddress: "morgan.e@example.com" }, defaultAddress: { city: "Denver", province: "Colorado" } } }),
    makeOrder({ number: 1045, createdAt: "2026-09-20T10:00:00Z", customer: { id: "gid://shopify/Customer/36", displayName: "Morgan Ellis", defaultEmailAddress: { emailAddress: "morgan.ellis@example.org" }, defaultAddress: { city: "Boston", province: "Massachusetts" } } }),
  ];
}

async function code(p: Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ShopError) return { code: e.code, reason: e.reason };
    throw e;
  }
  throw new Error("expected a ShopError");
}

const run = <I extends ObjectSchema, O extends ObjectSchema>(spec: ShopifyToolSpec<I, O>, ctx: ShopifyToolContext, args: unknown) => invokeShopifyTool(spec, ctx, args);

describe("shopify money + ids", () => {
  it("round-trips decimals without floats", () => {
    expect(decimalToMinor("105.00", "USD")).toBe(10500);
    expect(decimalToMinor("0.1", "USD")).toBe(10);
    expect(decimalToMinor("1500", "JPY")).toBe(1500);
    expect(decimalToMinor("1.234", "KWD")).toBe(1234);
    expect(() => decimalToMinor("1.005", "USD")).toThrow();
    expect(minorToDecimal(10500, "USD")).toBe("105.00");
    expect(minorToDecimal(5, "USD")).toBe("0.05");
    expect(minorToDecimal(1500, "JPY")).toBe("1500");
  });
  it("reads order numbers from names", () => {
    expect(orderNumberFromName("#1042")).toBe(1042);
    expect(orderNumberFromName("EU-1042-A")).toBe(1042);
    expect(() => orderNumberFromName("abc")).toThrow();
  });
  it("derives a stable UUID-shaped idempotency key", () => {
    const k = shopifyIdempotencyKey("refund-1042-late");
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(shopifyIdempotencyKey("refund-1042-late")).toBe(k);
    expect(shopifyIdempotencyKey("refund-1042-other")).not.toBe(k);
  });
});

describe("deriveStatus", () => {
  const f = (over: object) => deriveStatus({ ...makeOrder({ number: 1 }), ...over } as never);
  it("maps financial and fulfilment axes", () => {
    expect(f({ displayFinancialStatus: "PENDING" })).toBe("pending");
    expect(f({ displayFinancialStatus: "AUTHORIZED" })).toBe("pending");
    expect(f({ displayFinancialStatus: "PENDING", cancelledAt: "2026-09-01T00:00:00Z" })).toBe("cancelled");
    expect(f({ displayFinancialStatus: "VOIDED" })).toBe("cancelled");
    expect(f({ displayFinancialStatus: "PAID" })).toBe("paid");
    expect(f({ displayFinancialStatus: "PARTIALLY_REFUNDED" })).toBe("paid");
    expect(f({ displayFinancialStatus: "REFUNDED" })).toBe("refunded");
    expect(f({ fulfillments: [{ id: "f", status: "SUCCESS", displayStatus: "FULFILLED", createdAt: "x", deliveredAt: null, trackingInfo: [] }] })).toBe("shipped");
    expect(f({ fulfillments: [{ id: "f", status: "SUCCESS", displayStatus: "DELIVERED", createdAt: "x", deliveredAt: "y", trackingInfo: [] }] })).toBe("delivered");
    expect(f({ fulfillments: [{ id: "f", status: "CANCELLED", displayStatus: null, createdAt: "x", deliveredAt: null, trackingInfo: [] }] })).toBe("paid");
  });
});

describe("client", () => {
  it("retries a 429 and then succeeds", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ data: { ok: 1 } }) });
    const c = new ShopifyClient(SETTINGS, fetch, async () => {});
    await expect(c.graphql("query { x }")).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never leaks the token in errors", async () => {
    const c = new ShopifyClient(SETTINGS, async () => ({ ok: false, status: 401, text: async () => "bad" }), async () => {});
    const err = await c.graphql("query { x }").catch((e: unknown) => e as ShopError);
    expect(err).toBeInstanceOf(ShopError);
    expect(JSON.stringify((err as ShopError).toJSON())).not.toContain("shpat_SECRET");
    expect((err as ShopError).reason).toBe("SHOPIFY_AUTH_FAILED");
  });
  it("sends the token as a header, to the versioned admin url", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) });
    await new ShopifyClient(SETTINGS, fetch, async () => {}).graphql("query { x }");
    expect(fetch.mock.calls[0]![0]).toBe("https://demo.myshopify.com/admin/api/2026-04/graphql.json");
    expect(fetch.mock.calls[0]![1].headers["X-Shopify-Access-Token"]).toBe("shpat_SECRET");
  });
});

describe("settings", () => {
  it("requires store + token, defaults to read-only", () => {
    expect(() => resolveShopifySettings({})).toThrow(/SHOPIFY_STORE/);
    expect(() => resolveShopifySettings({ SHOPIFY_STORE: "demo.myshopify.com" })).toThrow(/SHOPIFY_ADMIN_TOKEN/);
    const s = resolveShopifySettings({ SHOPIFY_STORE: "https://demo.myshopify.com/", SHOPIFY_ADMIN_TOKEN: "t" });
    expect(s.shop).toBe("demo.myshopify.com");
    expect(s.writesEnabled).toBe(false);
    expect(resolveShopifySettings({ SHOPIFY_STORE: "demo.myshopify.com", SHOPIFY_ADMIN_TOKEN: "t", SHOPKEEPER_SHOPIFY_WRITES: "1" }).writesEnabled).toBe(true);
    expect(() => resolveShopifySettings({ SHOPIFY_STORE: "evil.example.com", SHOPIFY_ADMIN_TOKEN: "t" })).toThrow();
  });
});

describe("reads", () => {
  it("get_order maps a Shopify order", async () => {
    const { ctx } = setup();
    const { data } = await run(getOrder, ctx, { order_id: 1042 });
    expect(data.order).toMatchObject({ id: 1042, name: "#1042", status: "paid", allowed_next_statuses: ["shipped"] });
    expect(data.financials).toMatchObject({ currency: "USD", total_cents: 10500, refunded_cents: 0, refundable_cents: 10500 });
    expect(data.items[0]).toMatchObject({ sku: "KET-1", unit_price_cents: 10000, line_total_cents: 10000 });
    expect(data.customer?.name).toBe("Marcus Reid");
  });
  it("get_order: unknown order is NOT_FOUND", async () => {
    const { ctx } = setup();
    expect(await code(run(getOrder, ctx, { order_id: 9999 }))).toEqual({ code: "NOT_FOUND", reason: "ORDER_NOT_FOUND" });
  });
  it("list_orders filters by status, dates and total, and paginates", async () => {
    const { ctx } = setup();
    const all = await run(listOrders, ctx, {});
    expect(all.data.total_count).toBe(4);
    expect(all.data.orders[0]!.id).toBe(1045); // newest first
    const paid = await run(listOrders, ctx, { status: "paid", placed_from: "2026-09-01", placed_to: "2026-09-30" });
    expect(paid.data.orders.map((o) => o.id)).toEqual([1045, 1042]);
    const page = await run(listOrders, ctx, { limit: 1, offset: 1 });
    expect(page.data.orders).toHaveLength(1);
    expect(page.data.next_offset).toBe(2);
    expect((await run(listOrders, ctx, { max_total_cents: 6000 })).data.orders.map((o) => o.id)).toEqual([1043]);
    expect(await code(run(listOrders, ctx, { placed_from: "2026-10-01", placed_to: "2026-09-01" }))).toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("sales_report excludes pending orders and nets refunds", async () => {
    const { ctx } = setup();
    await run(issueRefund, ctx, { order_id: 1042, amount_cents: 2500, reason: "Damaged lid", idempotency_key: "refund-1042-damaged" });
    const r = await run(salesReport, ctx, { from: "2026-09-01", to: "2026-09-30", group_by: "month" });
    expect(r.data.rows).toHaveLength(1);
    expect(r.data.totals).toMatchObject({ orders: 2, gross_cents: 21000, refunds_cents: 2500, net_cents: 18500 });
    expect(r.data.currency).toBe("USD");
  });
  it("search_customers flags two equally good Morgan Ellis matches", async () => {
    const { ctx } = setup();
    const r = await run(searchCustomers, ctx, { query: "Morgan Ellis" });
    expect(r.data.matches).toHaveLength(2);
    expect(r.data.ambiguous).toBe(true);
    const one = await run(searchCustomers, ctx, { query: "marcus.reid@example.com" });
    expect(one.data.matches[0]).toMatchObject({ match_type: "exact_email", customer_id: 34 });
    expect(one.data.ambiguous).toBe(false);
  });
});

describe("issue_refund guardrails", () => {
  it("is refused when writes are disabled, and Shopify is never mutated", async () => {
    const { ctx, fake } = setup(defaultOrders(), { writesEnabled: false });
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 1000, reason: "test refund", idempotency_key: "refund-1042-test" }))).toEqual({ code: "GUARDRAIL_VIOLATION", reason: "WRITES_DISABLED" });
    expect(fake.calls).toHaveLength(0);
  });
  it("refuses over-refund, unpaid orders, and refunds over the cap", async () => {
    const { ctx, fake } = setup(defaultOrders(), { maxRefundMinor: 5000 });
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 20000, reason: "too much", idempotency_key: "refund-1042-big" }))).toMatchObject({ reason: "REFUND_EXCEEDS_REFUNDABLE" });
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 6000, reason: "over cap", idempotency_key: "refund-1042-cap" }))).toMatchObject({ reason: "REFUND_OVER_CAP" });
    expect(await code(run(issueRefund, ctx, { order_id: 1043, amount_cents: 1000, reason: "unpaid one", idempotency_key: "refund-1043-unpaid" }))).toMatchObject({ reason: "ORDER_NOT_REFUNDABLE" });
    expect(fake.mutationCalls("Refund")).toBe(0);
  });
  it("rejects unknown arguments and missing idempotency_key", async () => {
    const { ctx } = setup();
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 1000, reason: "no key here" }))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 1000, reason: "dry run?", idempotency_key: "refund-1042-dry", dry_run: true }))).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("issue_refund behaviour", () => {
  it("refunds against the original payment with a decimal amount and an @idempotent mutation", async () => {
    const { ctx, fake } = setup();
    const r = await run(issueRefund, ctx, { order_id: 1042, amount_cents: 2500, reason: "Damaged lid", idempotency_key: "refund-1042-damaged" });
    expect(r.data).toMatchObject({ replayed: false, order: { status: "paid", refunded_cents: 2500, refundable_cents: 8000 } });
    const call = fake.calls.find((c) => c.query.includes("mutation Refund"))!;
    expect(call.query).toContain("refundCreate(input: $input) @idempotent(key: $key)");
    expect(call.variables.key).toBe(shopifyIdempotencyKey("refund-1042-damaged"));
    expect(call.variables.input.allowOverRefunding).toBe(false);
    expect(call.variables.input.transactions[0]).toMatchObject({ parentId: "gid://shopify/OrderTransaction/55", amount: "25.00", kind: "REFUND", gateway: "shopify_payments" });
    expect(call.variables.input.notify).toBe(false);
    expect(call.variables.input.note).toContain("[shopkeeper:refund-1042-damaged]");
  });
  it("replays the same key without a second mutation, and conflicts on a changed amount", async () => {
    const { ctx, fake } = setup();
    const args = { order_id: 1042, amount_cents: 2500, reason: "Damaged lid", idempotency_key: "refund-1042-damaged" };
    const first = await run(issueRefund, ctx, args);
    const again = await run(issueRefund, ctx, args);
    expect(again.data.replayed).toBe(true);
    expect(again.data.refund.id).toBe(first.data.refund.id);
    expect(fake.mutationCalls("Refund")).toBe(1);
    expect(fake.orders[0]!.totalRefundedSet.shopMoney.amount).toBe("25.00");
    expect(await code(run(issueRefund, ctx, { ...args, amount_cents: 3000 }))).toEqual({ code: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(fake.mutationCalls("Refund")).toBe(1);
  });
  it("a full refund flips the order to refunded and blocks further refunds", async () => {
    const { ctx } = setup();
    const r = await run(issueRefund, ctx, { order_id: 1042, amount_cents: 10500, reason: "Full refund", idempotency_key: "refund-1042-full" });
    expect(r.data.order).toMatchObject({ status: "refunded", refundable_cents: 0 });
    expect(await code(run(issueRefund, ctx, { order_id: 1042, amount_cents: 100, reason: "again please", idempotency_key: "refund-1042-more" }))).toMatchObject({ reason: "ORDER_FULLY_REFUNDED" });
  });
  it("never offers more than was actually received (partially paid order)", async () => {
    const orders = [makeOrder({ number: 2002, netPaymentSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } } })];
    const { ctx, fake } = setup(orders);
    expect((await run(getOrder, ctx, { order_id: 2002 })).data.financials.refundable_cents).toBe(4000);
    expect(await code(run(issueRefund, ctx, { order_id: 2002, amount_cents: 5000, reason: "more than paid", idempotency_key: "refund-2002-over" }))).toMatchObject({ reason: "REFUND_EXCEEDS_REFUNDABLE" });
    expect(fake.mutationCalls("Refund")).toBe(0);
  });
  it("finds an order whose name has a custom prefix", async () => {
    const { ctx } = setup([makeOrder({ number: 3001, name: "EU3001" })]);
    expect((await run(getOrder, ctx, { order_id: 3001 })).data.order.name).toBe("EU3001");
  });
  it("refuses when no single payment covers the amount", async () => {
    const orders = [makeOrder({ number: 2001, transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "manual", amountSet: { shopMoney: { amount: "20.00", currencyCode: "USD" } } }] })];
    const { ctx } = setup(orders);
    expect(await code(run(issueRefund, ctx, { order_id: 2001, amount_cents: 5000, reason: "split payment", idempotency_key: "refund-2001-split" }))).toMatchObject({ reason: "NO_PAYMENT_TO_REFUND_AGAINST" });
  });
});

describe("update_order_status", () => {
  it("is refused when writes are disabled", async () => {
    const { ctx, fake } = setup(defaultOrders(), { writesEnabled: false });
    expect(await code(run(updateOrderStatus, ctx, { order_id: 1042, status: "shipped" }))).toMatchObject({ reason: "WRITES_DISABLED" });
    expect(fake.calls).toHaveLength(0);
  });
  it("walks paid -> shipped -> delivered and no-ops on repeats", async () => {
    const { ctx, fake } = setup();
    const shipped = await run(updateOrderStatus, ctx, { order_id: 1042, status: "shipped" });
    expect(shipped.data).toMatchObject({ previous_status: "paid", status: "shipped", changed: true, pending_confirmation: false });
    const delivered = await run(updateOrderStatus, ctx, { order_id: 1042, status: "delivered" });
    expect(delivered.data).toMatchObject({ status: "delivered", changed: true });
    const noop = await run(updateOrderStatus, ctx, { order_id: 1042, status: "delivered" });
    expect(noop.data.changed).toBe(false);
    expect(fake.mutationCalls("Fulfil")).toBe(1);
    expect(fake.mutationCalls("Delivered")).toBe(1);
  });
  it("marks a pending order paid", async () => {
    const { ctx } = setup();
    const r = await run(updateOrderStatus, ctx, { order_id: 1043, status: "paid" });
    expect(r.data).toMatchObject({ previous_status: "pending", status: "paid", changed: true });
  });
  it("rejects skipping steps, direct refunded, and cancelling a paid order", async () => {
    const { ctx, fake } = setup();
    expect(await code(run(updateOrderStatus, ctx, { order_id: 1043, status: "delivered" }))).toEqual({ code: "CONFLICT", reason: "INVALID_STATUS_TRANSITION" });
    expect(await code(run(updateOrderStatus, ctx, { order_id: 1042, status: "refunded" }))).toMatchObject({ code: "CONFLICT" });
    expect(await code(run(updateOrderStatus, ctx, { order_id: 1042, status: "cancelled" }))).toMatchObject({ code: "CONFLICT" });
    expect(fake.calls.filter((c) => c.query.includes("mutation"))).toHaveLength(0);
  });
  it("reports pending_confirmation when a cancel is still processing", async () => {
    const { ctx } = setup();
    const r = await run(updateOrderStatus, ctx, { order_id: 1043, status: "cancelled" });
    expect(r.data).toMatchObject({ requested_status: "cancelled", status: "pending", changed: false, pending_confirmation: true });
    expect(r.summary).toMatch(/re-check/i);
  });
});

describe("MCP surface (in-memory client)", () => {
  it("lists 6 tools, validates structured output, and maps errors", async () => {
    const { ctx } = setup();
    const server = createShopifyServer(ctx, "demo.myshopify.com");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_order", "issue_refund", "list_orders", "sales_report", "search_customers", "update_order_status"]);
    const ok = (await client.callTool({ name: "get_order", arguments: { order_id: 1042 } })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { order: { id: number } }).order.id).toBe(1042);
    for (const t of ["list_orders", "sales_report", "search_customers"] as const) {
      const args = t === "list_orders" ? {} : t === "sales_report" ? { from: "2026-08-01", to: "2026-09-30" } : { query: "Marcus" };
      const r = (await client.callTool({ name: t, arguments: args })) as CallToolResult;
      expect(r.isError, t).toBeFalsy();
    }
    const refund = (await client.callTool({ name: "issue_refund", arguments: { order_id: 1042, amount_cents: 99999, reason: "way too much", idempotency_key: "refund-1042-huge" } })) as CallToolResult;
    expect(refund.isError).toBe(true);
    expect(JSON.parse((refund.content[0] as { text: string }).text).error.reason).toBe("REFUND_EXCEEDS_REFUNDABLE");
    const okRefund = (await client.callTool({ name: "issue_refund", arguments: { order_id: 1042, amount_cents: 1000, reason: "goodwill", idempotency_key: "refund-1042-goodwill" } })) as CallToolResult;
    expect(okRefund.isError).toBeFalsy();
    await client.close();
  });
});
