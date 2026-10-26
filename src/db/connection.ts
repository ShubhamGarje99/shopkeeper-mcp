import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.js";
import { seedDatabase } from "./seed.js";

export type Db = DatabaseSync;

function configure(db: Db): Db {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Open an existing database file (throws if it does not exist). */
export function openDatabase(file: string, opts: { readOnly?: boolean } = {}): Db {
  if (file !== ":memory:" && !fs.existsSync(file)) {
    throw new Error(`Database not found at ${file}. Run \`npm run seed\` to create it.`);
  }
  return configure(new DatabaseSync(file, { readOnly: opts.readOnly ?? false }));
}

/** Delete any existing file at `file`, then create schema + deterministic seed data. */
export function createSeededDatabase(file: string): Db {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
  const db = configure(new DatabaseSync(file));
  applySchema(db);
  seedDatabase(db);
  return db;
}

/**
 * Open the database, creating and seeding it on first run so a fresh clone
 * "just works" inside an MCP host. Returns whether it had to be created.
 */
export function openOrCreateDatabase(file: string): { db: Db; created: boolean } {
  if (file === ":memory:" || !fs.existsSync(file)) {
    return { db: createSeededDatabase(file), created: true };
  }
  return { db: openDatabase(file), created: false };
}

/**
 * Run `fn` inside a write transaction. `BEGIN IMMEDIATE` takes the write lock up
 * front so check-then-write sequences (refund guardrails) cannot interleave with
 * another writer.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
