import { describe, expect, it } from "vitest";
import path from "node:path";
import { addDays, daysBetween, fixedClock, isoTimestamp } from "../src/clock.js";
import { DEFAULT_DB_PATH, resolveRuntimeOptions } from "../src/config.js";
import { ORDER_STATUSES } from "../src/db/schema.js";
import { normalizeText, similarity, tokenSimilarity } from "../src/domain/fuzzy.js";
import { canTransition, STATUS_TRANSITIONS } from "../src/domain/status-machine.js";
import { ConflictError, GuardrailViolation, NotFoundError, ShopError, toErrorEnvelope, ValidationError } from "../src/errors.js";
import { allocateProRata, formatCents } from "../src/money.js";

describe("money", () => {
  it("formats cents without floating-point drift", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(-995)).toBe("-$9.95");
    expect(() => formatCents(10.5)).toThrow(TypeError);
  });

  it("allocates pro-rata with parts that always sum exactly", () => {
    expect(allocateProRata(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProRata(1001, [3, 7])).toEqual([300, 701]);
    for (const amount of [1, 99, 7195, 123_457]) {
      const parts = allocateProRata(amount, [3950, 1500, 795, 1]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
    }
    expect(allocateProRata(50, [0, 0])).toEqual([0, 0]);
  });
});

describe("status machine", () => {
  it("only allows forward moves and never sets refunded directly", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("pending", "cancelled")).toBe(true);
    expect(canTransition("paid", "shipped")).toBe(true);
    expect(canTransition("shipped", "delivered")).toBe(true);
    expect(canTransition("pending", "delivered")).toBe(false);
    expect(canTransition("paid", "cancelled")).toBe(false);
    expect(canTransition("delivered", "shipped")).toBe(false);
    for (const s of ORDER_STATUSES) expect(STATUS_TRANSITIONS[s]).not.toContain("refunded");
  });
});

describe("fuzzy matching", () => {
  it("normalizes accents, case and apostrophes", () => {
    expect(normalizeText("  Tomás  O'Connor ")).toBe("tomas oconnor");
  });
  it("scores typos highly and unrelated names low", () => {
    expect(similarity("bennett", "bennet")).toBeGreaterThan(0.8);
    expect(tokenSimilarity("jon benett", "John Bennett")).toBeGreaterThan(0.72);
    expect(tokenSimilarity("priya", "Marcus Reid")).toBeLessThan(0.5);
  });
});

describe("clock", () => {
  it("pins time and does date math in UTC", () => {
    expect(isoTimestamp(fixedClock("2026-09-30T18:00:00Z")())).toBe("2026-09-30T18:00:00Z");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysBetween("2026-03-30", "2026-04-02")).toBe(3);
    expect(() => fixedClock("not a date")).toThrow();
  });
});

describe("errors", () => {
  it("each class carries its stable code and serializes to the envelope", () => {
    const cases: Array<[ShopError, string]> = [
      [new NotFoundError("ORDER_NOT_FOUND", "x"), "NOT_FOUND"],
      [new ValidationError("INVALID_INPUT", "x"), "VALIDATION_ERROR"],
      [new GuardrailViolation("REFUND_EXCEEDS_REFUNDABLE", "x"), "GUARDRAIL_VIOLATION"],
      [new ConflictError("INVOICE_ALREADY_EXISTS", "x"), "CONFLICT"],
    ];
    for (const [err, code] of cases) {
      expect(toErrorEnvelope(err).error.code).toBe(code);
      expect(err).toBeInstanceOf(ShopError);
    }
  });
  it("hides internals of unexpected errors", () => {
    const env = toErrorEnvelope(new Error("SQLITE_CORRUPT at /secret/path"));
    expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(env.error.message).not.toMatch(/secret/);
  });
});

describe("runtime options", () => {
  it("CLI flags override env vars, which override defaults", () => {
    expect(resolveRuntimeOptions([], {})).toEqual({ dbPath: DEFAULT_DB_PATH, now: undefined });
    expect(resolveRuntimeOptions([], { SHOPKEEPER_DB: "/tmp/a.db", SHOPKEEPER_NOW: "2026-01-01T00:00:00Z" })).toEqual({
      dbPath: path.resolve("/tmp/a.db"),
      now: "2026-01-01T00:00:00Z",
    });
    expect(
      resolveRuntimeOptions(["--db", "/tmp/b.db", "--now", "2026-09-30T18:00:00Z"], { SHOPKEEPER_DB: "/tmp/a.db", SHOPKEEPER_NOW: "x" }),
    ).toEqual({ dbPath: path.resolve("/tmp/b.db"), now: "2026-09-30T18:00:00Z" });
  });
  it("rejects unknown flags", () => {
    expect(() => resolveRuntimeOptions(["--dry-run"], {})).toThrow();
  });
});
