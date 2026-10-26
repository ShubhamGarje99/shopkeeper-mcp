/**
 * `npm run smoke` - spawn the built stdio server against a throwaway copy of the
 * seeded DB, list tools, and call a read and a guarded write. Requires `npm run build`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PROJECT_ROOT } from "../src/config.js";
import { SEED_REFERENCE_NOW } from "../src/db/seed.js";

const entry = path.join(PROJECT_ROOT, "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("dist/index.js not found - run `npm run build` first.");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shopkeeper-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...getDefaultEnvironment(), SHOPKEEPER_DB: path.join(dir, "shop.db"), SHOPKEEPER_NOW: SEED_REFERENCE_NOW },
  stderr: "pipe",
});
const client = new Client({ name: "shopkeeper-smoke", version: "0.1.0" });

const text = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`tools/list -> ${tools.length} tools`);
  for (const t of tools) {
    const a = t.annotations ?? {};
    console.log(`  ${t.name.padEnd(20)} ${a.readOnlyHint ? "read " : "WRITE"}  destructive=${a.destructiveHint} idempotent=${a.idempotentHint}`);
  }

  const order = (await client.callTool({ name: "get_order", arguments: { order_id: 1042 } })) as CallToolResult;
  console.log(`\nget_order(1042):\n${text(order).split("\n").slice(0, 4).join("\n")}`);

  const refused = (await client.callTool({
    name: "issue_refund",
    arguments: { order_id: 1010, amount_cents: 50_000, reason: "smoke test", idempotency_key: "smoke-1010-500" },
  })) as CallToolResult;
  console.log(`\nissue_refund(1010, $500.00) -> isError=${refused.isError}\n${text(refused)}`);
  console.log("\nSmoke test OK");
} finally {
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
