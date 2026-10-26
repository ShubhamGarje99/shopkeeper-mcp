/**
 * End-to-end: spawn the real server process over stdio (src/index.ts via tsx,
 * so no build is needed) and talk to it with the official MCP SDK Client.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/config.js";
import { NOW } from "./helpers.js";

describe("stdio server (integration)", () => {
  let dir: string;
  let dbFile: string;
  let client: Client;
  let stderr = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shopkeeper-stdio-"));
    dbFile = path.join(dir, "shop.db"); // does not exist yet: the server must create + seed it
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(PROJECT_ROOT, "src", "index.ts")],
      cwd: PROJECT_ROOT,
      env: { ...getDefaultEnvironment(), SHOPKEEPER_DB: dbFile, SHOPKEEPER_NOW: NOW },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("initializes, auto-seeds a missing database, and logs only to stderr", async () => {
    expect(client.getServerVersion()?.name).toBe("shopkeeper");
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(stderr).toMatch(/created and seeded/);
  });

  it("lists tools and calls a read tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    const res = (await client.callTool({ name: "low_stock_alerts", arguments: {} })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ count: 6 });
  });

  it("enforces guardrails and idempotency across the process boundary", async () => {
    const over = (await client.callTool({
      name: "issue_refund",
      arguments: { order_id: 1010, amount_cents: 50_000, reason: "too much", idempotency_key: "stdio-1010-over" },
    })) as CallToolResult;
    expect(over.isError).toBe(true);

    const args = { order_id: 1042, amount_cents: 10_500, reason: "late delivery", idempotency_key: "stdio-1042-late" };
    const first = (await client.callTool({ name: "issue_refund", arguments: args })) as CallToolResult;
    const retry = (await client.callTool({ name: "issue_refund", arguments: args })) as CallToolResult;
    expect(first.structuredContent).toMatchObject({ replayed: false, order: { status: "refunded" } });
    expect(retry.structuredContent).toMatchObject({ replayed: true });

    // Inspect the file the server wrote (read-only handle, server still running).
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("SELECT order_id, amount_cents FROM refunds WHERE order_id IN (1010, 1042)").all();
    db.close();
    expect(rows.map((r) => ({ ...r }))).toEqual([{ order_id: 1042, amount_cents: 10_500 }]);
  });
});
