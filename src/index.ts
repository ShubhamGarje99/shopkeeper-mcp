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
import { ShopifyClient } from "./shopify/client.js";
import { resolveShopifySettings } from "./shopify/config.js";
import { createShopifyServer } from "./shopify/server.js";
import { ShopifyStore } from "./shopify/store.js";

async function main(): Promise<void> {
  let options;
  try {
    options = resolveRuntimeOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`[shopkeeper] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(64);
  }
  const { dbPath, now, backend } = options;
  const clock = now ? fixedClock(now) : systemClock;

  let server;
  let closeBackend = () => {};
  let ready: string;
  if (backend === "shopify") {
    let settings;
    try {
      settings = resolveShopifySettings();
    } catch (err) {
      console.error(`[shopkeeper] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
      process.exit(64);
    }
    const store = new ShopifyStore(new ShopifyClient(settings));
    server = createShopifyServer({ store, settings, clock, actor: "mcp:stdio" }, settings.shop);
    ready = `shopify ${settings.shop}, api ${settings.apiVersion}, auth ${settings.adminToken ? "static token" : "client credentials"}, writes ${settings.writesEnabled ? "ENABLED" : "disabled (read-only)"}`;
  } else {
    const { db, created } = openOrCreateDatabase(dbPath);
    if (created) console.error(`[shopkeeper] no database found - created and seeded ${dbPath}`);
    server = createShopkeeperServer({ db, clock, actor: "mcp:stdio" });
    closeBackend = () => db.close();
    ready = `db: ${dbPath}`;
  }
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    console.error(`[shopkeeper] shutting down (${why})`);
    try {
      await server.close();
    } finally {
      closeBackend();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));

  await server.connect(transport);
  console.error(`[shopkeeper] ready on stdio (${ready}${now ? `, clock pinned to ${now}` : ""})`);
}

main().catch((err) => {
  console.error("[shopkeeper] fatal:", err);
  process.exit(1);
});
