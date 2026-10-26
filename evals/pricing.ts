/** USD per million tokens (first-party Claude API list prices). */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Cost of one response. Cache writes bill at 1.25x input, cache reads at 0.1x. Null for unknown models. */
export function costUsd(model: string, u: TokenUsage): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const input = u.input_tokens * p.input + u.cache_creation_input_tokens * p.input * 1.25 + u.cache_read_input_tokens * p.input * 0.1;
  return (input + u.output_tokens * p.output) / 1_000_000;
}
