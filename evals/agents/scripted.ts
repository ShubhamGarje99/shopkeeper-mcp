/**
 * Agents that need no API key:
 *   - oracle: each scenario's known-good tool sequence (must score 15/15)
 *   - noop:   answers without calling any tool (lower bound)
 *   - naive:  a keyword-driven "blind tool caller" with no judgement. It shows
 *             which scenarios a literal, unthinking agent can pass and which
 *             ones genuinely require judgement.
 */
import type { ToolCallRecord } from "../harness.js";
import { scriptedResult, type Agent } from "./types.js";

export const oracleAgent: Agent = async (scenario, session) => {
  try {
    return scriptedResult(await scenario.oracle(session));
  } catch (err) {
    return scriptedResult("", err instanceof Error ? err.message : String(err));
  }
};

export const noopAgent: Agent = async () => scriptedResult("Sorry, I can't help with that right now.");

const firstText = (r: ToolCallRecord) => r.texts[0] ?? "";

export const naiveAgent: Agent = async (scenario, session) => {
  const prompt = scenario.prompt;
  const orderId = [...prompt.matchAll(/\b(1[0-2]\d\d)\b/g)].map((m) => Number(m[1])).find((n) => n >= 1001 && n <= 1200);
  const dollars = prompt.match(/\$(\d+(?:\.\d{1,2})?)/);

  if (orderId === undefined) {
    return scriptedResult("I couldn't find an order number in that request.");
  }
  if (/refund/i.test(prompt)) {
    const order = await session.call("get_order", { order_id: orderId });
    const total = Number((order.structured?.financials as { total_cents?: number } | undefined)?.total_cents ?? 0);
    const amount = dollars ? Math.round(Number(dollars[1]) * 100) : total;
    const res = await session.call("issue_refund", {
      order_id: orderId,
      amount_cents: Math.max(1, amount),
      reason: "Customer request",
      idempotency_key: `naive-${orderId}-${amount}`,
    });
    return scriptedResult(firstText(res));
  }
  if (/invoice/i.test(prompt)) return scriptedResult(firstText(await session.call("create_invoice", { order_id: orderId })));
  if (/delivered/i.test(prompt)) {
    return scriptedResult(firstText(await session.call("update_order_status", { order_id: orderId, status: "delivered" })));
  }
  if (/shipped/i.test(prompt)) {
    return scriptedResult(firstText(await session.call("update_order_status", { order_id: orderId, status: "shipped" })));
  }
  return scriptedResult(firstText(await session.call("get_order", { order_id: orderId })));
};
