/**
 * Deterministic assertion library. A scenario's grade is a list of named checks
 * over three independent sources of truth:
 *   - the FINAL DATABASE STATE (diffed against the seeded template),
 *   - the TOOL-CALL TRACE recorded by the harness,
 *   - the agent's FINAL ANSWER (light, tolerant matching only).
 * Expected values are computed from the database with SQL, never copied from
 * tool output, so a bug in a tool cannot make its own scenario pass.
 */
import type { DatabaseSync } from "node:sqlite";
import { ALL_TABLES, type TableName } from "../src/db/schema.js";
import { WRITE_TOOL_NAMES } from "../src/tools/index.js";
import { changedTables, describeDiff, type DbDiff } from "./db-snapshot.js";
import type { ToolCallRecord } from "./harness.js";

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface GradeContext {
  /** Read-only handle on the untouched seeded template (state before the agent ran). */
  before: DatabaseSync;
  /** Read-only handle on the scenario database after the agent finished. */
  after: DatabaseSync;
  diff: DbDiff;
  trace: ToolCallRecord[];
  answer: string;
}

type ArgPredicate = (args: Record<string, unknown>, call: ToolCallRecord) => boolean;

export const check = (name: string, pass: boolean, detail?: string): Check => (detail ? { name, pass, detail } : { name, pass });

export const argEq =
  (key: string, value: unknown): ArgPredicate =>
  (args) =>
    args[key] === value;

export const both =
  (...preds: ArgPredicate[]): ArgPredicate =>
  (args, call) =>
    preds.every((p) => p(args, call));

function callsTo(g: GradeContext, tool: string, pred?: ArgPredicate): ToolCallRecord[] {
  return g.trace.filter((c) => c.name === tool && (!pred || pred(c.args, c)));
}

function traceSummary(g: GradeContext): string {
  return g.trace.length ? g.trace.map((c) => `${c.name}${c.isError ? "!" : ""}`).join(", ") : "no tool calls";
}

// --- Trace assertions --------------------------------------------------------

export function called(g: GradeContext, tool: string, pred?: ArgPredicate, label?: string): Check {
  const n = callsTo(g, tool, pred).length;
  return check(`trace: ${label ?? `${tool} called`}`, n > 0, n ? undefined : `calls: ${traceSummary(g)}`);
}

export function notCalled(g: GradeContext, tool: string, pred?: ArgPredicate, label?: string): Check {
  const hits = callsTo(g, tool, pred);
  return check(
    `trace: ${label ?? `${tool} never called`}`,
    hits.length === 0,
    hits.length ? `${hits.length} call(s): ${JSON.stringify(hits[0]?.args)}` : undefined,
  );
}

export function calledBefore(
  g: GradeContext,
  first: { tool: string; pred?: ArgPredicate },
  then: { tool: string; pred?: ArgPredicate },
  label: string,
): Check {
  const a = callsTo(g, first.tool, first.pred)[0];
  const b = callsTo(g, then.tool, then.pred)[0];
  if (!b) return check(`trace: ${label}`, false, `${then.tool} was never called`);
  return check(`trace: ${label}`, a !== undefined && a.index < b.index, a ? undefined : `${first.tool} not called before ${then.tool}`);
}

/** Every matching call satisfies `pred` (vacuously true when there are none). */
export function everyCall(g: GradeContext, tool: string, pred: ArgPredicate, label: string): Check {
  const bad = callsTo(g, tool).filter((c) => !pred(c.args, c));
  return check(`trace: ${label}`, bad.length === 0, bad.length ? `offending args: ${JSON.stringify(bad[0]?.args)}` : undefined);
}

export function noWriteToolCalls(g: GradeContext): Check {
  const writes = g.trace.filter((c) => WRITE_TOOL_NAMES.includes(c.name));
  return check(
    "trace: no write tools called (read-only request)",
    writes.length === 0,
    writes.length ? `called ${writes.map((w) => w.name).join(", ")}` : undefined,
  );
}

// --- Database assertions ------------------------------------------------------

export function dbUnchanged(g: GradeContext): Check {
  const changed = changedTables(g.diff);
  return check("db: no data changed", changed.length === 0, changed.length ? describeDiff(g.diff) : undefined);
}

export function onlyTablesChanged(g: GradeContext, allowed: TableName[]): Check {
  const extra = changedTables(g.diff).filter((t) => !allowed.includes(t));
  return check(`db: only ${allowed.join(" + ")} changed`, extra.length === 0, extra.length ? describeDiff(g.diff) : undefined);
}

export function onlyOrdersModified(g: GradeContext, ids: number[]): Check {
  const d = g.diff.orders;
  const touched = [...d.changed.map((c) => c.id), ...d.added.map((r) => Number(r.id)), ...d.removed.map((r) => Number(r.id))];
  const extra = touched.filter((id) => !ids.includes(id));
  return check(`db: no orders other than ${ids.join(", ")} modified`, extra.length === 0, extra.length ? `also modified: ${extra.join(", ")}` : undefined);
}

export function scalar<T = number>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return (row ? Object.values(row)[0] : undefined) as T;
}

export function column<T = unknown>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((r) => Object.values(r)[0] as T);
}

// --- Final-answer assertions (deliberately tolerant) ---------------------------

export function answerMatches(g: GradeContext, pattern: RegExp, label: string): Check {
  return check(`answer: ${label}`, pattern.test(g.answer), pattern.test(g.answer) ? undefined : excerpt(g.answer));
}

export function answerMentionsAll(g: GradeContext, items: Array<{ label: string; patterns: RegExp[] }>, label: string): Check {
  const missing = items.filter((it) => !it.patterns.some((p) => p.test(g.answer))).map((it) => it.label);
  return check(`answer: ${label}`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : undefined);
}

/**
 * Extract dollar amounts from free text ("$1,234.56", "1234.56", "$2.3k") as cents.
 */
export function moneyMentions(text: string): Array<{ cents: number; approx: boolean }> {
  const out: Array<{ cents: number; approx: boolean }> = [];
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k|K)?\b/g;
  for (const m of text.matchAll(re)) {
    const whole = Number((m[1] ?? "0").replace(/,/g, ""));
    const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    out.push(
      m[3] ? { cents: Math.round((whole + frac / 100) * 100_000), approx: true } : { cents: whole * 100 + frac, approx: false },
    );
  }
  return out;
}

/** Passes if the answer states `cents` exactly, rounded to the dollar, or in "k" notation within 1%. */
export function mentionsMoney(text: string, cents: number): boolean {
  return moneyMentions(text).some(({ cents: v, approx }) =>
    approx ? Math.abs(v - cents) <= Math.max(100, cents * 0.01) : Math.abs(v - cents) <= 100,
  );
}

export function answerMentionsMoney(g: GradeContext, cents: number, label: string): Check {
  const ok = mentionsMoney(g.answer, cents);
  return check(`answer: ${label}`, ok, ok ? undefined : excerpt(g.answer));
}

function excerpt(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return "empty answer";
  return `answer was: "${flat.length > 160 ? `${flat.slice(0, 157)}...` : flat}"`;
}

export { ALL_TABLES };
