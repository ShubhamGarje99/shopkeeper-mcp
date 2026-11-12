import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "../config.js";
import { ShopError, toErrorEnvelope } from "../errors.js";
import { invokeShopifyTool, SHOPIFY_TOOLS, type ShopifyToolContext, type ShopifyToolSpec } from "./tools.js";

export const SHOPIFY_INSTRUCTIONS = `Shopkeeper is connected to a LIVE Shopify store. Actions here affect real orders and real money.
Conventions: money is integer minor units of the order's currency (1050 = 10.50 for USD; the currency is in each result); dates are YYYY-MM-DD (UTC); order IDs are Shopify order numbers such as 1042 (for "#1042").
- Read before you write: call get_order to see status, refunds and the refundable amount before changing an order.
- Only change data when the user asked for that exact change. Answer questions with the read-only tools. Confirm the order, amount and reason with the user before issue_refund unless they gave them explicitly.
- issue_refund: amount_cents must not exceed financials.refundable_cents. Send a new idempotency_key for each distinct refund; reuse a key only to retry that same refund.
- If a name matches several customers (search_customers -> ambiguous: true), ask the user which one before acting.
- If a result says pending_confirmation, the change may still be processing: re-check with get_order before telling the user it is done.
- Errors come back as JSON {"error":{"code","reason","message","details"}}. GUARDRAIL_VIOLATION and CONFLICT mean the action is not allowed as asked; WRITES_DISABLED means the store owner has made this connection read-only. Report these to the user instead of working around them.`;

export async function runShopifyToolForMcp(spec: ShopifyToolSpec, ctx: ShopifyToolContext, args: unknown): Promise<CallToolResult> {
  try {
    const { data, summary } = await invokeShopifyTool(spec, ctx, args);
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data) },
      ],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (err) {
    if (!(err instanceof ShopError)) console.error(`[shopkeeper] ${spec.name} failed:`, err instanceof Error ? err.message : err);
    return { content: [{ type: "text", text: JSON.stringify(toErrorEnvelope(err)) }], isError: true };
  }
}

export function createShopifyServer(ctx: ShopifyToolContext, shopLabel: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: `Shopkeeper (Shopify: ${shopLabel})` },
    { instructions: SHOPIFY_INSTRUCTIONS },
  );
  for (const spec of SHOPIFY_TOOLS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.input, outputSchema: spec.output, annotations: spec.annotations },
      async (args: unknown) => runShopifyToolForMcp(spec, ctx, args),
    );
  }
  return server;
}
