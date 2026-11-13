/**
 * An in-memory stand-in for the Shopify Admin GraphQL API. It answers only the
 * operations the connector uses and mutates its own state the way Shopify does
 * (refunds change totals/financial status, etc.), so tests exercise real flows.
 * It is NOT proof of live compatibility - see README "Shopify: verified vs not".
 */
import type { FetchLike } from "../src/shopify/client.js";
import { ALL_OPERATIONS } from "../src/shopify/operations.js";
import type { RawOrder } from "../src/shopify/store.js";

const set = (amount: string, currencyCode = "USD") => ({ shopMoney: { amount, currencyCode } });

export function makeOrder(over: Partial<RawOrder> & { number: number }): RawOrder {
  const { number, ...rest } = over;
  return {
    id: `gid://shopify/Order/${9000 + number}`,
    name: `#${number}`,
    createdAt: "2026-09-10T10:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    totalPriceSet: set("105.00"),
    subtotalPriceSet: set("100.00"),
    totalShippingPriceSet: set("5.00"),
    totalRefundedSet: set("0.00"),
    netPaymentSet: set("105.00"),
    customer: { id: "gid://shopify/Customer/34", displayName: "Marcus Reid", defaultEmailAddress: { emailAddress: "marcus.reid@example.com" }, defaultAddress: { city: "Austin", province: "Texas" } },
    refunds: [],
    fulfillments: [],
    lineItems: { nodes: [{ name: "Gooseneck Kettle", sku: "KET-1", quantity: 1, originalUnitPriceSet: set("100.00") }] },
    transactions: [{ id: "gid://shopify/OrderTransaction/55", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: set("105.00") }],
    fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/66", status: "OPEN" }] },
    ...rest,
  };
}

export interface FakeShopify {
  fetch: FetchLike;
  orders: RawOrder[];
  /** every GraphQL request body, in order */
  calls: { query: string; variables: Record<string, any> }[];
  mutationCalls: (name: string) => number;
}

export function fakeShopify(orders: RawOrder[]): FakeShopify {
  const calls: FakeShopify["calls"] = [];
  let refundSeq = 800;
  const idempotent = new Map<string, { id: string; createdAt: string }>();
  const known = new Set(Object.values(ALL_OPERATIONS));
  const findByGid = (gid: unknown) => orders.find((o) => o.id === gid);

  const reply = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });

  const fetch: FetchLike = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    calls.push({ query, variables });
    // Only documents that `npm run shopify:validate` checks against the real schema may be sent.
    if (!known.has(query)) throw new Error(`fake Shopify: document is not in ALL_OPERATIONS: ${query.slice(0, 60)}`);

    if (query.includes("query OrderByName")) {
      const n = /^name:#(\d+)$/.exec(String(variables.q))?.[1];
      const bare = /^name:(\d+)$/.exec(String(variables.q))?.[1];
      return reply({ orders: { nodes: orders.filter((o) => (n && o.name === `#${n}`) || (bare && o.name.includes(bare))) } });
    }
    if (query.includes("query Orders(")) {
      const q = String(variables.q ?? "");
      const from = /created_at:>='(\d{4}-\d{2}-\d{2})T00:00:00Z'/.exec(q)?.[1];
      const before = /created_at:<'(\d{4}-\d{2}-\d{2})T00:00:00Z'/.exec(q)?.[1];
      const cust = /customer_id:(\d+)/.exec(q)?.[1];
      const rows = orders
        .filter((o) => (!from || o.createdAt.slice(0, 10) >= from) && (!before || o.createdAt.slice(0, 10) < before) && (!cust || o.customer?.id.endsWith(`/${cust}`)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return reply({ orders: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (query.includes("query ShopInfo")) {
      return reply({ shop: { name: "demo", myshopifyDomain: "demo.myshopify.com", currencyCode: "USD", plan: { partnerDevelopment: true, publicDisplayName: "Development" } } });
    }
    if (query.includes("query Customers")) {
      const q = String(variables.q).toLowerCase();
      const seen = new Map<string, any>();
      for (const o of orders) {
        const c = o.customer;
        if (c && `${c.displayName} ${c.defaultEmailAddress?.emailAddress}`.toLowerCase().includes(q)) {
          seen.set(c.id, { ...c, numberOfOrders: "2", amountSpent: { amount: "210.00", currencyCode: "USD" }, lastOrder: { createdAt: o.createdAt } });
        }
      }
      return reply({ customers: { nodes: [...seen.values()] } });
    }
    if (query.includes("mutation Refund")) {
      const input = variables.input;
      const o = findByGid(input.orderId)!;
      // Shopify requires a UUID-shaped key and replays the stored result for a repeated key.
      if (!/^[0-9a-f-]{36}$/.test(String(variables.key))) return reply({ refundCreate: { refund: null, userErrors: [{ field: null, message: "Idempotency key is required" }] } });
      const cached = idempotent.get(variables.key);
      if (cached) return reply({ refundCreate: { refund: cached, userErrors: [] } });
      const amount = input.transactions[0].amount as string;
      const total = Number(o.totalRefundedSet.shopMoney.amount) + Number(amount);
      o.totalRefundedSet = set(total.toFixed(2));
      o.netPaymentSet = set((Number(o.netPaymentSet.shopMoney.amount) - Number(amount)).toFixed(2));
      o.displayFinancialStatus = total >= Number(o.totalPriceSet.shopMoney.amount) ? "REFUNDED" : "PARTIALLY_REFUNDED";
      const id = `gid://shopify/Refund/${++refundSeq}`;
      o.refunds.push({ id, createdAt: "2026-09-30T18:00:00Z", note: input.note, totalRefundedSet: set(amount) });
      idempotent.set(variables.key, { id, createdAt: "2026-09-30T18:00:00Z" });
      return reply({ refundCreate: { refund: { id, createdAt: "2026-09-30T18:00:00Z" }, userErrors: [] } });
    }
    if (query.includes("mutation MarkPaid")) {
      const paidOrder = findByGid(variables.input.id)!;
      paidOrder.displayFinancialStatus = "PAID";
      paidOrder.netPaymentSet = paidOrder.totalPriceSet;
      return reply({ orderMarkAsPaid: { userErrors: [] } });
    }
    if (query.includes("mutation Cancel")) {
      return reply({ orderCancel: { userErrors: [] } }); // background job: order not changed yet
    }
    if (query.includes("mutation Fulfil")) {
      const fo = variables.f.lineItemsByFulfillmentOrder[0].fulfillmentOrderId;
      const o = orders.find((x) => x.fulfillmentOrders?.nodes.some((n) => n.id === fo))!;
      o.fulfillments.push({ id: "gid://shopify/Fulfillment/77", status: "SUCCESS", displayStatus: "FULFILLED", createdAt: "2026-09-12T09:00:00Z", deliveredAt: null, trackingInfo: [] });
      o.displayFulfillmentStatus = "FULFILLED";
      return reply({ fulfillmentCreate: { userErrors: [] } });
    }
    if (query.includes("mutation Delivered")) {
      const f = orders.flatMap((o) => o.fulfillments).find((x) => x.id === variables.e.fulfillmentId)!;
      f.displayStatus = "DELIVERED";
      f.deliveredAt = "2026-09-15T12:00:00Z";
      return reply({ fulfillmentEventCreate: { userErrors: [] } });
    }
    throw new Error(`fake Shopify: unhandled operation: ${query.slice(0, 60)}`);
  };

  return { fetch, orders, calls, mutationCalls: (name) => calls.filter((c) => c.query.includes(`mutation ${name}`)).length };
}
