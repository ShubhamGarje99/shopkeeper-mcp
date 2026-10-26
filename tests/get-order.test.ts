import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { getOrder } from "../src/tools/index.js";
import { call, expectShopError, freshDb, type TestDb } from "./helpers.js";

describe("get_order", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("returns items, customer, financials, invoice and late-delivery timing", () => {
    const { data, summary } = call(getOrder, t.ctx, { order_id: FIXTURES.lateDelivery });
    expect(data.order).toMatchObject({ id: 1042, status: "delivered", allowed_next_statuses: [] });
    expect(data.delivery).toEqual({ status: "delivered_late", promised_date: "2026-03-30", delivered_date: "2026-04-02", days_late: 3 });
    expect(data.financials).toEqual({
      currency: "USD",
      subtotal_cents: 10_500,
      shipping_cents: 0,
      total_cents: 10_500,
      refunded_cents: 0,
      refundable_cents: 10_500,
    });
    expect(data.items.map((i) => i.sku)).toEqual(["KC-GRD-001", "KC-TEA-001"]);
    expect(data.items.reduce((s, i) => s + i.line_total_cents, 0)).toBe(data.financials.subtotal_cents);
    expect(data.invoice?.invoice_number).toBe("INV-2026-1042");
    expect(data.refund_eligibility).toEqual({ eligible: true, refundable_cents: 10_500, reason: null });
    expect(data.customer.email).toMatch(/@example\.com$/);
    expect(summary).toMatch(/3 day\(s\) LATE/);
  });

  it("reports on-time delivery", () => {
    const { data } = call(getOrder, t.ctx, { order_id: FIXTURES.onTimeDelivery });
    expect(data.delivery.status).toBe("delivered_on_time");
    expect(data.delivery.days_late).toBe(0);
  });

  it("shows prior refunds (with their idempotency keys) and refund ineligibility when fully refunded", () => {
    const { data } = call(getOrder, t.ctx, { order_id: FIXTURES.fullyRefunded });
    expect(data.order.status).toBe("refunded");
    expect(data.refunds).toHaveLength(1);
    expect(data.refunds[0]?.amount_cents).toBe(data.financials.total_cents);
    expect(data.refund_eligibility.eligible).toBe(false);
    expect(data.refund_eligibility.reason).toMatch(/already fully refunded/);
    expect(data.financials.refundable_cents).toBe(0);

    const goodwill = call(getOrder, t.ctx, { order_id: FIXTURES.goodwillRefund.orderId }).data;
    expect(goodwill.refunds.map((r) => r.idempotency_key)).toContain(FIXTURES.goodwillRefund.idempotencyKey);
    expect(goodwill.financials.refundable_cents).toBe(goodwill.financials.total_cents - FIXTURES.goodwillRefund.amountCents);
  });

  it("flags unpaid orders and lists their legal next statuses", () => {
    const { data } = call(getOrder, t.ctx, { order_id: FIXTURES.pendingUnpaid });
    expect(data.order.allowed_next_statuses).toEqual(["paid", "cancelled"]);
    expect(data.delivery.status).toBe("awaiting_payment");
    expect(data.refund_eligibility).toMatchObject({ eligible: false, refundable_cents: 0 });
    expect(data.invoice).toBeNull();
  });

  it("marks a paid-but-unshipped order past its promise date as overdue (relative to the pinned clock)", () => {
    const { data } = call(getOrder, t.ctx, { order_id: FIXTURES.awaitingShipment });
    expect(data.delivery.status).toBe("overdue");
    expect(data.delivery.days_late).toBeGreaterThan(90);
  });

  it("NOT_FOUND and VALIDATION", () => {
    expectShopError(() => call(getOrder, t.ctx, { order_id: 9999 }), "NOT_FOUND", "ORDER_NOT_FOUND");
    expectShopError(() => call(getOrder, t.ctx, { order_id: "1042" }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(getOrder, t.ctx, {}), "VALIDATION_ERROR", "INVALID_INPUT");
  });
});
