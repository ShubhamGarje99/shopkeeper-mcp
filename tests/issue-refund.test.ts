import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { issueRefund } from "../src/tools/index.js";
import { auditCount, call, count, expectShopError, freshDb, orderStatus, type TestDb } from "./helpers.js";

const refundRows = (t: TestDb, orderId: number) =>
  count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE order_id = ?", orderId);
const refundTotal = (t: TestDb, orderId: number) =>
  count(t.db, "SELECT COALESCE(SUM(amount_cents),0) AS n FROM refunds WHERE order_id = ?", orderId);

describe("issue_refund", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("refunds a late order in full, marks it refunded, and writes audit rows", () => {
    const { data, summary } = call(issueRefund, t.ctx, {
      order_id: FIXTURES.lateDelivery,
      amount_cents: 10_500,
      reason: "Delivered 3 days late",
      idempotency_key: "refund-1042-late",
    });
    expect(data.replayed).toBe(false);
    expect(data.refund).toMatchObject({ order_id: 1042, amount_cents: 10_500, idempotency_key: "refund-1042-late" });
    expect(data.order).toEqual({ id: 1042, status: "refunded", total_cents: 10_500, refunded_cents: 10_500, refundable_cents: 0 });
    expect(orderStatus(t.db, 1042)).toBe("refunded");
    expect(summary).toContain("$105.00");

    const audit = t.db.prepare("SELECT action, actor, details FROM audit_log ORDER BY id").all() as Array<{
      action: string;
      actor: string;
      details: string;
    }>;
    expect(audit.map((a) => a.action)).toEqual(["refund.issued", "order.status_changed"]);
    expect(audit[0]?.actor).toBe("test");
    expect(JSON.parse(audit[0]?.details ?? "{}")).toMatchObject({ amount_cents: 10_500, reason: "Delivered 3 days late" });
  });

  it("keeps status on a partial refund and shrinks the refundable remainder", () => {
    const { data } = call(issueRefund, t.ctx, {
      order_id: FIXTURES.standardShippingOrder,
      amount_cents: 795,
      reason: "Shipping refunded",
      idempotency_key: "refund-1088-shipping",
    });
    expect(data.order).toMatchObject({ status: "delivered", refunded_cents: 795, refundable_cents: 4195 - 795 });
    expect(orderStatus(t.db, FIXTURES.standardShippingOrder)).toBe("delivered");
  });

  it("GUARDRAIL: refuses an amount above the refundable remainder and writes nothing", () => {
    const before = auditCount(t.db);
    const err = expectShopError(
      () =>
        call(issueRefund, t.ctx, {
          order_id: FIXTURES.smallDeliveredOrder,
          amount_cents: 50_000,
          reason: "Customer asked for $500",
          idempotency_key: "refund-1010-500",
        }),
      "GUARDRAIL_VIOLATION",
      "REFUND_EXCEEDS_REFUNDABLE",
    );
    expect(err.details).toMatchObject({ requested_cents: 50_000, refundable_cents: 5895, total_cents: 5895 });
    expect(refundRows(t, FIXTURES.smallDeliveredOrder)).toBe(0);
    expect(auditCount(t.db)).toBe(before);
  });

  it("GUARDRAIL: cumulative partial refunds can never exceed the order total", () => {
    call(issueRefund, t.ctx, { order_id: 1010, amount_cents: 5000, reason: "first", idempotency_key: "refund-1010-a" });
    expectShopError(
      () => call(issueRefund, t.ctx, { order_id: 1010, amount_cents: 1000, reason: "second", idempotency_key: "refund-1010-b" }),
      "GUARDRAIL_VIOLATION",
      "REFUND_EXCEEDS_REFUNDABLE",
    );
    // Exactly the remainder is fine and completes the refund.
    call(issueRefund, t.ctx, { order_id: 1010, amount_cents: 895, reason: "rest", idempotency_key: "refund-1010-c" });
    expect(refundTotal(t, 1010)).toBe(5895);
    expect(orderStatus(t.db, 1010)).toBe("refunded");
  });

  it("IDEMPOTENCY: the same key replays the original refund instead of paying twice", () => {
    const args = { order_id: 1042, amount_cents: 2500, reason: "Late delivery credit", idempotency_key: "refund-1042-credit" };
    const first = call(issueRefund, t.ctx, args);
    const auditAfterFirst = auditCount(t.db);
    const second = call(issueRefund, t.ctx, args);
    const third = call(issueRefund, t.ctx, args);

    expect(second.data.replayed).toBe(true);
    expect(third.data.replayed).toBe(true);
    expect(second.data.refund).toEqual(first.data.refund);
    expect(refundRows(t, 1042)).toBe(1);
    expect(refundTotal(t, 1042)).toBe(2500);
    expect(auditCount(t.db)).toBe(auditAfterFirst); // replays have no side effects
    expect(second.summary).toMatch(/No new money was refunded/);
  });

  it("IDEMPOTENCY: replays a key created before this session (seeded goodwill refund)", () => {
    const { data } = call(issueRefund, t.ctx, {
      order_id: FIXTURES.goodwillRefund.orderId,
      amount_cents: FIXTURES.goodwillRefund.amountCents,
      reason: "retry after timeout",
      idempotency_key: FIXTURES.goodwillRefund.idempotencyKey,
    });
    expect(data.replayed).toBe(true);
    expect(refundRows(t, FIXTURES.goodwillRefund.orderId)).toBe(1);
  });

  it("CONFLICT: reusing a key for a different refund is rejected", () => {
    call(issueRefund, t.ctx, { order_id: 1042, amount_cents: 1000, reason: "credit", idempotency_key: "refund-key-1" });
    expectShopError(
      () => call(issueRefund, t.ctx, { order_id: 1042, amount_cents: 2000, reason: "credit", idempotency_key: "refund-key-1" }),
      "CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
    );
    expectShopError(
      () => call(issueRefund, t.ctx, { order_id: 1043, amount_cents: 1000, reason: "credit", idempotency_key: "refund-key-1" }),
      "CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE idempotency_key = 'refund-key-1'")).toBe(1);
  });

  it("GUARDRAIL: refuses an already fully refunded order", () => {
    const before = refundRows(t, FIXTURES.fullyRefunded);
    expectShopError(
      () =>
        call(issueRefund, t.ctx, {
          order_id: FIXTURES.fullyRefunded,
          amount_cents: 100,
          reason: "mug cracked",
          idempotency_key: "refund-1077-again",
        }),
      "GUARDRAIL_VIOLATION",
      "ORDER_FULLY_REFUNDED",
    );
    expect(refundRows(t, FIXTURES.fullyRefunded)).toBe(before);
  });

  it("GUARDRAIL: refuses unpaid (pending) and cancelled orders", () => {
    expectShopError(
      () =>
        call(issueRefund, t.ctx, {
          order_id: FIXTURES.pendingUnpaid,
          amount_cents: 100,
          reason: "x refund",
          idempotency_key: "refund-1180-x",
        }),
      "GUARDRAIL_VIOLATION",
      "ORDER_NOT_REFUNDABLE",
    );
    const cancelled = t.db.prepare("SELECT id FROM orders WHERE status = 'cancelled' LIMIT 1").get() as { id: number };
    expectShopError(
      () =>
        call(issueRefund, t.ctx, { order_id: cancelled.id, amount_cents: 100, reason: "x refund", idempotency_key: "refund-cxl-x" }),
      "GUARDRAIL_VIOLATION",
      "ORDER_NOT_REFUNDABLE",
    );
  });

  it("VALIDATION: rejects zero/negative/fractional amounts, missing reason, weak keys and unknown fields", () => {
    const base = { order_id: 1042, amount_cents: 100, reason: "valid reason", idempotency_key: "refund-valid-1" };
    for (const bad of [
      { ...base, amount_cents: 0 },
      { ...base, amount_cents: -500 },
      { ...base, amount_cents: 10.5 },
      { ...base, reason: "  " },
      { order_id: 1042, amount_cents: 100, idempotency_key: "refund-valid-1" },
      { ...base, idempotency_key: "short" },
      { ...base, idempotency_key: "has spaces in it" },
      { ...base, dry_run: true },
    ]) {
      expectShopError(() => call(issueRefund, t.ctx, bad), "VALIDATION_ERROR", "INVALID_INPUT");
    }
    expect(refundRows(t, 1042)).toBe(0);
  });

  it("NOT_FOUND: unknown order", () => {
    expectShopError(
      () => call(issueRefund, t.ctx, { order_id: 9999, amount_cents: 100, reason: "nope", idempotency_key: "refund-9999" }),
      "NOT_FOUND",
      "ORDER_NOT_FOUND",
    );
  });
});
