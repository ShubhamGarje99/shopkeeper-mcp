import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { lowStockAlerts } from "../src/tools/index.js";
import { suggestedReorderQty } from "../src/tools/low-stock-alerts.js";
import { call, expectShopError, freshDb, type TestDb } from "./helpers.js";

describe("low_stock_alerts", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("lists products strictly below threshold, most urgent first", () => {
    const { data } = call(lowStockAlerts, t.ctx, {});
    expect(data.count).toBe(6);
    expect(data.alerts[0]).toMatchObject({ sku: "KC-GRD-003", stock_qty: 0, severity: "out_of_stock", suggested_reorder_qty: 40 });
    expect(data.alerts.map((a) => a.sku)).not.toContain(FIXTURES.atThresholdProductSku);
    expect(data.alerts.map((a) => a.sku).sort()).toEqual(
      ["KC-BNS-002", "KC-BRW-003", "KC-BRW-005", "KC-FLT-002", "KC-GRD-003", "KC-TEA-002"].sort(),
    );
    const severities = data.alerts.map((a) => a.severity);
    expect(severities.indexOf("critical")).toBeLessThan(severities.indexOf("low"));
  });

  it("suggests refilling to target stock, rounded up to whole case packs", () => {
    const { data } = call(lowStockAlerts, t.ctx, {});
    const bySku = Object.fromEntries(data.alerts.map((a) => [a.sku, a]));
    expect(bySku["KC-FLT-002"]?.suggested_reorder_qty).toBe(250); // 250 - 35 = 215 -> 5 cases of 50
    expect(bySku["KC-BRW-003"]?.suggested_reorder_qty).toBe(30); // 36 - 7 = 29 -> 5 cases of 6
    expect(bySku["KC-BNS-002"]).toMatchObject({ severity: "critical", suggested_reorder_qty: 60 });
    for (const a of data.alerts) {
      expect(a.suggested_reorder_qty % a.case_pack).toBe(0);
      expect(a.stock_qty + a.suggested_reorder_qty).toBeGreaterThanOrEqual(a.target_stock);
      expect(a.shortfall).toBe(a.reorder_threshold - a.stock_qty);
    }
    expect(suggestedReorderQty({ stock_qty: 50, target_stock: 40, case_pack: 6 })).toBe(0);
  });

  it("filters by category", () => {
    const { data } = call(lowStockAlerts, t.ctx, { category: "tea" });
    expect(data.alerts.map((a) => a.sku)).toEqual(["KC-TEA-002"]);
    expect(call(lowStockAlerts, t.ctx, { category: "kettles" }).data.count).toBe(0);
  });

  it("reflects live stock changes", () => {
    t.db.prepare("UPDATE products SET stock_qty = 2 WHERE sku = ?").run(FIXTURES.atThresholdProductSku);
    expect(call(lowStockAlerts, t.ctx, {}).data.alerts.map((a) => a.sku)).toContain(FIXTURES.atThresholdProductSku);
  });

  it("VALIDATION: unknown category", () => {
    expectShopError(() => call(lowStockAlerts, t.ctx, { category: "spoons" }), "VALIDATION_ERROR", "INVALID_INPUT");
  });
});
