/** The eval graders are code too: test their parsing and diffing. */
import { describe, expect, it } from "vitest";
import { createSeededDatabase } from "../src/db/connection.js";
import { changedTables, describeDiff, diffSnapshots, snapshot } from "../evals/db-snapshot.js";
import { mentionsMoney, moneyMentions } from "../evals/graders.js";
import { SCENARIOS } from "../evals/scenarios.js";

describe("money mentions in free text", () => {
  it("parses dollars, commas, cents and k-notation", () => {
    expect(moneyMentions("Refunded $1,234.56 and $7.5").map((m) => m.cents)).toEqual([123_456, 750]);
    expect(moneyMentions("about $2.3k")).toEqual([{ cents: 230_000, approx: true }]);
  });
  it("accepts exact or dollar-rounded amounts, rejects wrong ones", () => {
    expect(mentionsMoney("net $2,335.30", 233_530)).toBe(true);
    expect(mentionsMoney("net $2,335", 233_530)).toBe(true);
    expect(mentionsMoney("net $2,345.30", 233_530)).toBe(false);
    expect(mentionsMoney("roughly $2.3k", 233_530)).toBe(false); // 1.5% off: too loose
    expect(mentionsMoney("roughly $2.34k", 233_530)).toBe(true);
    expect(mentionsMoney("no numbers here", 100)).toBe(false);
  });
});

describe("database diffing", () => {
  it("reports no changes for identical databases and pinpoints edits", () => {
    const a = createSeededDatabase(":memory:");
    const b = createSeededDatabase(":memory:");
    expect(changedTables(diffSnapshots(snapshot(a), snapshot(b)))).toEqual([]);

    b.prepare("UPDATE orders SET status = 'shipped' WHERE id = 1107").run();
    b.prepare("INSERT INTO audit_log (at, actor, action, entity, entity_id, details) VALUES ('t','x','y','order','1107','{}')").run();
    const diff = diffSnapshots(snapshot(a), snapshot(b));
    expect(changedTables(diff)).toEqual(["orders", "audit_log"]);
    expect(diff.orders.changed).toEqual([expect.objectContaining({ id: 1107, columns: ["status"] })]);
    expect(diff.audit_log.added).toHaveLength(1);
    expect(describeDiff(diff)).toMatch(/orders ~1 \(#1107: status\)/);
    a.close();
    b.close();
  });
});

describe("scenario catalog", () => {
  it("has 15 uniquely named scenarios with prompts and graders", () => {
    expect(SCENARIOS).toHaveLength(15);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(15);
    for (const s of SCENARIOS) {
      expect(s.prompt.length).toBeGreaterThan(10);
      expect(typeof s.grade).toBe("function");
      expect(typeof s.oracle).toBe("function");
    }
  });
});
