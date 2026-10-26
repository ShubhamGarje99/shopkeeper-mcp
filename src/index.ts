#!/usr/bin/env node
/**
 * stdio entrypoint: `node dist/index.js`.
 * stdout carries MCP JSON-RPC only; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fixedClock, systemClock } from "./clock.js";
import { resolveRuntimeOptions, USAGE } from "./config.js";
import { openOrCreateDatabase } from "./db/connection.js";
import { createShopkeeperServer } from "./server.js";

async function main(): Promise<void> {
  let options;
  try {
    options = resolveRuntimeOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`[shopkeeper] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(64);
  }
  const { dbPath, now } = options;
  const clock = now ? fixedClock(now) : systemClock;
  const { db, created } = openOrCreateDatabase(dbPath);
  if (created) console.error(`[shopkeeper] no database found - created and seeded ${dbPath}`);

  const server = createShopkeeperServer({ db, clock, actor: "mcp:stdio" });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    console.error(`[shopkeeper] shutting down (${why})`);
    try {
      await server.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));

  await server.connect(transport);
  console.error(`[shopkeeper] ready on stdio (db: ${dbPath}${now ? `, clock pinned to ${now}` : ""})`);
}

main().catch((err) => {
  console.error("[shopkeeper] fatal:", err);
  process.exit(1);
});
