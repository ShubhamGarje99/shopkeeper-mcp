import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededDatabase, type Db } from "../src/db/connection.js";
import { ALL_TABLES } from "../src/db/schema.js";
import { FIXTURES } from "../src/db/seed.js";
import { count, freshDb, type TestDb } from "./helpers.js";

function dumpHash(db: Db): string {
  const h = crypto.createHash("sha256");
  for (const table of ALL_TABLES) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) h.update(JSON.stringify(row));
  }
  return h.digest("hex");
}

describe("seed", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("is deterministic (byte-identical across runs)", () => {
    const other = createSeededDatabase(":memory:");
    expect(dumpHash(other)).toBe(dumpHash(t.db));
    other.close();
  });

  it("has the documented volumes and order ID range", () => {
    expect(count(t.db, "SELECT COUNT(*) AS n FROM customers")).toBe(40);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM products")).toBe(30);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM orders")).toBe(200);
    const range = t.db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM orders").get() as { lo: number; hi: number };
    expect(range).toEqual({ lo: 1001, hi: 1200 });
    expect(count(t.db, "SELECT COUNT(*) AS n FROM audit_log")).toBe(0);
  });

  it("uses only example.com emails", () => {
    expect(count(t.db, "SELECT COUNT(*) AS n FROM customers WHERE email NOT LIKE '%@example.com'")).toBe(0);
  });

  it("covers every order status", () => {
    const statuses = (t.db.prepare("SELECT DISTINCT status FROM orders").all() as Array<{ status: string }>).map((r) => r.status);
    expect(statuses.sort()).toEqual(["cancelled", "delivered", "paid", "pending", "refunded", "shipped"]);
  });

  it("keeps money invariants: totals add up and refunds never exceed totals", () => {
    expect(count(t.db, "SELECT COUNT(*) AS n FROM orders WHERE total_cents <> subtotal_cents + shipping_cents")).toBe(0);
    expect(
      count(
        t.db,
        `SELECT COUNT(*) AS n FROM orders o
          WHERE o.subtotal_cents <> (SELECT SUM(quantity * unit_price_cents) FROM order_items WHERE order_id = o.id)`,
      ),
    ).toBe(0);
    expect(
      count(
        t.db,
        `SELECT COUNT(*) AS n FROM orders o
          WHERE (SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE order_id = o.id) > o.total_cents`,
      ),
    ).toBe(0);
    // A 'refunded' order is refunded in full; partially refunded orders keep their status.
    expect(
      count(
        t.db,
        `SELECT COUNT(*) AS n FROM orders o WHERE status = 'refunded'
            AND (SELECT SUM(amount_cents) FROM refunds WHERE order_id = o.id) <> o.total_cents`,
      ),
    ).toBe(0);
  });

  it("contains each eval fixture", () => {
    const order = (id: number) =>
      t.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Record<string, string | number | null>;
    const refunds = (id: number) => count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE order_id = ?", id);

    const late = order(FIXTURES.lateDelivery);
    expect(late.status).toBe("delivered");
    expect(String(late.delivered_at).slice(0, 10) > String(late.promised_delivery_date)).toBe(true);
    expect(refunds(FIXTURES.lateDelivery)).toBe(0);

    const onTime = order(FIXTURES.onTimeDelivery);
    expect(String(onTime.delivered_at).slice(0, 10) <= String(onTime.promised_delivery_date)).toBe(true);

    expect(order(FIXTURES.smallDeliveredOrder).total_cents).toBe(5895);
    expect(order(FIXTURES.fullyRefunded).status).toBe("refunded");
    expect(order(FIXTURES.standardShippingOrder).shipping_cents).toBe(795);
    expect(refunds(FIXTURES.standardShippingOrder)).toBe(0);
    expect(order(FIXTURES.awaitingShipment).status).toBe("paid");
    expect(order(FIXTURES.paidNotShipped).status).toBe("paid");
    expect(order(FIXTURES.paidUninvoiced).status).toBe("paid");
    expect(order(FIXTURES.pendingUnpaid).status).toBe("pending");
    expect(count(t.db, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?", FIXTURES.paidUninvoiced)).toBe(0);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?", FIXTURES.invoicedOrder)).toBe(1);

    const goodwill = t.db
      .prepare("SELECT order_id, amount_cents FROM refunds WHERE idempotency_key = ?")
      .get(FIXTURES.goodwillRefund.idempotencyKey) as { order_id: number; amount_cents: number };
    expect({ ...goodwill }).toEqual({ order_id: FIXTURES.goodwillRefund.orderId, amount_cents: FIXTURES.goodwillRefund.amountCents });
  });

  it("has duplicate and look-alike customer names, each Morgan Ellis with a pending order", () => {
    expect(count(t.db, "SELECT COUNT(*) AS n FROM customers WHERE name = ?", FIXTURES.ambiguousName)).toBe(2);
    for (const [customerId, orderId] of Object.entries(FIXTURES.ambiguousPendingOrders)) {
      const o = t.db.prepare("SELECT customer_id, status FROM orders WHERE id = ?").get(orderId) as {
        customer_id: number;
        status: string;
      };
      expect({ ...o }).toEqual({ customer_id: Number(customerId), status: "pending" });
    }
    expect(count(t.db, "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?", FIXTURES.priyaDenver.customerId)).toBe(
      FIXTURES.priyaDenver.orderCount,
    );
    expect(count(t.db, "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?", FIXTURES.priyaSeattle.customerId)).toBe(
      FIXTURES.priyaSeattle.orderCount,
    );
    for (const name of FIXTURES.lookAlikeNames) {
      expect(count(t.db, "SELECT COUNT(*) AS n FROM customers WHERE name = ?", name)).toBe(1);
    }
  });

  it("has products below, and exactly at, their reorder threshold", () => {
    expect(count(t.db, "SELECT COUNT(*) AS n FROM products WHERE stock_qty < reorder_threshold")).toBe(6);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM products WHERE stock_qty = 0")).toBe(1);
    const atThreshold = t.db
      .prepare("SELECT stock_qty, reorder_threshold FROM products WHERE sku = ?")
      .get(FIXTURES.atThresholdProductSku) as { stock_qty: number; reorder_threshold: number };
    expect(atThreshold.stock_qty).toBe(atThreshold.reorder_threshold);
  });

  it("has late August deliveries and no undelivered August orders", () => {
    const lateAug = t.db
      .prepare(
        `SELECT id FROM orders WHERE placed_at >= '2026-08-01' AND placed_at < '2026-09-01'
            AND delivered_at IS NOT NULL AND substr(delivered_at,1,10) > promised_delivery_date`,
      )
      .all() as Array<{ id: number }>;
    expect(lateAug.map((r) => r.id)).toEqual(expect.arrayContaining([...FIXTURES.augustLateDeliveries]));
    expect(
      count(
        t.db,
        `SELECT COUNT(*) AS n FROM orders WHERE placed_at >= '2026-08-01' AND placed_at < '2026-09-01'
            AND status IN ('pending','paid','shipped')`,
      ),
    ).toBe(0);
  });
});
