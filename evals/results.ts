import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.js";
import type { AgentResult, Usage } from "./agents/types.js";
import type { Check } from "./graders.js";

export const RESULTS_DIR = path.join(PROJECT_ROOT, "evals", "results");
export const ARCHIVE_DIR = path.join(RESULTS_DIR, "runs");
export const REPORT_FILE = path.join(PROJECT_ROOT, "EVAL_REPORT.md");

export interface TrialResult {
  trial: number;
  passed: boolean;
  checks: Check[];
  failed: string[];
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    isError: boolean;
    errorCode: string | null;
    errorReason: string | null;
  }>;
  finalText: string;
  turns: number;
  stopReason: string | null;
  usage: Usage | null;
  costUsd: number | null;
  servedBy: string[];
  refusal: AgentResult["refusal"];
  error: string | null;
  dbChanges: string;
  durationMs: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  category: string;
  prompt: string;
  passCount: number;
  trials: TrialResult[];
}

export interface RunResults {
  label: string;
  name: string;
  mode: "live" | "oracle" | "baseline";
  model: string | null;
  effort: string | null;
  startedAt: string;
  finishedAt: string;
  gitSha: string | null;
  clock: string;
  trialsPerScenario: number;
  subset: boolean;
  summary: {
    scenarios: number;
    scenariosPassedAllTrials: number;
    trialPasses: number;
    trialTotal: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
  };
  scenarios: ScenarioResult[];
}

export function saveResults(results: RunResults): { latest: string; archive: string } {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const latest = path.join(RESULTS_DIR, `${results.label}.json`);
  const stamp = results.startedAt.replace(/[:.]/g, "-");
  const archive = path.join(ARCHIVE_DIR, `${stamp}-${results.label}.json`);
  const json = `${JSON.stringify(results, null, 2)}\n`;
  fs.writeFileSync(latest, json);
  fs.writeFileSync(archive, json);
  return { latest, archive };
}

export function loadAllResults(): RunResults[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8")) as RunResults);
}
