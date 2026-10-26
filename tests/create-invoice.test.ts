import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES, SEED_REFERENCE_NOW } from "../src/db/seed.js";
import { createInvoice } from "../src/tools/index.js";
import { auditCount, call, count, expectShopError, freshDb, type TestDb } from "./helpers.js";

describe("create_invoice", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("invoices a paid order for its total, due today, and audits it", () => {
    const total = (t.db.prepare("SELECT total_cents FROM orders WHERE id = ?").get(FIXTURES.paidUninvoiced) as { total_cents: number })
      .total_cents;
    const { data } = call(createInvoice, t.ctx, { order_id: FIXTURES.paidUninvoiced });
    expect(data.invoice).toEqual({
      invoice_number: `INV-2026-${FIXTURES.paidUninvoiced}`,
      order_id: FIXTURES.paidUninvoiced,
      amount_cents: total,
      issued_at: SEED_REFERENCE_NOW,
      due_date: "2026-09-30",
      notes: null,
      payment_status: "paid",
    });
    expect(count(t.db, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?", FIXTURES.paidUninvoiced)).toBe(1);
    expect(auditCount(t.db)).toBe(1);
  });

  it("gives unpaid orders payment terms", () => {
    const { data } = call(createInvoice, t.ctx, { order_id: FIXTURES.pendingUnpaid, due_in_days: 30, notes: "Net 30" });
    expect(data.invoice).toMatchObject({ due_date: "2026-10-30", payment_status: "unpaid", notes: "Net 30" });
  });

  it("CONFLICT: refuses a duplicate invoice and reports the existing number", () => {
    const before = count(t.db, "SELECT COUNT(*) AS n FROM invoices");
    const err = expectShopError(
      () => call(createInvoice, t.ctx, { order_id: FIXTURES.invoicedOrder }),
      "CONFLICT",
      "INVOICE_ALREADY_EXISTS",
    );
    expect(err.details.invoice_number).toBe(`INV-2026-${FIXTURES.invoicedOrder}`);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM invoices")).toBe(before);
  });

  it("CONFLICT: the second of two identical requests is refused (no double invoicing)", () => {
    call(createInvoice, t.ctx, { order_id: FIXTURES.paidUninvoiced });
    expectShopError(() => call(createInvoice, t.ctx, { order_id: FIXTURES.paidUninvoiced }), "CONFLICT", "INVOICE_ALREADY_EXISTS");
    expect(count(t.db, "SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?", FIXTURES.paidUninvoiced)).toBe(1);
  });

  it("CONFLICT: cancelled orders cannot be invoiced", () => {
    const cancelled = t.db.prepare("SELECT id FROM orders WHERE status = 'cancelled' LIMIT 1").get() as { id: number };
    expectShopError(() => call(createInvoice, t.ctx, { order_id: cancelled.id }), "CONFLICT", "ORDER_NOT_INVOICEABLE");
  });

  it("VALIDATION and NOT_FOUND", () => {
    expectShopError(() => call(createInvoice, t.ctx, { order_id: 1150, due_in_days: 365 }), "VALIDATION_ERROR", "INVALID_INPUT");
    expectShopError(() => call(createInvoice, t.ctx, { order_id: 9999 }), "NOT_FOUND", "ORDER_NOT_FOUND");
  });
});
