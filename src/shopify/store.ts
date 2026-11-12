import { createHash } from "node:crypto";
import type { OrderStatus } from "../db/schema.js";
import { ConflictError, GuardrailViolation, NotFoundError, UpstreamError } from "../errors.js";
import type { ShopifyClient } from "./client.js";
import { decimalToMinor, gidToNumber, minorToDecimal } from "./money.js";
import { CANCEL, CUSTOMERS, DELIVERED, FULFIL, MARK_PAID, ORDER_BY_NAME, ORDERS_PAGE, REFUND, SHOP_INFO } from "./operations.js";

// ---- Normalised model -----------------------------------------------------

export interface ShopifyMoneySet {
  shopMoney: { amount: string; currencyCode: string };
}

interface RawFulfillment {
  id: string;
  status: string;
  displayStatus: string | null;
  createdAt: string;
  deliveredAt: string | null;
  trackingInfo: { number: string | null; company: string | null }[];
}

export interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: ShopifyMoneySet;
  subtotalPriceSet: ShopifyMoneySet;
  totalShippingPriceSet: ShopifyMoneySet;
  totalRefundedSet: ShopifyMoneySet;
  /** Payments received minus refunds: the most that can still be refunded. */
  netPaymentSet: ShopifyMoneySet;
  customer: { id: string; displayName: string | null; defaultEmailAddress: { emailAddress: string | null } | null; defaultAddress: { city: string | null; province: string | null } | null } | null;
  refunds: { id: string; createdAt: string; note: string | null; totalRefundedSet: ShopifyMoneySet }[];
  fulfillments: RawFulfillment[];
  lineItems?: { nodes: { name: string; sku: string | null; quantity: number; originalUnitPriceSet: ShopifyMoneySet; product: { id: string } | null }[] };
  transactions?: { id: string; kind: string; status: string; gateway: string | null; amountSet: ShopifyMoneySet }[];
  fulfillmentOrders?: { nodes: { id: string; status: string }[] };
}

export interface ShopifyOrder {
  gid: string;
  /** Order number as an integer (from "#1042"). This is the order_id the tools use. */
  id: number;
  name: string;
  currency: string;
  status: OrderStatus;
  placed_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  subtotal: number;
  shipping: number;
  total: number;
  refunded: number;
  /** Payments received minus refunds, in minor units. */
  netPayment: number;
  customer: { id: number; name: string; email: string; city: string; region: string } | null;
  raw: RawOrder;
}

/** "#1042" -> 1042; "EU-1042-A" -> 1042. Throws if there are no digits. */
export function orderNumberFromName(name: string): number {
  const m = /(\d+)/.exec(name);
  if (!m?.[1]) throw new TypeError(`Cannot read an order number from ${JSON.stringify(name)}`);
  return Number(m[1]);
}

/**
 * Collapse Shopify's two status axes (payment, fulfilment) into the lifecycle
 * this server's guardrails reason about:
 *   cancelled | pending | paid | shipped | delivered | refunded
 */
export function deriveStatus(raw: RawOrder): OrderStatus {
  const fin = raw.displayFinancialStatus ?? "";
  if (fin === "REFUNDED") return "refunded";
  if (fin === "VOIDED") return "cancelled";
  const paid = fin === "PAID" || fin === "PARTIALLY_REFUNDED";
  if (raw.cancelledAt && !paid) return "cancelled";
  if (!paid) return "pending";
  const live = raw.fulfillments.filter((f) => f.status !== "CANCELLED" && f.status !== "ERROR" && f.status !== "FAILURE");
  if (live.length === 0) return "paid";
  if (live.every((f) => f.displayStatus === "DELIVERED" || f.deliveredAt)) return "delivered";
  return "shipped";
}

export function normalizeOrder(raw: RawOrder): ShopifyOrder {
  const currency = raw.totalPriceSet.shopMoney.currencyCode;
  const money = (s: ShopifyMoneySet) => decimalToMinor(s.shopMoney.amount, currency);
  const live = raw.fulfillments.filter((f) => f.status !== "CANCELLED" && f.status !== "ERROR" && f.status !== "FAILURE");
  const shipped = live.map((f) => f.createdAt).sort()[0] ?? null;
  const delivered = live.length > 0 && live.every((f) => f.deliveredAt) ? live.map((f) => f.deliveredAt as string).sort().at(-1) ?? null : null;
  const c = raw.customer;
  return {
    gid: raw.id,
    id: orderNumberFromName(raw.name),
    name: raw.name,
    currency,
    status: deriveStatus(raw),
    placed_at: raw.createdAt,
    shipped_at: shipped,
    delivered_at: delivered,
    cancelled_at: raw.cancelledAt,
    subtotal: money(raw.subtotalPriceSet),
    shipping: money(raw.totalShippingPriceSet),
    total: money(raw.totalPriceSet),
    refunded: money(raw.totalRefundedSet),
    netPayment: money(raw.netPaymentSet),
    customer: c
      ? {
          id: gidToNumber(c.id),
          name: c.displayName ?? "(no name)",
          email: c.defaultEmailAddress?.emailAddress ?? "",
          city: c.defaultAddress?.city ?? "",
          region: c.defaultAddress?.province ?? "",
        }
      : null,
    raw,
  };
}

/** Deterministic UUID-shaped key so a retried refund reuses Shopify's own idempotency window. */
export function shopifyIdempotencyKey(key: string): string {
  const h = createHash("sha256").update(`shopkeeper:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const REFUND_MARKER = (key: string) => `[shopkeeper:${key}]`;

interface UserError {
  field?: string[] | null;
  message: string;
}

function assertNoUserErrors(op: string, errors: UserError[] | undefined | null): void {
  if (errors && errors.length > 0) {
    throw new UpstreamError("SHOPIFY_REJECTED", `Shopify rejected ${op}: ${errors.map((e) => e.message).join("; ")}`, {
      operation: op,
      user_errors: errors.map((e) => ({ field: e.field ?? [], message: e.message })),
    });
  }
}

export const MAX_SCAN_ORDERS = 1000;

export interface ListFilter {
  /** inclusive YYYY-MM-DD */
  placedFrom?: string;
  /** inclusive YYYY-MM-DD */
  placedTo?: string;
  customerId?: number;
  maxOrders?: number;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export class ShopifyStore {
  constructor(private readonly client: ShopifyClient) {}

  async getOrder(number: number): Promise<ShopifyOrder> {
    // "#1042" is the default name format; stores with a custom prefix/suffix need the bare number.
    for (const q of [`name:#${number}`, `name:${number}`]) {
      const data = await this.client.graphql<{ orders: { nodes: RawOrder[] } }>(ORDER_BY_NAME, { q });
      const match = data.orders.nodes.map(normalizeOrder).find((o) => o.id === number);
      if (match) return match;
    }
    throw new NotFoundError("ORDER_NOT_FOUND", `Order ${number} does not exist (or is older than the 60 days this app token can read).`, { order_id: number });
  }

  /** Cheap authenticated call: confirms the store, token and API version work. */
  async shopInfo(): Promise<{ name: string; domain: string; currency: string }> {
    const data = await this.client.graphql<{ shop: { name: string; myshopifyDomain: string; currencyCode: string } }>(SHOP_INFO);
    return { name: data.shop.name, domain: data.shop.myshopifyDomain, currency: data.shop.currencyCode };
  }

  /** Newest first. `truncated` is true when the scan stopped at the cap with more pages remaining. */
  async listOrders(filter: ListFilter): Promise<{ orders: ShopifyOrder[]; truncated: boolean }> {
    const parts: string[] = [];
    if (filter.placedFrom) parts.push(`created_at:>='${filter.placedFrom}T00:00:00Z'`);
    if (filter.placedTo) parts.push(`created_at:<'${nextDay(filter.placedTo)}T00:00:00Z'`);
    if (filter.customerId) parts.push(`customer_id:${filter.customerId}`);
    const cap = filter.maxOrders ?? MAX_SCAN_ORDERS;
    const orders: ShopifyOrder[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { orders: { nodes: RawOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.client.graphql(
        ORDERS_PAGE,
        { q: parts.join(" ") || null, after },
      );
      for (const n of data.orders.nodes) orders.push(normalizeOrder(n));
      if (!data.orders.pageInfo.hasNextPage) return { orders, truncated: false };
      if (orders.length >= cap) return { orders: orders.slice(0, cap), truncated: true };
      after = data.orders.pageInfo.endCursor;
    }
  }

  async searchCustomers(query: string, limit: number): Promise<
    { id: number; name: string; email: string; city: string; region: string; order_count: number; spent: number; currency: string; last_order_at: string | null }[]
  > {
    const data = await this.client.graphql<{
      customers: { nodes: { id: string; displayName: string | null; defaultEmailAddress: { emailAddress: string | null } | null; numberOfOrders: string; amountSpent: { amount: string; currencyCode: string }; defaultAddress: { city: string | null; province: string | null } | null; lastOrder: { createdAt: string } | null }[] };
    }>(
      CUSTOMERS,
      { q: query, n: Math.min(limit * 3, 50) },
    );
    return data.customers.nodes.map((c) => ({
      id: gidToNumber(c.id),
      name: c.displayName ?? "(no name)",
      email: c.defaultEmailAddress?.emailAddress ?? "",
      city: c.defaultAddress?.city ?? "",
      region: c.defaultAddress?.province ?? "",
      order_count: Number(c.numberOfOrders),
      spent: decimalToMinor(c.amountSpent.amount, c.amountSpent.currencyCode),
      currency: c.amountSpent.currencyCode,
      last_order_at: c.lastOrder?.createdAt ?? null,
    }));
  }

  // ---- writes -------------------------------------------------------------

  async markPaid(order: ShopifyOrder): Promise<void> {
    const data = await this.client.graphql<{ orderMarkAsPaid: { userErrors: UserError[] } }>(
      MARK_PAID,
      { input: { id: order.gid } },
    );
    assertNoUserErrors("orderMarkAsPaid", data.orderMarkAsPaid.userErrors);
  }

  async cancel(order: ShopifyOrder): Promise<void> {
    const data = await this.client.graphql<{ orderCancel: { userErrors: UserError[] } }>(
      CANCEL,
      { id: order.gid },
    );
    assertNoUserErrors("orderCancel", data.orderCancel.userErrors);
  }

  async fulfill(order: ShopifyOrder): Promise<void> {
    const open = (order.raw.fulfillmentOrders?.nodes ?? []).filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS");
    if (open.length === 0) {
      throw new ConflictError("NOTHING_TO_FULFILL", `Order ${order.id} has no open fulfilment orders (it may be handled by a fulfilment service or already shipped).`, { order_id: order.id });
    }
    const data = await this.client.graphql<{ fulfillmentCreate: { userErrors: UserError[] } }>(
      FULFIL,
      { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })) } },
    );
    assertNoUserErrors("fulfillmentCreate", data.fulfillmentCreate.userErrors);
  }

  async markDelivered(order: ShopifyOrder): Promise<void> {
    const targets = order.raw.fulfillments.filter((f) => f.status === "SUCCESS" && !f.deliveredAt);
    if (targets.length === 0) {
      throw new ConflictError("NOTHING_TO_DELIVER", `Order ${order.id} has no shipped fulfilment awaiting delivery.`, { order_id: order.id });
    }
    for (const f of targets) {
      const data = await this.client.graphql<{ fulfillmentEventCreate: { userErrors: UserError[] } }>(
        DELIVERED,
        { e: { fulfillmentId: f.id, status: "DELIVERED" } },
      );
      assertNoUserErrors("fulfillmentEventCreate", data.fulfillmentEventCreate.userErrors);
    }
  }

  /** Creates an amount-only refund against a successful payment. Returns the refund's gid and timestamp. */
  async refund(order: ShopifyOrder, amountMinor: number, reason: string, key: string): Promise<{ id: string; createdAt: string }> {
    const parent = (order.raw.transactions ?? []).find(
      (t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS" && decimalToMinor(t.amountSet.shopMoney.amount, order.currency) >= amountMinor,
    );
    if (!parent || !parent.gateway) {
      throw new GuardrailViolation("NO_PAYMENT_TO_REFUND_AGAINST", `Order ${order.id} has no single successful payment of at least this size to refund against. Refund a smaller amount or use the Shopify admin.`, { order_id: order.id, requested: amountMinor });
    }
    const data = await this.client.graphql<{
      refundCreate: { refund: { id: string; createdAt: string } | null; userErrors: UserError[] };
    }>(
      REFUND,
      {
        key: shopifyIdempotencyKey(key),
        input: {
          orderId: order.gid,
          notify: false,
          allowOverRefunding: false,
          note: `${reason} ${REFUND_MARKER(key)}`,
          transactions: [{ orderId: order.gid, parentId: parent.id, amount: minorToDecimal(amountMinor, order.currency), kind: "REFUND", gateway: parent.gateway }],
        },
      },
    );
    assertNoUserErrors("refundCreate", data.refundCreate.userErrors);
    if (!data.refundCreate.refund) throw new UpstreamError("SHOPIFY_BAD_RESPONSE", "Shopify did not return the created refund.", {});
    return data.refundCreate.refund;
  }
}

