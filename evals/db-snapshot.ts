/**
 * Whole-database snapshots and diffs. Graders compare the seeded template
 * (before) with the scenario's database after the agent finished, so "did
 * anything change that should not have?" is checked on actual state, not on
 * what the agent claims.
 */
import type { DatabaseSync } from "node:sqlite";
import { ALL_TABLES, type TableName } from "../src/db/schema.js";

export type Row = Record<string, unknown>;
export type Snapshot = Record<TableName, Map<number, Row>>;

export interface TableDiff {
  added: Row[];
  removed: Row[];
  changed: Array<{ id: number; before: Row; after: Row; columns: string[] }>;
}
export type DbDiff = Record<TableName, TableDiff>;

export function snapshot(db: DatabaseSync): Snapshot {
  const snap = {} as Snapshot;
  for (const table of ALL_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[];
    snap[table] = new Map(rows.map((r) => [Number(r.id), { ...r }]));
  }
  return snap;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DbDiff {
  const diff = {} as DbDiff;
  for (const table of ALL_TABLES) {
    const b = before[table];
    const a = after[table];
    const d: TableDiff = { added: [], removed: [], changed: [] };
    for (const [id, row] of a) {
      const prev = b.get(id);
      if (!prev) {
        d.added.push(row);
        continue;
      }
      const columns = Object.keys(row).filter((k) => row[k] !== prev[k]);
      if (columns.length) d.changed.push({ id, before: prev, after: row, columns });
    }
    for (const [id, row] of b) if (!a.has(id)) d.removed.push(row);
    diff[table] = d;
  }
  return diff;
}

export function changedTables(diff: DbDiff): TableName[] {
  return ALL_TABLES.filter((t) => diff[t].added.length + diff[t].removed.length + diff[t].changed.length > 0);
}

export function describeDiff(diff: DbDiff): string {
  const parts = changedTables(diff).map((t) => {
    const d = diff[t];
    const bits = [
      d.added.length ? `+${d.added.length}` : "",
      d.removed.length ? `-${d.removed.length}` : "",
      d.changed.length ? `~${d.changed.length} (${d.changed.map((c) => `#${c.id}: ${c.columns.join("/")}`).join(", ")})` : "",
    ].filter(Boolean);
    return `${t} ${bits.join(" ")}`;
  });
  return parts.length ? parts.join("; ") : "no changes";
}
