import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueRefund, salesReport } from "../src/tools/index.js";
import { isoWeek } from "../src/tools/sales-report.js";
import { call, expectShopError, freshDb, type TestDb } from "./helpers.js";

/** Independent SQL reference: net sales per month for revenue-bearing orders. */
function monthlyNetFromSql(t: TestDb, from: string, to: string): Record<string, { gross: number; refunds: number; net: number }> {
  const rows = t.db
    .prepare(
      `SELECT substr(o.placed_at,1,7) AS m,
              SUM(o.total_cents) AS gross,
              SUM(COALESCE((SELECT SUM(amount_cents) FROM refunds r WHERE r.order_id = o.id),0)) AS refunds
         FROM orders o
        WHERE o.status IN ('paid','shipped','delivered','refunded')
          AND substr(o.placed_at,1,10) BETWEEN ? AND ?
        GROUP BY m ORDER BY m`,
    )
    .all(from, to) as Array<{ m: string; gross: number; refunds: number }>;
  return Object.fromEntries(rows.map((r) => [r.m, { gross: r.gross, refunds: r.refunds, net: r.gross - r.refunds }]));
}

describe("sales_report", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("groups Q2 by month and matches an independent SQL computation", () => {
    const { data, summary } = call(salesReport, t.ctx, { from: "2026-04-01", to: "2026-06-30", group_by: "month" });
    const ref = monthlyNetFromSql(t, "2026-04-01", "2026-06-30");
    expect(data.rows.map((r) => r.key)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(data.rows.map((r) => r.label)).toEqual(["April 2026", "May 2026", "June 2026"]);
    for (const r of data.rows) {
      expect({ gross: r.gross_cents, refunds: r.refunds_cents, net: r.net_cents }).toEqual(ref[r.key]);
    }
    expect(data.totals.net_cents).toBe(data.totals.gross_cents - data.totals.refunds_cents);
    expect(data.basis).toBe("order_totals");
    expect(summary).toMatch(/April 2026: net \$/);
  });

  it("nets out new refunds immediately", () => {
    const before = call(salesReport, t.ctx, { from: "2026-03-01", to: "2026-03-31" }).data.totals.net_cents;
    call(issueRefund, t.ctx, { order_id: 1042, amount_cents: 10_500, reason: "late", idempotency_key: "refund-1042-test" });
    const after = call(salesReport, t.ctx, { from: "2026-03-01", to: "2026-03-31" }).data.totals.net_cents;
    expect(before - after).toBe(10_500);
  });

  it("excludes pending and cancelled orders", () => {
    const { data } = call(salesReport, t.ctx, { from: "2026-09-01", to: "2026-09-30", group_by: "day" });
    const excluded = t.db
      .prepare("SELECT id FROM orders WHERE status IN ('pending','cancelled') AND placed_at >= '2026-09-01'")
      .all() as Array<{ id: number }>;
    expect(excluded.length).toBeGreaterThan(0);
    const counted = t.db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','shipped','delivered','refunded') AND placed_at >= '2026-09-01'")
      .get() as { n: number };
    expect(data.totals.orders).toBe(counted.n);
  });

  it("product view uses line revenue (no shipping) and allocates refunds without losing or inventing cents", () => {
    const from = "2026-02-01";
    const to = "2026-09-30";
    const product = call(salesReport, t.ctx, { from, to, group_by: "product" }).data;
    const lineRevenue = t.db
      .prepare(
        `SELECT SUM(i.quantity * i.unit_price_cents) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE o.status IN ('paid','shipped','delivered','refunded')`,
      )
      .get() as { n: number };
    expect(product.basis).toBe("line_items");
    expect(product.totals.gross_cents).toBe(lineRevenue.n);
    const byOrder = call(salesReport, t.ctx, { from, to, group_by: "month" }).data;
    expect(product.totals.refunds_cents).toBeLessThanOrEqual(byOrder.totals.refunds_cents);
    expect(product.rows.every((r) => r.net_cents === r.gross_cents - r.refunds_cents)).toBe(true);
    // Sorted by net, descending.
    expect(product.rows.map((r) => r.net_cents)).toEqual([...product.rows.map((r) => r.net_cents)].sort((a, b) => b - a));
  });

  it("customer and week groupings reconcile with the month grouping", () => {
    const args = { from: "2026-04-01", to: "2026-06-30" };
    const month = call(salesReport, t.ctx, { ...args, group_by: "month" }).data.totals;
    const customer = call(salesReport, t.ctx, { ...args, group_by: "customer" }).data.totals;
    const week = call(salesReport, t.ctx, { ...args, group_by: "week" }).data;
    expect(customer).toEqual(month);
    expect(week.totals).toEqual(month);
    expect(week.rows.every((r) => /^2026-W\d{2}$/.test(r.key))).toBe(true);
  });

  it("computes ISO weeks correctly at year boundaries", () => {
    expect(isoWeek("2026-01-01")).toEqual({ key: "2026-W01", monday: "2025-12-29" });
    expect(isoWeek("2026-03-30")).toEqual({ key: "2026-W14", monday: "2026-03-30" });
    expect(isoWeek("2027-01-01").key).toBe("2026-W53");
  });

  it("VALIDATION: inverted range and bad dates", () => {
    expectShopError(() => call(salesReport, t.ctx, { from: "2026-07-01", to: "2026-06-01" }), "VALIDATION_ERROR", "INVALID_DATE_RANGE");
    expectShopError(() => call(salesReport, t.ctx, { from: "2026-13-01", to: "2026-12-31" }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(salesReport, t.ctx, { from: "2026-01-01", to: "2026-02-01", group_by: "year" }), "VALIDATION_ERROR", "INVALID_INPUT");
  });
});
