import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { listOrders } from "../src/tools/index.js";
import { call, count, expectShopError, freshDb, type TestDb } from "./helpers.js";

describe("list_orders", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("paginates without gaps or overlaps", () => {
    const seen: number[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page: { orders: Array<{ id: number }>; total_count: number; next_offset: number | null } = call(listOrders, t.ctx, {
        limit: 30,
        offset,
        sort: "placed_at_asc",
      }).data;
      expect(page.total_count).toBe(200);
      seen.push(...page.orders.map((o) => o.id));
      offset = page.next_offset;
      pages++;
    }
    expect(pages).toBe(7);
    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
    expect(seen[0]).toBe(1001);
    expect(seen.at(-1)).toBe(1200);
  });

  it("defaults to newest first, 20 per page", () => {
    const { data } = call(listOrders, t.ctx, {});
    expect(data.orders).toHaveLength(20);
    expect(data.orders[0]?.id).toBe(1200);
    expect(data.next_offset).toBe(20);
  });

  it("filters by a single status or a list of statuses", () => {
    const paid = call(listOrders, t.ctx, { status: "paid" }).data;
    expect(paid.orders.map((o) => o.id).sort()).toEqual([FIXTURES.awaitingShipment, FIXTURES.paidNotShipped, FIXTURES.paidUninvoiced]);
    const both = call(listOrders, t.ctx, { status: ["pending", "paid"], limit: 100 }).data;
    expect(both.total_count).toBe(count(t.db, "SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','paid')"));
    expect(both.orders.every((o) => o.status === "pending" || o.status === "paid")).toBe(true);
  });

  it("filters by customer", () => {
    const { data } = call(listOrders, t.ctx, { customer_id: FIXTURES.priyaDenver.customerId });
    expect(data.total_count).toBe(FIXTURES.priyaDenver.orderCount);
    expect(new Set(data.orders.map((o) => o.customer_id))).toEqual(new Set([FIXTURES.priyaDenver.customerId]));
  });

  it("filters by inclusive placed-date range and total range", () => {
    const { data } = call(listOrders, t.ctx, { placed_from: "2026-04-01", placed_to: "2026-04-30", limit: 100 });
    expect(data.total_count).toBe(count(t.db, "SELECT COUNT(*) AS n FROM orders WHERE placed_at >= '2026-04-01' AND placed_at < '2026-05-01'"));
    expect(data.orders.every((o) => o.placed_at.startsWith("2026-04"))).toBe(true);

    const big = call(listOrders, t.ctx, { min_total_cents: 20_000, max_total_cents: 30_000, limit: 100 }).data;
    expect(big.orders.length).toBeGreaterThan(0);
    expect(big.orders.every((o) => o.total_cents >= 20_000 && o.total_cents <= 30_000)).toBe(true);
  });

  it("late_only returns late deliveries and overdue unshipped orders, with timing per row", () => {
    const aug = call(listOrders, t.ctx, { late_only: true, placed_from: "2026-08-01", placed_to: "2026-08-31", limit: 100 }).data;
    const expected = (
      t.db
        .prepare(
          `SELECT id FROM orders WHERE placed_at >= '2026-08-01' AND placed_at < '2026-09-01'
              AND delivered_at IS NOT NULL AND substr(delivered_at,1,10) > promised_delivery_date ORDER BY id`,
        )
        .all() as Array<{ id: number }>
    ).map((r) => r.id);
    expect(aug.orders.map((o) => o.id).sort()).toEqual(expected);
    expect(aug.orders.every((o) => o.delivery_status === "delivered_late" && o.days_late > 0)).toBe(true);

    const all = call(listOrders, t.ctx, { late_only: true, limit: 100 }).data;
    const overdue = all.orders.filter((o) => o.delivery_status === "overdue").map((o) => o.id).sort();
    expect(overdue).toEqual([FIXTURES.awaitingShipment, FIXTURES.paidNotShipped, FIXTURES.paidUninvoiced]);
  });

  it("includes refunded amounts per row", () => {
    const { data } = call(listOrders, t.ctx, { status: "refunded", limit: 100 });
    expect(data.orders.every((o) => o.refunded_cents === o.total_cents)).toBe(true);
  });

  it("VALIDATION: inverted ranges, bad dates and out-of-range page sizes", () => {
    expectShopError(() => call(listOrders, t.ctx, { placed_from: "2026-05-01", placed_to: "2026-04-01" }), "VALIDATION_ERROR", "INVALID_DATE_RANGE");
    expectShopError(() => call(listOrders, t.ctx, { min_total_cents: 500, max_total_cents: 100 }), "VALIDATION_ERROR", "INVALID_AMOUNT_RANGE");
    expectShopError(() => call(listOrders, t.ctx, { placed_from: "2026-02-30" }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(listOrders, t.ctx, { placed_from: "04/01/2026" }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(listOrders, t.ctx, { limit: 500 }), "VALIDATION_ERROR", "INVALID_INPUT");
  });

  it("NOT_FOUND: unknown customer instead of a silently empty list", () => {
    expectShopError(() => call(listOrders, t.ctx, { customer_id: 999 }), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
  });
});
