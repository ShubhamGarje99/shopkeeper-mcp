import { z } from "zod";
import { REVENUE_STATUSES } from "../domain/status-machine.js";
import { ValidationError } from "../errors.js";
import { allocateProRata, formatCents } from "../money.js";
import { defineTool, isoDateField, readOnlyAnnotations } from "./types.js";

const GROUPINGS = ["day", "week", "month", "product", "customer"] as const;
type Grouping = (typeof GROUPINGS)[number];

const input = z.strictObject({
  from: isoDateField.describe("First day included (YYYY-MM-DD, by order placed date)."),
  to: isoDateField.describe("Last day included (YYYY-MM-DD)."),
  group_by: z.enum(GROUPINGS).default("month").describe("day | week (ISO, Monday start) | month | product | customer"),
});

const bucket = z.object({
  key: z.string(),
  label: z.string(),
  orders: z.number().int(),
  units: z.number().int(),
  gross_cents: z.number().int(),
  refunds_cents: z.number().int(),
  net_cents: z.number().int(),
});

const output = z.object({
  from: z.string(),
  to: z.string(),
  group_by: z.enum(GROUPINGS),
  basis: z
    .enum(["order_totals", "line_items"])
    .describe(
      "order_totals: gross = order totals incl. shipping. line_items (product view): gross = item revenue excl. shipping, refunds allocated pro-rata.",
    ),
  rows: z.array(bucket),
  totals: bucket.omit({ key: true, label: true }),
});

interface SaleOrder {
  id: number;
  customer_id: number;
  placed_at: string;
  total_cents: number;
  customer_name: string;
  customer_email: string;
  refunded_cents: number;
}

interface SaleItem {
  order_id: number;
  product_id: number;
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** ISO-8601 week key ("2026-W14") and its Monday ("2026-03-30"). */
export function isoWeek(date: string): { key: string; monday: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayNum);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dayNum + 3);
  const weekYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { key: `${weekYear}-W${String(week).padStart(2, "0")}`, monday: monday.toISOString().slice(0, 10) };
}

function timeKey(placedAt: string, g: Grouping): { key: string; label: string } {
  const date = placedAt.slice(0, 10);
  if (g === "day") return { key: date, label: date };
  if (g === "week") {
    const w = isoWeek(date);
    return { key: w.key, label: `Week of ${w.monday}` };
  }
  const month = Number(date.slice(5, 7));
  return { key: date.slice(0, 7), label: `${MONTHS[month - 1] ?? date.slice(5, 7)} ${date.slice(0, 4)}` };
}

type Acc = { key: string; label: string; orders: Set<number>; units: number; gross: number; refunds: number };

export const salesReport = defineTool({
  name: "sales_report",
  title: "Sales report",
  kind: "read",
  description:
    "Sales for a date range (by order placed date), grouped by day, ISO week, month, product, or customer. Reports gross, refunds and net (gross minus refunds issued against those orders), all in cents. Pending and cancelled orders are excluded because no money was captured.",
  input,
  output,
  annotations: readOnlyAnnotations("Sales report"),
  handler: ({ db }, { from, to, group_by }) => {
    if (from > to) {
      throw new ValidationError("INVALID_DATE_RANGE", `'from' (${from}) is after 'to' (${to}).`, { from, to });
    }
    const statusSql = REVENUE_STATUSES.map((s) => `'${s}'`).join(",");
    const orders = db
      .prepare(
        `SELECT o.id, o.customer_id, o.placed_at, o.total_cents, c.name AS customer_name, c.email AS customer_email,
                COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id = o.id), 0) AS refunded_cents
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.status IN (${statusSql}) AND substr(o.placed_at, 1, 10) BETWEEN ? AND ?
          ORDER BY o.id`,
      )
      .all(from, to) as unknown as SaleOrder[];
    const items = db
      .prepare(
        `SELECT i.order_id, i.product_id, p.sku, p.name, i.quantity, i.unit_price_cents
           FROM order_items i JOIN products p ON p.id = i.product_id
           JOIN orders o ON o.id = i.order_id
          WHERE o.status IN (${statusSql}) AND substr(o.placed_at, 1, 10) BETWEEN ? AND ?
          ORDER BY i.order_id, i.id`,
      )
      .all(from, to) as unknown as SaleItem[];
    const itemsByOrder = new Map<number, SaleItem[]>();
    for (const it of items) {
      const list = itemsByOrder.get(it.order_id) ?? [];
      list.push(it);
      itemsByOrder.set(it.order_id, list);
    }

    const acc = new Map<string, Acc>();
    const bump = (key: string, label: string, orderId: number, units: number, gross: number, refunds: number) => {
      const a = acc.get(key) ?? { key, label, orders: new Set<number>(), units: 0, gross: 0, refunds: 0 };
      a.orders.add(orderId);
      a.units += units;
      a.gross += gross;
      a.refunds += refunds;
      acc.set(key, a);
    };

    for (const o of orders) {
      const lines = itemsByOrder.get(o.id) ?? [];
      const units = lines.reduce((n, l) => n + l.quantity, 0);
      if (group_by === "product") {
        // Allocate the order's refunds across line items and shipping by value; the
        // shipping share is not product revenue, so it is dropped from this view.
        const lineValues = lines.map((l) => l.quantity * l.unit_price_cents);
        const shippingValue = o.total_cents - lineValues.reduce((a, b) => a + b, 0);
        const shares = allocateProRata(o.refunded_cents, [...lineValues, shippingValue]);
        lines.forEach((l, i) => bump(l.sku, l.name, o.id, l.quantity, lineValues[i] ?? 0, shares[i] ?? 0));
      } else if (group_by === "customer") {
        bump(String(o.customer_id), `${o.customer_name} <${o.customer_email}>`, o.id, units, o.total_cents, o.refunded_cents);
      } else {
        const { key, label } = timeKey(o.placed_at, group_by);
        bump(key, label, o.id, units, o.total_cents, o.refunded_cents);
      }
    }

    const rows = [...acc.values()]
      .map((a) => ({
        key: a.key,
        label: a.label,
        orders: a.orders.size,
        units: a.units,
        gross_cents: a.gross,
        refunds_cents: a.refunds,
        net_cents: a.gross - a.refunds,
      }))
      .sort((a, b) =>
        group_by === "product" || group_by === "customer"
          ? b.net_cents - a.net_cents || a.key.localeCompare(b.key)
          : a.key.localeCompare(b.key),
      );

    const totals = {
      orders: new Set(orders.map((o) => o.id)).size,
      units: rows.reduce((n, r) => n + r.units, 0),
      gross_cents: rows.reduce((n, r) => n + r.gross_cents, 0),
      refunds_cents: rows.reduce((n, r) => n + r.refunds_cents, 0),
      net_cents: rows.reduce((n, r) => n + r.net_cents, 0),
    };

    const basis = group_by === "product" ? ("line_items" as const) : ("order_totals" as const);
    const shown = rows.slice(0, 31);
    const summary = [
      `Sales ${from} to ${to} by ${group_by}: net ${formatCents(totals.net_cents)} = gross ${formatCents(totals.gross_cents)} - refunds ${formatCents(totals.refunds_cents)} across ${totals.orders} order(s).`,
      ...shown.map(
        (r) =>
          `- ${r.label}: net ${formatCents(r.net_cents)} (gross ${formatCents(r.gross_cents)}, refunds ${formatCents(r.refunds_cents)}, ${r.orders} orders)`,
      ),
      ...(rows.length > shown.length ? [`...and ${rows.length - shown.length} more rows in the structured result.`] : []),
    ].join("\n");

    return { data: { from, to, group_by, basis, rows, totals }, summary };
  },
});
