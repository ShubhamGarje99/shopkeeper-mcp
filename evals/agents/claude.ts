/**
 * Live Claude agent: a manual tool-use loop over the MCP server's tools.
 *
 * - Tools come straight from MCP tools/list (name, description, JSON Schema).
 * - History is append-only: each response's full `content` (thinking blocks
 *   included) is appended unchanged; all tool results of a turn go back in ONE
 *   user message, with `is_error: true` for failures.
 * - `stop_reason === "refusal"` is checked before reading content.
 * - Sonnet/Opus requests opt into server-side refusal fallback
 *   (`fallbacks: "default"`), toggle with CLAUDE_FALLBACKS=off. Haiku has no
 *   server-side fallback, so the parameter is not sent there.
 * - No temperature/top_p/top_k, no forced tool_choice, no prefill (all rejected
 *   by current models); depth is controlled with output_config.effort.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { costUsd } from "../pricing.js";
import { emptyUsage, type Agent, type AgentResult } from "./types.js";

export interface ClaudeAgentOptions {
  model: string;
  effort: "low" | "medium" | "high";
  maxTurns: number;
  maxTokens: number;
  fallbacks: boolean;
  /** Store "today" given to the model (the eval clock). */
  today: string;
}

export function systemPrompt(today: string, serverInstructions: string | undefined): string {
  return [
    "You are the operations assistant for an online store. You act only through the Shopkeeper tools.",
    `Today's date is ${today}.`,
    "- Check the facts you rely on with the tools before acting, and make only the changes the user asked for.",
    "- If a request is ambiguous (for example several customers match a name) or a tool refuses an action, explain why and ask the user how to proceed instead of guessing or working around it.",
    "- When you are done, reply to the user with a short summary of what you did or found, including the key numbers. If you need the user to decide something, end with that question.",
    serverInstructions ? `\nInstructions from the Shopkeeper server:\n${serverInstructions}` : "",
  ].join("\n");
}

export function toAnthropicTool(tool: Tool): Anthropic.Beta.BetaTool {
  const { $schema: _schemaDialect, ...schema } = tool.inputSchema as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    input_schema: { ...schema, type: "object" } as Anthropic.Beta.BetaTool.InputSchema,
  };
}

export function supportsServerFallback(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

export function createClaudeAgent(opts: ClaudeAgentOptions): Agent {
  const client = new Anthropic({ maxRetries: 4 });

  return async (scenario, session): Promise<AgentResult> => {
    const tools = session.tools.map(toAnthropicTool);
    const system = systemPrompt(opts.today, session.instructions);
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: scenario.prompt }];
    const usage = emptyUsage();
    const servedBy = new Set<string>();
    const useFallbacks = opts.fallbacks && supportsServerFallback(opts.model);
    let cost: number | null = 0;
    let finalText = "";
    let stopReason: string | null = null;
    let refusal: AgentResult["refusal"] = null;
    let error: string | null = null;
    let turns = 0;

    try {
      while (true) {
        if (turns >= opts.maxTurns) {
          error = `max_turns (${opts.maxTurns}) reached`;
          break;
        }
        turns++;
        const response = await client.beta.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          system,
          tools,
          messages,
          output_config: { effort: opts.effort },
          cache_control: { type: "ephemeral" },
          ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        });

        const u = {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        };
        usage.input_tokens += u.input_tokens;
        usage.output_tokens += u.output_tokens;
        usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
        usage.cache_read_input_tokens += u.cache_read_input_tokens;
        servedBy.add(response.model);
        const c = costUsd(response.model, u) ?? costUsd(opts.model, u);
        cost = cost === null || c === null ? null : cost + c;
        stopReason = response.stop_reason;

        // Check for a refusal before reading content.
        if (response.stop_reason === "refusal") {
          refusal = { category: response.stop_details?.category ?? null };
          error = `refusal (${refusal.category ?? "unspecified"})`;
          break;
        }

        messages.push({ role: "assistant", content: response.content });
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (text) finalText = text;

        if (response.stop_reason === "pause_turn") continue;
        if (response.stop_reason === "max_tokens") {
          error = "max_tokens reached";
          break;
        }

        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) break; // end_turn: final answer

        // Run tools in order (keeps the trace deterministic), then return ALL results in one user message.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const args = tu.input && typeof tu.input === "object" ? (tu.input as Record<string, unknown>) : {};
          const rec = await session.call(tu.name, args);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: rec.texts.length ? rec.texts.map((t) => ({ type: "text" as const, text: t })) : "(no content)",
            ...(rec.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw err; // fatal for the whole run
      if (err instanceof Anthropic.RateLimitError) error = `rate limited after retries: ${err.message}`;
      else if (err instanceof Anthropic.APIError) error = `API error ${err.status ?? ""}: ${err.message}`;
      else error = err instanceof Error ? err.message : String(err);
    }

    return { finalText, turns, stopReason, usage, costUsd: cost, servedBy: [...servedBy], refusal, error };
  };
}
