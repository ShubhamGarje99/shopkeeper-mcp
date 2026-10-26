import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { searchCustomers } from "../src/tools/index.js";
import { call, expectShopError, freshDb, type TestDb } from "./helpers.js";

describe("search_customers", () => {
  let t: TestDb;
  beforeEach(() => {
    t = freshDb();
  });
  afterEach(() => t.cleanup());

  it("matches an exact email with score 1 and no ambiguity", () => {
    const { data } = call(searchCustomers, t.ctx, { query: FIXTURES.priyaDenver.email });
    expect(data.matches[0]).toMatchObject({ customer_id: FIXTURES.priyaDenver.customerId, match_type: "exact_email", score: 1 });
    expect(data.matches[0]?.order_count).toBe(FIXTURES.priyaDenver.orderCount);
    expect(data.ambiguous).toBe(false);
  });

  it("flags two customers with the same name as ambiguous and says so", () => {
    const { data, summary } = call(searchCustomers, t.ctx, { query: "morgan ellis" });
    expect(data.ambiguous).toBe(true);
    expect(data.matches.slice(0, 2).map((m) => m.customer_id).sort()).toEqual([35, 36]);
    expect(new Set(data.matches.slice(0, 2).map((m) => m.city))).toEqual(new Set(["Portland", "Brooklyn"]));
    expect(data.note).toMatch(/Confirm which one/);
    expect(summary).toMatch(/equally well/);
  });

  it("finds look-alike names from a misspelled query (fuzzy)", () => {
    const { data } = call(searchCustomers, t.ctx, { query: "jon benet" });
    const names = data.matches.map((m) => m.name);
    expect(names).toContain("Jon Bennet");
    expect(names).toContain("John Bennett");
  });

  it("is case- and accent-insensitive", () => {
    const { data } = call(searchCustomers, t.ctx, { query: "TOMAS HERRERA" });
    expect(data.matches[0]).toMatchObject({ name: "Tomás Herrera", match_type: "exact_name" });
  });

  it("supports partial matches and the limit", () => {
    const { data } = call(searchCustomers, t.ctx, { query: "example.com", limit: 5 });
    expect(data.matches).toHaveLength(5);
    expect(data.matches.every((m) => m.match_type === "partial")).toBe(true);
  });

  it("reports lifetime spend net of refunds", () => {
    const { data } = call(searchCustomers, t.ctx, { query: FIXTURES.priyaSeattle.email });
    const m = data.matches[0];
    const expected = t.db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE customer_id = ? AND status IN ('paid','shipped','delivered','refunded'))
         - (SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.customer_id = ?) AS n`,
      )
      .get(FIXTURES.priyaSeattle.customerId, FIXTURES.priyaSeattle.customerId) as { n: number };
    expect(m?.lifetime_net_spend_cents).toBe(expected.n);
  });

  it("returns an empty result with a note when nothing matches", () => {
    const { data } = call(searchCustomers, t.ctx, { query: "zzqx nobody" });
    expect(data.matches).toEqual([]);
    expect(data.note).toMatch(/No customers match/);
  });

  it("VALIDATION: too-short query", () => {
    expectShopError(() => call(searchCustomers, t.ctx, { query: "a" }), "VALIDATION_ERROR", "INVALID_INPUT");
  });
});
