import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES, SEED_REFERENCE_NOW } from "../src/db/seed.js";
import { updateOrderStatus } from "../src/tools/index.js";
import { auditCount, call, expectShopError, freshDb, orderStatus, type TestDb } from "./helpers.js";

describe("update_order_status", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("ships a paid order, stamps shipped_at, and audits the change", () => {
    const { data } = call(updateOrderStatus, t.ctx, { order_id: FIXTURES.awaitingShipment, status: "shipped", note: "TRK-123" });
    expect(data).toMatchObject({ previous_status: "paid", status: "shipped", changed: true, allowed_next_statuses: ["delivered"] });
    const row = t.db.prepare("SELECT status, shipped_at, updated_at FROM orders WHERE id = ?").get(FIXTURES.awaitingShipment) as {
      status: string;
      shipped_at: string;
      updated_at: string;
    };
    expect({ ...row }).toEqual({ status: "shipped", shipped_at: SEED_REFERENCE_NOW, updated_at: SEED_REFERENCE_NOW });
    const audit = t.db.prepare("SELECT action, details FROM audit_log").get() as { action: string; details: string };
    expect(audit.action).toBe("order.status_changed");
    expect(JSON.parse(audit.details)).toEqual({ from: "paid", to: "shipped", note: "TRK-123" });
  });

  it("walks the full happy path pending -> paid -> shipped -> delivered", () => {
    const id = FIXTURES.pendingUnpaid;
    for (const status of ["paid", "shipped", "delivered"] as const) {
      call(updateOrderStatus, t.ctx, { order_id: id, status });
      expect(orderStatus(t.db, id)).toBe(status);
    }
    expect(auditCount(t.db)).toBe(3);
  });

  it("is idempotent: setting the current status again is a no-op with no audit row", () => {
    const { data, summary } = call(updateOrderStatus, t.ctx, { order_id: FIXTURES.awaitingShipment, status: "paid" });
    expect(data.changed).toBe(false);
    expect(summary).toMatch(/Nothing changed/);
    expect(auditCount(t.db)).toBe(0);
  });

  it("CONFLICT: rejects skipping steps (pending -> delivered) and leaves the order untouched", () => {
    const err = expectShopError(
      () => call(updateOrderStatus, t.ctx, { order_id: FIXTURES.pendingUnpaid, status: "delivered" }),
      "CONFLICT",
      "INVALID_STATUS_TRANSITION",
    );
    expect(err.details).toMatchObject({ from: "pending", to: "delivered", allowed_next_statuses: ["paid", "cancelled"] });
    expect(String(err.details.hint)).toMatch(/not been paid/);
    expect(orderStatus(t.db, FIXTURES.pendingUnpaid)).toBe("pending");
    expect(auditCount(t.db)).toBe(0);
  });

  it("CONFLICT: 'refunded' can only be reached through issue_refund", () => {
    const err = expectShopError(
      () => call(updateOrderStatus, t.ctx, { order_id: FIXTURES.lateDelivery, status: "refunded" }),
      "CONFLICT",
      "INVALID_STATUS_TRANSITION",
    );
    expect(String(err.details.hint)).toMatch(/issue_refund/);
  });

  it("CONFLICT: paid orders cannot be cancelled, terminal statuses cannot move, and going backwards is refused", () => {
    expectShopError(
      () => call(updateOrderStatus, t.ctx, { order_id: FIXTURES.awaitingShipment, status: "cancelled" }),
      "CONFLICT",
      "INVALID_STATUS_TRANSITION",
    );
    expectShopError(
      () => call(updateOrderStatus, t.ctx, { order_id: FIXTURES.lateDelivery, status: "shipped" }),
      "CONFLICT",
      "INVALID_STATUS_TRANSITION",
    );
    expectShopError(
      () => call(updateOrderStatus, t.ctx, { order_id: FIXTURES.fullyRefunded, status: "delivered" }),
      "CONFLICT",
      "INVALID_STATUS_TRANSITION",
    );
    expect(auditCount(t.db)).toBe(0);
  });

  it("VALIDATION and NOT_FOUND", () => {
    expectShopError(() => call(updateOrderStatus, t.ctx, { order_id: 1042, status: "lost" }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(updateOrderStatus, t.ctx, { order_id: 9999, status: "paid" }), "NOT_FOUND", "ORDER_NOT_FOUND");
  });
});
