import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Repository root, derived from this module's location (works from src/ and dist/). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "shop.db");

/**
 * `SHOPKEEPER_DB` wins; relative values resolve against the current working
 * directory. The default lives inside the repo (not the cwd) so MCP hosts that
 * launch the server from `/` (e.g. Claude Desktop) still find the database.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SHOPKEEPER_DB?.trim();
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_DB_PATH;
}

export interface RuntimeOptions {
  dbPath: string;
  /** Pinned store clock (ISO 8601), if any. */
  now: string | undefined;
  /** "sqlite" (demo store, default) or "shopify" (live store; see README). */
  backend: "sqlite" | "shopify";
}

export const USAGE = `Usage: shopkeeper-mcp [--backend sqlite|shopify] [--db <path>] [--now <iso-timestamp>]
  --backend  sqlite = bundled demo store (default, or $SHOPKEEPER_BACKEND); shopify = live store, needs
             SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN (writes stay off unless SHOPKEEPER_SHOPIFY_WRITES=1)
  --db   SQLite file (default: $SHOPKEEPER_DB or <repo>/data/shop.db; created and seeded if missing)
  --now  pin the store clock, e.g. 2026-09-30T18:00:00Z (default: $SHOPKEEPER_NOW or wall-clock time)`;

/** CLI flags override environment variables, which override defaults. */
export function resolveRuntimeOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): RuntimeOptions {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: "string" }, now: { type: "string" }, backend: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const backend = (values.backend ?? env.SHOPKEEPER_BACKEND ?? "sqlite").trim();
  if (backend !== "sqlite" && backend !== "shopify") {
    throw new Error(`--backend must be 'sqlite' or 'shopify', got '${backend}'`);
  }
  return {
    backend,
    dbPath: values.db ? path.resolve(values.db) : resolveDbPath(env),
    now: values.now?.trim() || env.SHOPKEEPER_NOW?.trim() || undefined,
  };
}

export const SERVER_NAME = "shopkeeper";
export const SERVER_VERSION = "0.1.0";
