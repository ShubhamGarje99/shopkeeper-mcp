import type { ToolSession } from "../harness.js";
import type { Scenario } from "../scenarios.js";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentResult {
  finalText: string;
  /** Model turns (API requests) used; 0 for scripted agents. */
  turns: number;
  stopReason: string | null;
  usage: Usage | null;
  costUsd: number | null;
  /** Models that actually served the requests (differs from the requested model after a fallback). */
  servedBy: string[];
  refusal: { category: string | null } | null;
  /** Set when the run ended abnormally (max turns, max_tokens, API error...). */
  error: string | null;
}

export type Agent = (scenario: Scenario, session: ToolSession) => Promise<AgentResult>;

export interface AgentConfig {
  /** Results file label, e.g. "oracle", "baseline-naive", "live-claude-sonnet-5-5". */
  label: string;
  /** Display name in the report. */
  name: string;
  mode: "live" | "oracle" | "baseline";
  model: string | null;
  agent: Agent;
}

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export function scriptedResult(finalText: string, error: string | null = null): AgentResult {
  return { finalText, turns: 0, stopReason: null, usage: null, costUsd: 0, servedBy: [], refusal: null, error };
}
