import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { isoDate } from "../clock.js";
import { ORDER_STATUSES, type OrderStatus } from "../db/schema.js";
import { DELIVERY_STATUSES, deliveryInfo, type OrderRecord } from "../domain/orders.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { formatCents } from "../money.js";
import { defineTool, isoDateField, readOnlyAnnotations } from "./types.js";

const statusEnum = z.enum(ORDER_STATUSES);

const input = z.strictObject({
  status: z
    .union([statusEnum, z.array(statusEnum).min(1)])
    .optional()
    .describe('Only orders in this status or any of these statuses, e.g. "paid" or ["paid","shipped"].'),
  customer_id: z.number().int().min(1).optional().describe("Only orders for this customer (see search_customers)."),
  placed_from: isoDateField.optional().describe("Placed on or after this date (YYYY-MM-DD, inclusive)."),
  placed_to: isoDateField.optional().describe("Placed on or before this date (YYYY-MM-DD, inclusive)."),
  min_total_cents: z.number().int().min(0).optional().describe("Order total >= this many cents."),
  max_total_cents: z.number().int().min(0).optional().describe("Order total <= this many cents."),
  late_only: z
    .boolean()
    .default(false)
    .describe(
      "Only late orders: delivered after the promised date, or paid/shipped and already past it (overdue). Check each row's delivery_status to tell them apart.",
    ),
  sort: z.enum(["placed_at_desc", "placed_at_asc", "total_desc"]).default("placed_at_desc"),
  limit: z.number().int().min(1).max(100).default(20).describe("Page size, 1-100 (default 20)."),
  offset: z.number().int().min(0).default(0).describe("Rows to skip; use next_offset from the previous page."),
});

const row = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  customer_name: z.string(),
  status: statusEnum,
  placed_at: z.string(),
  total_cents: z.number().int(),
  refunded_cents: z.number().int(),
  delivery_status: z.enum(DELIVERY_STATUSES),
  promised_date: z.string(),
  delivered_date: z.string().nullable(),
  days_late: z.number().int(),
});

const output = z.object({
  orders: z.array(row),
  total_count: z.number().int().describe("Rows matching the filters across all pages."),
  limit: z.number().int(),
  offset: z.number().int(),
  next_offset: z.number().int().nullable().describe("Pass as offset to fetch the next page; null on the last page."),
});

const SORT_SQL = {
  placed_at_desc: "o.placed_at DESC, o.id DESC",
  placed_at_asc: "o.placed_at ASC, o.id ASC",
  total_desc: "o.total_cents DESC, o.id ASC",
} as const;

export const listOrders = defineTool({
  name: "list_orders",
  title: "List orders",
  kind: "read",
  description:
    "Search orders with filters (status, customer, placed date range, total range, late-only) and pagination. Each row includes total, amount refunded, and delivery timing (promised vs delivered date, days late).",
  input,
  output,
  annotations: readOnlyAnnotations("List orders"),
  handler: ({ db, clock }, args) => {
    if (args.placed_from && args.placed_to && args.placed_from > args.placed_to) {
      throw new ValidationError("INVALID_DATE_RANGE", `placed_from (${args.placed_from}) is after placed_to (${args.placed_to}).`, {
        placed_from: args.placed_from,
        placed_to: args.placed_to,
      });
    }
    if (args.min_total_cents !== undefined && args.max_total_cents !== undefined && args.min_total_cents > args.max_total_cents) {
      throw new ValidationError("INVALID_AMOUNT_RANGE", "min_total_cents is greater than max_total_cents.", {
        min_total_cents: args.min_total_cents,
        max_total_cents: args.max_total_cents,
      });
    }
    if (args.customer_id !== undefined && !db.prepare("SELECT 1 FROM customers WHERE id = ?").get(args.customer_id)) {
      throw new NotFoundError("CUSTOMER_NOT_FOUND", `Customer ${args.customer_id} does not exist.`, {
        customer_id: args.customer_id,
      });
    }

    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const statuses: OrderStatus[] | undefined =
      args.status === undefined ? undefined : Array.isArray(args.status) ? args.status : [args.status];
    if (statuses) {
      where.push(`o.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (args.customer_id !== undefined) {
      where.push("o.customer_id = ?");
      params.push(args.customer_id);
    }
    if (args.placed_from) {
      where.push("substr(o.placed_at, 1, 10) >= ?");
      params.push(args.placed_from);
    }
    if (args.placed_to) {
      where.push("substr(o.placed_at, 1, 10) <= ?");
      params.push(args.placed_to);
    }
    if (args.min_total_cents !== undefined) {
      where.push("o.total_cents >= ?");
      params.push(args.min_total_cents);
    }
    if (args.max_total_cents !== undefined) {
      where.push("o.total_cents <= ?");
      params.push(args.max_total_cents);
    }
    if (args.late_only) {
      // Same rule as deliveryInfo(): delivered after promise, or paid/shipped and past it today.
      where.push(`(
        (o.delivered_at IS NOT NULL AND substr(o.delivered_at, 1, 10) > o.promised_delivery_date AND o.status <> 'cancelled')
        OR (o.delivered_at IS NULL AND o.status IN ('paid', 'shipped') AND o.promised_delivery_date < ?)
      )`);
      params.push(isoDate(clock()));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT o.*, c.name AS customer_name,
                COALESCE((SELECT SUM(amount_cents) FROM refunds r WHERE r.order_id = o.id), 0) AS refunded_cents
           FROM orders o JOIN customers c ON c.id = o.customer_id
           ${whereSql}
          ORDER BY ${SORT_SQL[args.sort]}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, args.limit, args.offset) as unknown as Array<OrderRecord & { customer_name: string; refunded_cents: number }>;

    const now = clock();
    const orders = rows.map((o) => {
      const d = deliveryInfo(o, now);
      return {
        id: o.id,
        customer_id: o.customer_id,
        customer_name: o.customer_name,
        status: o.status,
        placed_at: o.placed_at,
        total_cents: o.total_cents,
        refunded_cents: o.refunded_cents,
        delivery_status: d.status,
        promised_date: d.promised_date,
        delivered_date: d.delivered_date,
        days_late: d.days_late,
      };
    });
    const nextOffset = args.offset + orders.length < total ? args.offset + orders.length : null;

    const header =
      total === 0
        ? "No orders match these filters."
        : `${total} order(s) match; showing ${args.offset + 1}-${args.offset + orders.length}${nextOffset !== null ? ` (next_offset ${nextOffset})` : ""}.`;
    const lines = orders.map(
      (o) =>
        `- #${o.id} ${o.placed_at.slice(0, 10)} ${o.status} ${formatCents(o.total_cents)} ${o.customer_name}` +
        (o.days_late > 0 ? ` [${o.delivery_status}, ${o.days_late}d late]` : ""),
    );
    return {
      data: { orders, total_count: total, limit: args.limit, offset: args.offset, next_offset: nextOffset },
      summary: [header, ...lines].join("\n"),
    };
  },
});
