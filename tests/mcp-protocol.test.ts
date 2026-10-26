/**
 * Protocol-level behaviour through a real MCP Client (in-memory transport):
 * tool listing, annotations, structured output, and error mapping.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/db/seed.js";
import { createShopkeeperServer } from "../src/server.js";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools/index.js";
import { count, freshDb, type TestDb } from "./helpers.js";

describe("MCP protocol surface", () => {
  let t: TestDb;
  let client: Client;

  beforeEach(async () => {
    t = freshDb();
    const server = createShopkeeperServer(t.ctx);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientSide);
  });
  afterEach(async () => {
    await client.close();
    t.cleanup();
  });

  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const texts = (r: CallToolResult) => r.content.flatMap((c) => (c.type === "text" ? [c.text] : []));

  it("lists 8 tools with schemas and read/write annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.openWorldHint).toBe(false);
      const isWrite = WRITE_TOOL_NAMES.includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(!isWrite);
    }
    const byName = Object.fromEntries(tools.map((x) => [x.name, x.annotations]));
    expect(byName.issue_refund).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.update_order_status).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.create_invoice).toMatchObject({ destructiveHint: false });
  });

  it("advertises server instructions for hosts", () => {
    expect(client.getInstructions()).toMatch(/idempotency_key/);
  });

  it("returns a text summary, the JSON payload, and matching structuredContent", async () => {
    const res = await callTool("get_order", { order_id: FIXTURES.lateDelivery });
    expect(res.isError).toBeFalsy();
    const [summary, json] = texts(res);
    expect(summary).toMatch(/Order 1042/);
    expect(JSON.parse(json ?? "{}")).toEqual(res.structuredContent);
    expect(res.structuredContent).toMatchObject({ delivery: { status: "delivered_late", days_late: 3 } });
  });

  it("maps guardrail violations to isError + a machine-readable envelope (and no structuredContent)", async () => {
    const res = await callTool("issue_refund", {
      order_id: FIXTURES.smallDeliveredOrder,
      amount_cents: 50_000,
      reason: "Customer asked",
      idempotency_key: "refund-1010-500",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const envelope = JSON.parse(texts(res)[0] ?? "{}");
    expect(envelope.error).toMatchObject({ code: "GUARDRAIL_VIOLATION", reason: "REFUND_EXCEEDS_REFUNDABLE" });
    expect(envelope.error.message).toMatch(/\$500\.00 exceeds the refundable amount \$58\.95/);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE order_id = 1010")).toBe(0);
  });

  it("maps NOT_FOUND and CONFLICT the same way", async () => {
    const missing = await callTool("get_order", { order_id: 9999 });
    expect(JSON.parse(texts(missing)[0] ?? "{}").error.code).toBe("NOT_FOUND");
    const dup = await callTool("create_invoice", { order_id: FIXTURES.invoicedOrder });
    expect(dup.isError).toBe(true);
    expect(JSON.parse(texts(dup)[0] ?? "{}").error).toMatchObject({ code: "CONFLICT", reason: "INVOICE_ALREADY_EXISTS" });
  });

  it("rejects schema violations before any handler runs (unknown flags included)", async () => {
    const res = await callTool("issue_refund", {
      order_id: 1042,
      amount_cents: 100,
      reason: "test refund",
      idempotency_key: "refund-1042-dry",
      dry_run: true,
    });
    expect(res.isError).toBe(true);
    expect(texts(res).join(" ")).toMatch(/Input validation error/);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE order_id = 1042")).toBe(0);
  });

  it("replays an idempotent refund over the protocol", async () => {
    const args = { order_id: 1042, amount_cents: 10_500, reason: "late delivery", idempotency_key: "refund-1042-proto" };
    const first = await callTool("issue_refund", args);
    const second = await callTool("issue_refund", args);
    expect(first.structuredContent).toMatchObject({ replayed: false });
    expect(second.structuredContent).toMatchObject({ replayed: true });
    expect(count(t.db, "SELECT COUNT(*) AS n FROM refunds WHERE order_id = 1042")).toBe(1);
  });
});
