import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { z } from "zod";
import { fixedClock } from "../src/clock.js";
import { createSeededDatabase, type Db } from "../src/db/connection.js";
import { SEED_REFERENCE_NOW } from "../src/db/seed.js";
import { ShopError, type ErrorCode } from "../src/errors.js";
import { invokeTool, type ObjectSchema, type ToolContext, type ToolSpec } from "../src/tools/types.js";

export const NOW = SEED_REFERENCE_NOW;

export interface TestDb {
  db: Db;
  ctx: ToolContext;
  file: string;
  cleanup: () => void;
}

/** A brand-new seeded SQLite file in a temp dir, with the clock pinned to the seed's "today". */
export function freshDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shopkeeper-test-"));
  const file = path.join(dir, "shop.db");
  const db = createSeededDatabase(file);
  return {
    db,
    file,
    ctx: { db, clock: fixedClock(NOW), actor: "test" },
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Invoke a tool and assert its structured output conforms to the declared output schema. */
export function call<I extends ObjectSchema, O extends ObjectSchema>(
  spec: ToolSpec<I, O>,
  ctx: ToolContext,
  input: unknown,
): { data: z.output<O>; summary: string } {
  const result = invokeTool(spec, ctx, input);
  const check = spec.output.safeParse(result.data);
  if (!check.success) throw new Error(`${spec.name} output violates its schema: ${check.error.message}`);
  return result;
}

/** Assert that `fn` throws a ShopError with the given code (and reason, if provided). */
export function expectShopError(fn: () => unknown, code: ErrorCode, reason?: string): ShopError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a ShopError to be thrown").toBeInstanceOf(ShopError);
  const err = caught as ShopError;
  expect(err.code).toBe(code);
  if (reason) expect(err.reason).toBe(reason);
  return err;
}

export function count(db: Db, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

export function orderStatus(db: Db, id: number): string {
  return (db.prepare("SELECT status FROM orders WHERE id = ?").get(id) as { status: string }).status;
}

export function auditCount(db: Db): number {
  return count(db, "SELECT COUNT(*) AS n FROM audit_log");
}
