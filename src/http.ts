#!/usr/bin/env node
/**
 * Optional Streamable HTTP entrypoint: `node dist/http.js` -> POST http://127.0.0.1:3333/mcp
 *
 * Stateless mode (a fresh McpServer + transport per request, shared SQLite handle).
 * There is no authentication, so it binds to loopback only and rejects requests
 * whose Host/Origin is not local (DNS-rebinding protection). Put a real auth
 * layer in front before exposing it anywhere else.
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clockFromEnv } from "./clock.js";
import { resolveDbPath } from "./config.js";
import { openOrCreateDatabase } from "./db/connection.js";
import { createShopkeeperServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = "127.0.0.1";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLocal(value: string | undefined, kind: "host" | "origin"): boolean {
  if (!value) return kind === "origin"; // non-browser clients send no Origin
  try {
    const url = new URL(kind === "origin" ? value : `http://${value}`);
    return LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

const dbPath = resolveDbPath();
const { db, created } = openOrCreateDatabase(dbPath);
if (created) console.error(`[shopkeeper] no database found - created and seeded ${dbPath}`);
const clock = clockFromEnv();

const httpServer = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
  if (path !== "/mcp") return jsonRpcError(res, 404, "Not found. The MCP endpoint is POST /mcp.");
  if (!isLocal(req.headers.host, "host") || !isLocal(req.headers.origin, "origin")) {
    return jsonRpcError(res, 403, "Forbidden: non-local Host/Origin.");
  }
  if (req.method !== "POST") return jsonRpcError(res, 405, "Method not allowed (stateless server: POST only).");

  const server = createShopkeeperServer({ db, clock, actor: "mcp:http" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[shopkeeper] http request failed:", err);
    if (!res.headersSent) jsonRpcError(res, 500, "Internal server error.");
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[shopkeeper] Streamable HTTP on http://${HOST}:${PORT}/mcp (db: ${dbPath})`);
});

const stop = () => {
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
