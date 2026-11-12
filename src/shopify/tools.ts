import fs from "node:fs";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isoTimestamp, type Clock } from "../clock.js";
import { ORDER_STATUSES, type OrderStatus } from "../db/schema.js";
import { similarity, tokenSimilarity, normalizeText } from "../domain/fuzzy.js";
import { allowedNextStatuses, canTransition, REFUNDABLE_STATUSES, REVENUE_STATUSES } from "../domain/status-machine.js";
import { ConflictError, GuardrailViolation, ValidationError } from "../errors.js";
import { isoWeek } from "../tools/sales-report.js";
import {
  isoDateField,
  orderIdField,
  readOnlyAnnotations,
  writeAnnotations,
  type ObjectSchema,
  type ToolOutcome,
} from "../tools/types.js";
import type { ShopifySettings } from "./config.js";
import { decimalToMinor, gidToNumber, minorToDecimal } from "./money.js";
import { REFUND_MARKER, type ShopifyOrder, type ShopifyStore } from "./store.js";

export interface ShopifyToolContext {
  store: ShopifyStore;
  settings: Pick<ShopifySettings, "writesEnabled" | "maxRefundMinor" | "auditFile">;
  clock: Clock;
  actor: string;
}

export interface ShopifyToolSpec<I extends ObjectSchema = ObjectSchema, O extends ObjectSchema = ObjectSchema> {
  name: string;
  title: string;
  description: string;
  kind: "read" | "write";
  input: I;
  output: O;
  annotations: ToolAnnotations;
  handler: (ctx: ShopifyToolContext, input: z.output<I>) => Promise<ToolOutcome<z.output<O>>>;
}

function defineShopifyTool<I extends ObjectSchema, O extends ObjectSchema>(spec: ShopifyToolSpec<I, O>): ShopifyToolSpec<I, O> {
  return spec;
}

export async function invokeShopifyTool<I extends ObjectSchema, O extends ObjectSchema>(
  spec: ShopifyToolSpec<I, O>,
  ctx: ShopifyToolContext,
  rawInput: unknown,
): Promise<ToolOutcome<z.output<O>>> {
  const parsed = spec.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ValidationError("INVALID_INPUT", `Invalid arguments for ${spec.name}: ${z.prettifyError(parsed.error)}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return spec.handler(ctx, parsed.data);
}

// ---- helpers --------------------------------------------------------------

const statusEnum = z.enum(ORDER_STATUSES);

/** Minor units -> "USD 105.00" (exponent-aware) for summaries. */
function money(minor: number, currency: string): string {
  return currency ? `${currency} ${minorToDecimal(minor, currency)}` : String(minor);
}

function requireWrites(ctx: ShopifyToolContext, tool: string): void {
  if (!ctx.settings.writesEnabled) {
    throw new GuardrailViolation(
      "WRITES_DISABLED",
      `${tool} is disabled: this server was started read-only. The store owner must set SHOPKEEPER_SHOPIFY_WRITES=1 to allow changes. Nothing was changed.`,
      { tool },
    );
  }
}

function audit(ctx: ShopifyToolContext, action: string, orderId: number, details: unknown): void {
  const line = JSON.stringify({ at: isoTimestamp(ctx.clock()), actor: ctx.actor, action, entity: "order", entity_id: orderId, details });
  console.error(`[shopkeeper:audit] ${line}`);
  if (ctx.settings.auditFile) fs.appendFileSync(ctx.settings.auditFile, `${line}\n`);
}

export function refundEligibilityFor(order: ShopifyOrder): { eligible: boolean; refundable_cents: number; reason: string | null } {
  const remaining = Math.max(0, order.total - order.refunded);
  if (order.status === "refunded" || (REFUNDABLE_STATUSES.includes(order.status) && remaining === 0)) {
    return { eligible: false, refundable_cents: 0, reason: "Order is already fully refunded." };
  }
  if (order.status === "pending") return { eligible: false, refundable_cents: 0, reason: "Order is unpaid; no payment has been captured." };
  if (order.status === "cancelled") return { eligible: false, refundable_cents: 0, reason: "Order was cancelled; nothing to refund." };
  return { eligible: true, refundable_cents: remaining, reason: null };
}

function refundRows(order: ShopifyOrder) {
  return order.raw.refunds.map((r) => ({
    id: gidToNumber(r.id),
    amount_cents: decimalToMinor(r.totalRefundedSet.shopMoney.amount, order.currency),
    created_at: r.createdAt,
    note: r.note,
  }));
}

// ---- get_order ------------------------------------------------------------

export const getOrder = defineShopifyTool({
  name: "get_order",
  title: "Get order",
  kind: "read",
  description:
    "Full detail for one Shopify order by its order number (e.g. 1042 for '#1042'): customer, line items, totals, refunds, refundable remainder, fulfilment/delivery state and allowed next statuses. Call this before any write.",
  input: z.strictObject({ order_id: orderIdField }),
  output: z.object({
    order: z.object({
      id: z.number().int(),
      name: z.string(),
      status: statusEnum,
      placed_at: z.string(),
      shipped_at: z.string().nullable(),
      delivered_at: z.string().nullable(),
      cancelled_at: z.string().nullable(),
      allowed_next_statuses: z.array(statusEnum),
    }),
    customer: z.object({ id: z.number().int(), name: z.string(), email: z.string(), city: z.string(), region: z.string() }).nullable(),
    items: z.array(z.object({ name: z.string(), sku: z.string().nullable(), quantity: z.number().int(), unit_price_cents: z.number().int(), line_total_cents: z.number().int() })),
    financials: z.object({
      currency: z.string(),
      subtotal_cents: z.number().int(),
      shipping_cents: z.number().int(),
      total_cents: z.number().int(),
      refunded_cents: z.number().int(),
      refundable_cents: z.number().int(),
    }),
    refund_eligibility: z.object({ eligible: z.boolean(), refundable_cents: z.number().int(), reason: z.string().nullable() }),
    fulfillments: z.array(z.object({ status: z.string(), delivery_status: z.string().nullable(), created_at: z.string(), delivered_at: z.string().nullable(), tracking: z.array(z.object({ number: z.string().nullable(), company: z.string().nullable() })) })),
    refunds: z.array(z.object({ id: z.number().int(), amount_cents: z.number().int(), created_at: z.string(), note: z.string().nullable() })),
  }),
  annotations: readOnlyAnnotations("Get order"),
  handler: async ({ store }, { order_id }) => {
    const o = await store.getOrder(order_id);
    const elig = refundEligibilityFor(o);
    const items = (o.raw.lineItems?.nodes ?? []).map((li) => {
      const unit = decimalToMinor(li.originalUnitPriceSet.shopMoney.amount, o.currency);
      return { name: li.name, sku: li.sku, quantity: li.quantity, unit_price_cents: unit, line_total_cents: unit * li.quantity };
    });
    const data = {
      order: {
        id: o.id,
        name: o.name,
        status: o.status,
        placed_at: o.placed_at,
        shipped_at: o.shipped_at,
        delivered_at: o.delivered_at,
        cancelled_at: o.cancelled_at,
        allowed_next_statuses: [...allowedNextStatuses(o.status)],
      },
      customer: o.customer,
      items,
      financials: {
        currency: o.currency,
        subtotal_cents: o.subtotal,
        shipping_cents: o.shipping,
        total_cents: o.total,
        refunded_cents: o.refunded,
        refundable_cents: elig.refundable_cents,
      },
      refund_eligibility: elig,
      fulfillments: o.raw.fulfillments.map((f) => ({
        status: f.status,
        delivery_status: f.displayStatus,
        created_at: f.createdAt,
        delivered_at: f.deliveredAt,
        tracking: f.trackingInfo,
      })),
      refunds: refundRows(o),
    };
    return {
      data,
      summary: `Order ${o.name} - status: ${o.status}. Customer: ${o.customer ? `${o.customer.name} <${o.customer.email}>` : "none"}. Total ${money(o.total, o.currency)}; refunded ${money(o.refunded, o.currency)}; refundable ${money(elig.refundable_cents, o.currency)}. ${items.length} line item(s), ${data.fulfillments.length} fulfilment(s).`,
    };
  },
});

// ---- list_orders ----------------------------------------------------------

export const listOrders = defineShopifyTool({
  name: "list_orders",
  title: "List orders",
  kind: "read",
  description:
    "Search Shopify orders with filters (status, customer, placed date range, total range) and pagination, newest first. Scans at most 1000 matching orders; `scan_truncated` tells you if there were more. Dates are UTC.",
  input: z.strictObject({
    status: z.union([statusEnum, z.array(statusEnum).min(1)]).optional().describe('One status or a list, e.g. "paid" or ["paid","shipped"].'),
    customer_id: z.number().int().min(1).optional().describe("Customer id from search_customers."),
    placed_from: isoDateField.optional().describe("Placed on or after this date (YYYY-MM-DD)."),
    placed_to: isoDateField.optional().describe("Placed on or before this date (YYYY-MM-DD)."),
    min_total_cents: z.number().int().min(0).optional(),
    max_total_cents: z.number().int().min(0).optional(),
    sort: z.enum(["placed_at_desc", "placed_at_asc", "total_desc"]).default("placed_at_desc"),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    orders: z.array(z.object({ id: z.number().int(), name: z.string(), customer_id: z.number().int().nullable(), customer_name: z.string().nullable(), status: statusEnum, placed_at: z.string(), currency: z.string(), total_cents: z.number().int(), refunded_cents: z.number().int() })),
    total_count: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    next_offset: z.number().int().nullable(),
    scan_truncated: z.boolean().describe("True when more than 1000 orders matched the date/customer filter; counts cover only the newest 1000."),
  }),
  annotations: readOnlyAnnotations("List orders"),
  handler: async ({ store }, a) => {
    if (a.placed_from && a.placed_to && a.placed_from > a.placed_to) {
      throw new ValidationError("INVALID_DATE_RANGE", `placed_from (${a.placed_from}) is after placed_to (${a.placed_to}).`, { placed_from: a.placed_from, placed_to: a.placed_to });
    }
    if (a.min_total_cents !== undefined && a.max_total_cents !== undefined && a.min_total_cents > a.max_total_cents) {
      throw new ValidationError("INVALID_TOTAL_RANGE", "min_total_cents is greater than max_total_cents.", {});
    }
    const wanted = a.status === undefined ? null : new Set(Array.isArray(a.status) ? a.status : [a.status]);
    const { orders, truncated } = await store.listOrders({ placedFrom: a.placed_from, placedTo: a.placed_to, customerId: a.customer_id });
    const matched = orders.filter(
      (o) => (!wanted || wanted.has(o.status)) && (a.min_total_cents === undefined || o.total >= a.min_total_cents) && (a.max_total_cents === undefined || o.total <= a.max_total_cents),
    );
    matched.sort((x, y) =>
      a.sort === "total_desc" ? y.total - x.total || x.id - y.id : a.sort === "placed_at_asc" ? x.placed_at.localeCompare(y.placed_at) || x.id - y.id : y.placed_at.localeCompare(x.placed_at) || y.id - x.id,
    );
    const page = matched.slice(a.offset, a.offset + a.limit);
    const next = a.offset + a.limit < matched.length ? a.offset + a.limit : null;
    return {
      data: {
        orders: page.map((o) => ({ id: o.id, name: o.name, customer_id: o.customer?.id ?? null, customer_name: o.customer?.name ?? null, status: o.status, placed_at: o.placed_at, currency: o.currency, total_cents: o.total, refunded_cents: o.refunded })),
        total_count: matched.length,
        limit: a.limit,
        offset: a.offset,
        next_offset: next,
        scan_truncated: truncated,
      },
      summary: `${matched.length} matching order(s)${truncated ? " (scan capped at the newest 1000)" : ""}; showing ${page.length} from offset ${a.offset}.`,
    };
  },
});

// ---- search_customers -----------------------------------------------------

const MATCH_TYPES = ["exact_email", "exact_name", "partial", "fuzzy"] as const;

export const searchCustomers = defineShopifyTool({
  name: "search_customers",
  title: "Search customers",
  kind: "read",
  description:
    "Find Shopify customers by name or email. Returns contact details, order count and lifetime spend. If `ambiguous` is true, several customers fit equally well: ask the user which one they mean before acting.",
  input: z.strictObject({
    query: z.string().trim().min(2).max(100).describe("Name, email, or part of either."),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    query: z.string(),
    matches: z.array(z.object({ customer_id: z.number().int(), name: z.string(), email: z.string(), city: z.string(), region: z.string(), match_type: z.enum(MATCH_TYPES), score: z.number(), order_count: z.number().int(), lifetime_spend_cents: z.number().int(), currency: z.string(), last_order_at: z.string().nullable() })),
    ambiguous: z.boolean(),
    note: z.string().nullable(),
  }),
  annotations: readOnlyAnnotations("Search customers"),
  handler: async ({ store }, { query, limit }) => {
    const found = new Map<number, Awaited<ReturnType<ShopifyStore["searchCustomers"]>>[number]>();
    for (const c of await store.searchCustomers(query, limit)) found.set(c.id, c);
    if (found.size === 0) {
      for (const tok of normalizeText(query).split(" ").filter((t) => t.length >= 3).slice(0, 3)) {
        for (const c of await store.searchCustomers(tok, limit)) found.set(c.id, c);
      }
    }
    const q = normalizeText(query);
    const scored = [...found.values()]
      .map((c) => {
        const name = normalizeText(c.name);
        const email = normalizeText(c.email);
        let type: (typeof MATCH_TYPES)[number];
        let score: number;
        if (email === q) [type, score] = ["exact_email", 1];
        else if (name === q) [type, score] = ["exact_name", 0.98];
        else if (name.includes(q) || email.includes(q)) [type, score] = ["partial", 0.85];
        else [type, score] = ["fuzzy", Math.max(tokenSimilarity(query, c.name), similarity(q, name))];
        return { c, type, score: Math.round(score * 100) / 100 };
      })
      .filter((m) => m.score >= 0.72)
      .sort((x, y) => y.score - x.score || x.c.id - y.c.id)
      .slice(0, limit);
    const top = scored[0];
    const second = scored[1];
    const ambiguous = !!top && !!second && top.type !== "exact_email" && top.score - second.score < 0.05;
    return {
      data: {
        query,
        matches: scored.map(({ c, type, score }) => ({ customer_id: c.id, name: c.name, email: c.email, city: c.city, region: c.region, match_type: type, score, order_count: c.order_count, lifetime_spend_cents: c.spent, currency: c.currency, last_order_at: c.last_order_at })),
        ambiguous,
        note: ambiguous ? "Several customers match about equally well. Ask the user which one (email or city) before acting." : scored.length === 0 ? "No customer matched." : null,
      },
      summary: scored.length === 0 ? `No customers matched '${query}'.` : `${scored.length} match(es) for '${query}'${ambiguous ? " - AMBIGUOUS, confirm with the user" : ""}.`,
    };
  },
});

// ---- sales_report ---------------------------------------------------------

const GROUPINGS = ["day", "week", "month", "customer"] as const;
const bucket = z.object({ key: z.string(), label: z.string(), orders: z.number().int(), gross_cents: z.number().int(), refunds_cents: z.number().int(), net_cents: z.number().int() });

export const salesReport = defineShopifyTool({
  name: "sales_report",
  title: "Sales report",
  kind: "read",
  description:
    "Gross, refunds and net sales for orders placed between two dates, grouped by day, ISO week, month or customer. Excludes pending and cancelled orders. Based on order totals (incl. shipping). Dates are UTC; reads at most the newest 1000 orders in range.",
  input: z.strictObject({ from: isoDateField, to: isoDateField, group_by: z.enum(GROUPINGS).default("month") }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    group_by: z.enum(GROUPINGS),
    currency: z.string().nullable(),
    rows: z.array(bucket),
    totals: bucket.omit({ key: true, label: true }),
    scan_truncated: z.boolean(),
  }),
  annotations: readOnlyAnnotations("Sales report"),
  handler: async ({ store }, { from, to, group_by }) => {
    if (from > to) throw new ValidationError("INVALID_DATE_RANGE", `from (${from}) is after to (${to}).`, { from, to });
    const { orders, truncated } = await store.listOrders({ placedFrom: from, placedTo: to });
    const counted = orders.filter((o) => REVENUE_STATUSES.includes(o.status));
    const currencies = new Set(counted.map((o) => o.currency));
    if (currencies.size > 1) {
      throw new ConflictError("MIXED_CURRENCIES", `Orders in this range use several currencies (${[...currencies].join(", ")}); a single total would be wrong.`, { currencies: [...currencies] });
    }
    const currency = counted[0]?.currency ?? null;
    const buckets = new Map<string, z.infer<typeof bucket>>();
    for (const o of counted) {
      const date = o.placed_at.slice(0, 10);
      let key: string;
      let label: string;
      if (group_by === "day") [key, label] = [date, date];
      else if (group_by === "month") [key, label] = [date.slice(0, 7), date.slice(0, 7)];
      else if (group_by === "week") {
        const w = isoWeek(date);
        [key, label] = [w.key, `${w.key} (week of ${w.monday})`];
      } else [key, label] = [String(o.customer?.id ?? 0), o.customer ? `${o.customer.name} <${o.customer.email}>` : "(no customer)"];
      const b = buckets.get(key) ?? { key, label, orders: 0, gross_cents: 0, refunds_cents: 0, net_cents: 0 };
      b.orders += 1;
      b.gross_cents += o.total;
      b.refunds_cents += o.refunded;
      b.net_cents += o.total - o.refunded;
      buckets.set(key, b);
    }
    const rows = [...buckets.values()].sort((x, y) => (group_by === "customer" ? y.net_cents - x.net_cents || x.key.localeCompare(y.key) : x.key.localeCompare(y.key)));
    const totals = rows.reduce((t, r) => ({ orders: t.orders + r.orders, gross_cents: t.gross_cents + r.gross_cents, refunds_cents: t.refunds_cents + r.refunds_cents, net_cents: t.net_cents + r.net_cents }), { orders: 0, gross_cents: 0, refunds_cents: 0, net_cents: 0 });
    return {
      data: { from, to, group_by, currency, rows, totals, scan_truncated: truncated },
      summary: `${totals.orders} order(s) ${from}..${to}: gross ${money(totals.gross_cents, currency ?? "")}, refunds ${money(totals.refunds_cents, currency ?? "")}, net ${money(totals.net_cents, currency ?? "")}${truncated ? " (newest 1000 orders only)" : ""}.`,
    };
  },
});

// ---- update_order_status --------------------------------------------------

function transitionHint(from: OrderStatus, to: OrderStatus): string | null {
  if (to === "refunded") return "Use issue_refund instead; an order becomes 'refunded' once refunds reach its total.";
  if (to === "cancelled" && from !== "pending") return "Only unpaid (pending) orders can be cancelled. For a paid order, issue a refund instead.";
  if (from === "pending" && (to === "shipped" || to === "delivered")) return "The order has not been paid. Only mark it 'paid' once payment has actually been received; never skip steps.";
  return null;
}

export const updateOrderStatus = defineShopifyTool({
  name: "update_order_status",
  title: "Update order status",
  kind: "write",
  description:
    "Move a Shopify order through its lifecycle: pending->paid (marks a manual payment received) | cancelled (no refund, restocks, no customer email); paid->shipped (creates a fulfilment for all open items, no customer email); shipped->delivered (records a delivered event). Other transitions are rejected (CONFLICT). 'refunded' is never set directly. Disabled unless the server was started with writes enabled.",
  input: z.strictObject({
    order_id: orderIdField,
    status: statusEnum.describe("Target status."),
    note: z.string().trim().max(500).optional().describe("Optional context for the audit log."),
  }),
  output: z.object({
    order_id: z.number().int(),
    previous_status: statusEnum,
    requested_status: statusEnum,
    status: statusEnum.describe("Status read back from Shopify after the change."),
    changed: z.boolean(),
    pending_confirmation: z.boolean().describe("True when Shopify accepted the change but it has not shown up yet (e.g. cancellation runs as a background job); re-check with get_order."),
    allowed_next_statuses: z.array(statusEnum),
  }),
  annotations: writeAnnotations("Update order status", { destructive: true, idempotent: true }),
  handler: async (ctx, { order_id, status, note }) => {
    requireWrites(ctx, "update_order_status");
    const order = await ctx.store.getOrder(order_id);
    const allowed = [...allowedNextStatuses(order.status)];
    if (order.status === status) {
      return {
        data: { order_id, previous_status: order.status, requested_status: status, status, changed: false, pending_confirmation: false, allowed_next_statuses: allowed },
        summary: `Order ${order_id} is already '${status}'. Nothing changed.`,
      };
    }
    if (!canTransition(order.status, status)) {
      throw new ConflictError(
        "INVALID_STATUS_TRANSITION",
        `Cannot move order ${order_id} from '${order.status}' to '${status}'. ${allowed.length ? `Allowed next: ${allowed.join(", ")}.` : "This status is final."}${transitionHint(order.status, status) ? ` ${transitionHint(order.status, status)}` : ""}`,
        { order_id, from: order.status, to: status, allowed_next_statuses: allowed },
      );
    }
    if (order.status === "pending" && status === "paid") await ctx.store.markPaid(order);
    else if (order.status === "pending" && status === "cancelled") await ctx.store.cancel(order);
    else if (order.status === "paid" && status === "shipped") await ctx.store.fulfill(order);
    else if (order.status === "shipped" && status === "delivered") await ctx.store.markDelivered(order);
    audit(ctx, "order.status_change_requested", order_id, { from: order.status, to: status, note: note ?? null });

    const after = await ctx.store.getOrder(order_id);
    const confirmed = after.status === status;
    return {
      data: { order_id, previous_status: order.status, requested_status: status, status: after.status, changed: confirmed, pending_confirmation: !confirmed, allowed_next_statuses: [...allowedNextStatuses(after.status)] },
      summary: confirmed
        ? `Order ${order_id}: ${order.status} -> ${after.status}.`
        : `Shopify accepted the change to '${status}' for order ${order_id}, but it still reads '${after.status}'. It may still be processing; re-check with get_order before telling the user it is done.`,
    };
  },
});

// ---- issue_refund ---------------------------------------------------------

export const issueRefund = defineShopifyTool({
  name: "issue_refund",
  title: "Issue refund",
  kind: "write",
  description:
    "Refund money on a paid Shopify order (amount-only refund against the original payment; it does not restock items and does not email the customer). Guardrails: amount must be > 0, within the remaining refundable amount, and under the server's per-refund cap; unpaid, cancelled and fully-refunded orders are refused; reason and idempotency_key are required, and repeating a key replays the original refund instead of paying twice. Disabled unless the server was started with writes enabled.",
  input: z.strictObject({
    order_id: orderIdField,
    amount_cents: z.number().int().positive().describe("Refund amount in the currency's minor units (1050 = 10.50 for USD). Must not exceed financials.refundable_cents from get_order."),
    reason: z.string().trim().min(3).max(500),
    idempotency_key: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, "Use letters, digits, '.', '_', ':' or '-' only.").describe("Unique key for THIS refund, e.g. 'refund-1042-late-delivery'. Reuse only to retry the same refund."),
  }),
  output: z.object({
    refund: z.object({ id: z.number().int(), order_id: z.number().int(), amount_cents: z.number().int(), reason: z.string(), idempotency_key: z.string(), created_at: z.string() }),
    replayed: z.boolean(),
    order: z.object({ id: z.number().int(), status: statusEnum, currency: z.string(), total_cents: z.number().int(), refunded_cents: z.number().int(), refundable_cents: z.number().int() }),
  }),
  annotations: writeAnnotations("Issue refund", { destructive: true, idempotent: true }),
  handler: async (ctx, { order_id, amount_cents, reason, idempotency_key }) => {
    requireWrites(ctx, "issue_refund");
    const order = await ctx.store.getOrder(order_id);
    const marker = REFUND_MARKER(idempotency_key);
    const orderView = (o: ShopifyOrder) => ({ id: o.id, status: o.status, currency: o.currency, total_cents: o.total, refunded_cents: o.refunded, refundable_cents: refundEligibilityFor(o).refundable_cents });

    const prior = order.raw.refunds.find((r) => r.note?.includes(marker));
    if (prior) {
      const priorAmount = decimalToMinor(prior.totalRefundedSet.shopMoney.amount, order.currency);
      if (priorAmount !== amount_cents) {
        throw new ConflictError("IDEMPOTENCY_KEY_REUSED", `Idempotency key '${idempotency_key}' was already used for a different refund (${money(priorAmount, order.currency)} on order ${order_id}). Use a new key for a new refund.`, { idempotency_key, existing_refund_id: gidToNumber(prior.id), existing_amount_cents: priorAmount });
      }
      return {
        data: { refund: { id: gidToNumber(prior.id), order_id, amount_cents: priorAmount, reason, idempotency_key, created_at: prior.createdAt }, replayed: true, order: orderView(order) },
        summary: `Replayed: refund ${gidToNumber(prior.id)} (${money(priorAmount, order.currency)}) already exists for key '${idempotency_key}'. No new money was refunded.`,
      };
    }

    const elig = refundEligibilityFor(order);
    const facts = { order_id, status: order.status, currency: order.currency, total_cents: order.total, already_refunded_cents: order.refunded, refundable_cents: elig.refundable_cents, requested_cents: amount_cents };
    if (!elig.eligible) {
      throw new GuardrailViolation(order.refunded >= order.total && order.total > 0 ? "ORDER_FULLY_REFUNDED" : "ORDER_NOT_REFUNDABLE", `Order ${order_id} cannot be refunded: ${elig.reason}`, facts);
    }
    if (amount_cents > elig.refundable_cents) {
      throw new GuardrailViolation("REFUND_EXCEEDS_REFUNDABLE", `Requested ${money(amount_cents, order.currency)} exceeds the refundable amount ${money(elig.refundable_cents, order.currency)} on order ${order_id} (total ${money(order.total, order.currency)}, already refunded ${money(order.refunded, order.currency)}). No refund was issued.`, facts);
    }
    if (amount_cents > ctx.settings.maxRefundMinor) {
      throw new GuardrailViolation("REFUND_OVER_CAP", `Requested ${money(amount_cents, order.currency)} is over this server's per-refund cap of ${money(ctx.settings.maxRefundMinor, order.currency)}. Ask the store owner to process it in Shopify or raise SHOPKEEPER_MAX_REFUND_MINOR.`, { ...facts, cap_cents: ctx.settings.maxRefundMinor });
    }

    const created = await ctx.store.refund(order, amount_cents, reason, idempotency_key);
    audit(ctx, "refund.issued", order_id, { refund: created.id, amount_cents, reason, idempotency_key });
    const after = await ctx.store.getOrder(order_id);
    return {
      data: { refund: { id: gidToNumber(created.id), order_id, amount_cents, reason, idempotency_key, created_at: created.createdAt }, replayed: false, order: orderView(after) },
      summary: `Refunded ${money(amount_cents, order.currency)} on order ${order_id}. Refunded so far ${money(after.refunded, order.currency)} of ${money(after.total, order.currency)}; ${money(refundEligibilityFor(after).refundable_cents, order.currency)} still refundable.`,
    };
  },
});

export const SHOPIFY_TOOLS = [searchCustomers, getOrder, listOrders, salesReport, updateOrderStatus, issueRefund] as unknown as readonly ShopifyToolSpec[];
