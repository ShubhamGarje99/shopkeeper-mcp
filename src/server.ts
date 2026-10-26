import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { ShopError, toErrorEnvelope } from "./errors.js";
import { ALL_TOOLS } from "./tools/index.js";
import { invokeTool, type ToolContext, type ToolSpec } from "./tools/types.js";

export const SERVER_INSTRUCTIONS = `Shopkeeper is the back office of "Kettle & Crema", a demo coffee & tea gear store (all data is fictional).
Conventions: money is integer cents (1050 = $10.50); dates are YYYY-MM-DD; order IDs are integers such as 1042.
- Read before you write: call get_order to see status, refunds, invoice and refundable amount before changing an order.
- Only change data when the user asked for that change. Answer questions with the read-only tools.
- issue_refund: amount_cents must not exceed financials.refundable_cents. Send a new idempotency_key for each distinct refund; reuse a key only to retry that same refund.
- If a name matches several customers (search_customers -> ambiguous: true), ask the user which one before acting.
- Errors come back as JSON {"error":{"code","reason","message","details"}}. GUARDRAIL_VIOLATION and CONFLICT mean the action is not allowed as asked: report it to the user instead of working around it.`;

/**
 * Convert a tool invocation into an MCP CallToolResult.
 * Success: a short text summary + the JSON payload, with the same payload in
 * `structuredContent` (validated against the tool's outputSchema).
 * Failure: `isError: true` with the JSON error envelope. No structuredContent on
 * errors - MCP clients validate structuredContent against the output schema.
 */
export function runToolForMcp(spec: ToolSpec, ctx: ToolContext, args: unknown): CallToolResult {
  try {
    const { data, summary } = invokeTool(spec, ctx, args);
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data) },
      ],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (err) {
    if (!(err instanceof ShopError)) {
      // Unexpected failure: log the stack to stderr (never stdout - that is the MCP channel).
      console.error(`[shopkeeper] ${spec.name} failed:`, err);
    }
    return { content: [{ type: "text", text: JSON.stringify(toErrorEnvelope(err)) }], isError: true };
  }
}

export function createShopkeeperServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Shopkeeper (Kettle & Crema demo store)" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const spec of ALL_TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        outputSchema: spec.output,
        annotations: spec.annotations,
      },
      async (args: unknown) => runToolForMcp(spec, ctx, args),
    );
  }
  return server;
}
