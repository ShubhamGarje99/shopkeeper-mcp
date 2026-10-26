import path from "node:path";
import { fileURLToPath } from "node:url";

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

export const SERVER_NAME = "shopkeeper";
export const SERVER_VERSION = "0.1.0";
