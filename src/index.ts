#!/usr/bin/env node
/**
 * stdio entrypoint: `node dist/index.js`.
 * stdout carries MCP JSON-RPC only; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clockFromEnv } from "./clock.js";
import { resolveDbPath } from "./config.js";
import { openOrCreateDatabase } from "./db/connection.js";
import { createShopkeeperServer } from "./server.js";

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const { db, created } = openOrCreateDatabase(dbPath);
  if (created) console.error(`[shopkeeper] no database found - created and seeded ${dbPath}`);

  const server = createShopkeeperServer({ db, clock: clockFromEnv(), actor: "mcp:stdio" });
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
  console.error(`[shopkeeper] ready on stdio (db: ${dbPath})`);
}

main().catch((err) => {
  console.error("[shopkeeper] fatal:", err);
  process.exit(1);
});
