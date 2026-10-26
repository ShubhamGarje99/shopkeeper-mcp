/**
 * Eval CLI.
 *
 *   npm run eval            live Claude agent (needs ANTHROPIC_API_KEY)
 *                           flags: --model <id> --effort low|medium|high --only <id,id> --trials N --max-turns N
 *   npm run eval:oracle     scripted known-good tool sequences (no key)
 *   npm run eval:baseline   no-op + naive agents (no key); --agent noop|naive for one
 *   npm run eval:report     re-render EVAL_REPORT.md from saved results
 *
 * Common flags: --no-build (skip `npm run build`), --keep (keep per-scenario DBs in evals/.tmp)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { PROJECT_ROOT } from "../src/config.js";
import { createSeededDatabase } from "../src/db/connection.js";
import { createClaudeAgent } from "./agents/claude.js";
import { naiveAgent, noopAgent, oracleAgent } from "./agents/scripted.js";
import { scriptedResult, type AgentConfig, type AgentResult } from "./agents/types.js";
import { DEFAULT_EFFORT, DEFAULT_LIVE_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_MAX_TURNS, EVAL_CLOCK } from "./config.js";
import { describeDiff, diffSnapshots, snapshot } from "./db-snapshot.js";
import { check, type Check } from "./graders.js";
import { SERVER_ENTRY, withServerSession, type ToolCallRecord } from "./harness.js";
import { writeReport } from "./report.js";
import { saveResults, type RunResults, type ScenarioResult, type TrialResult } from "./results.js";
import { SCENARIOS } from "./scenarios.js";

const { values: args } = parseArgs({
  options: {
    mode: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    only: { type: "string" },
    trials: { type: "string", default: "1" },
    "max-turns": { type: "string" },
    agent: { type: "string" },
    "no-build": { type: "boolean", default: false },
    "report-only": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]?.replace(/^\/\*\*?/, "").replace(/^ \* ?/gm, ""));
  process.exit(0);
}

if (args["report-only"]) {
  console.log(`Wrote ${path.relative(PROJECT_ROOT, writeReport())}`);
  process.exit(0);
}

const mode = args.mode;
if (mode !== "live" && mode !== "oracle" && mode !== "baseline") fail("--mode must be live, oracle or baseline (see --help).");

// --- Fail fast on a missing key before doing any work -------------------------
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
if (mode === "live" && !process.env.ANTHROPIC_API_KEY?.trim() && !process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
  fail(
    [
      "ANTHROPIC_API_KEY is not set, so the live Claude eval cannot run.",
      "  -> Add it to .env:  cp .env.example .env  and set ANTHROPIC_API_KEY=sk-ant-...",
      "     (or export ANTHROPIC_API_KEY in your shell), then re-run `npm run eval`.",
      "  No key needed for: npm run eval:oracle | npm run eval:baseline | npm test",
    ].join("\n"),
    2,
  );
}

const trials = Number(args.trials);
if (!Number.isInteger(trials) || trials < 1 || trials > 20) fail("--trials must be an integer from 1 to 20.");
const only = args.only ? new Set(args.only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
if (only) {
  const unknown = [...only].filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length) fail(`Unknown scenario id(s): ${unknown.join(", ")}\nKnown: ${SCENARIOS.map((s) => s.id).join(", ")}`);
}
const scenarios = only ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;

// --- Agents --------------------------------------------------------------------
function agentConfigs(): AgentConfig[] {
  if (mode === "oracle") return [{ label: "oracle", name: "Oracle (scripted known-good)", mode: "oracle", model: null, agent: oracleAgent }];
  if (mode === "baseline") {
    const all: AgentConfig[] = [
      { label: "baseline-naive", name: "Naive keyword agent", mode: "baseline", model: null, agent: naiveAgent },
      { label: "baseline-noop", name: "No-op agent", mode: "baseline", model: null, agent: noopAgent },
    ];
    if (!args.agent) return all;
    const picked = all.filter((c) => c.label === `baseline-${args.agent}`);
    if (!picked.length) fail("--agent must be noop or naive.");
    return picked;
  }
  const model = args.model ?? process.env.CLAUDE_MODEL?.trim() ?? DEFAULT_LIVE_MODEL;
  const effort = (args.effort ?? process.env.CLAUDE_EFFORT?.trim() ?? DEFAULT_EFFORT) as "low" | "medium" | "high";
  if (!["low", "medium", "high"].includes(effort)) fail("--effort must be low, medium or high.");
  const maxTurns = Number(args["max-turns"] ?? DEFAULT_MAX_TURNS);
  const fallbacks = (process.env.CLAUDE_FALLBACKS ?? "on").trim().toLowerCase() !== "off";
  return [
    {
      label: `live-${model}`,
      name: "Claude agent (live)",
      mode: "live",
      model: `${model}`,
      agent: createClaudeAgent({ model, effort, maxTurns, maxTokens: DEFAULT_MAX_TOKENS, fallbacks, today: EVAL_CLOCK.slice(0, 10) }),
    },
  ];
}

function gitSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ".", ":!evals/results", ":!EVAL_REPORT.md"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

// --- Main ------------------------------------------------------------------------
async function main(): Promise<void> {
  const configs = agentConfigs();

  if (!args["no-build"]) {
    console.log("Building server (npm run build)...");
    execFileSync("npm", ["run", "build", "--silent"], { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
  if (!fs.existsSync(SERVER_ENTRY)) fail(`${SERVER_ENTRY} missing - run \`npm run build\`.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(PROJECT_ROOT, "evals", ".tmp", stamp);
  fs.mkdirSync(runDir, { recursive: true });
  const templateFile = path.join(runDir, "template.db");
  createSeededDatabase(templateFile).close();
  const before = new DatabaseSync(templateFile, { readOnly: true });
  const beforeSnap = snapshot(before);
  const sha = gitSha();
  let oracleFailures = 0;

  try {
    for (const cfg of configs) {
      console.log(`\n== ${cfg.name}${cfg.model ? ` [${cfg.model}]` : ""}: ${scenarios.length} scenario(s) x ${trials} trial(s)`);
      const startedAt = new Date().toISOString();
      const results: ScenarioResult[] = [];

      for (const scenario of scenarios) {
        const trialResults: TrialResult[] = [];
        for (let trial = 1; trial <= trials; trial++) {
          const dbFile = path.join(runDir, `${cfg.label}-${scenario.id}-t${trial}.db`);
          fs.copyFileSync(templateFile, dbFile);
          const t0 = performance.now();

          let agentResult: AgentResult;
          let trace: ToolCallRecord[] = [];
          try {
            const out = await withServerSession({ dbFile, clockIso: EVAL_CLOCK }, (session) => cfg.agent(scenario, session));
            agentResult = out.value;
            trace = out.trace;
          } catch (err) {
            if (err instanceof Anthropic.AuthenticationError) {
              fail(`The Claude API rejected the credentials (401). Check ANTHROPIC_API_KEY in .env.\n${err.message}`, 2);
            }
            agentResult = scriptedResult("", err instanceof Error ? err.message : String(err));
          }

          const after = new DatabaseSync(dbFile, { readOnly: true });
          const diff = diffSnapshots(beforeSnap, snapshot(after));
          let checks: Check[];
          try {
            checks = scenario.grade({ before, after, diff, trace, answer: agentResult.finalText });
          } catch (err) {
            checks = [check("grader: ran without crashing", false, err instanceof Error ? err.message : String(err))];
          }
          after.close();
          if (agentResult.error) checks.push(check("run: agent finished normally", false, agentResult.error));

          const passed = checks.every((c) => c.pass);
          const durationMs = Math.round(performance.now() - t0);
          trialResults.push({
            trial,
            passed,
            checks,
            failed: checks.filter((c) => !c.pass).map((c) => c.name),
            toolCalls: trace.map((c) => ({ name: c.name, args: c.args, isError: c.isError, errorCode: c.errorCode, errorReason: c.errorReason })),
            finalText: agentResult.finalText,
            turns: agentResult.turns,
            stopReason: agentResult.stopReason,
            usage: agentResult.usage,
            costUsd: agentResult.costUsd,
            servedBy: agentResult.servedBy,
            refusal: agentResult.refusal,
            error: agentResult.error,
            dbChanges: describeDiff(diff),
            durationMs,
          });

          const tag = passed ? "PASS" : "FAIL";
          const trialTag = trials > 1 ? ` t${trial}` : "";
          const cost = agentResult.costUsd ? `, $${agentResult.costUsd.toFixed(4)}` : "";
          console.log(`  ${tag}  ${scenario.id}${trialTag}  (${trace.length} tool calls, ${(durationMs / 1000).toFixed(1)}s${cost})`);
          for (const c of checks.filter((x) => !x.pass)) console.log(`        x ${c.name}${c.detail ? ` -- ${c.detail}` : ""}`);
        }
        results.push({
          id: scenario.id,
          title: scenario.title,
          category: scenario.category,
          prompt: scenario.prompt,
          passCount: trialResults.filter((t) => t.passed).length,
          trials: trialResults,
        });
      }

      const all = results.flatMap((r) => r.trials);
      const costs = all.map((t) => t.costUsd);
      const run: RunResults = {
        label: cfg.label,
        name: cfg.name,
        mode: cfg.mode,
        model: cfg.model,
        effort: cfg.mode === "live" ? (args.effort ?? process.env.CLAUDE_EFFORT?.trim() ?? DEFAULT_EFFORT) : null,
        startedAt,
        finishedAt: new Date().toISOString(),
        gitSha: sha,
        clock: EVAL_CLOCK,
        trialsPerScenario: trials,
        subset: scenarios.length !== SCENARIOS.length,
        summary: {
          scenarios: results.length,
          scenariosPassedAllTrials: results.filter((r) => r.passCount === r.trials.length).length,
          trialPasses: all.filter((t) => t.passed).length,
          trialTotal: all.length,
          toolCalls: all.reduce((a, t) => a + t.toolCalls.length, 0),
          inputTokens: all.reduce((a, t) => a + (t.usage?.input_tokens ?? 0), 0),
          outputTokens: all.reduce((a, t) => a + (t.usage?.output_tokens ?? 0), 0),
          cacheReadTokens: all.reduce((a, t) => a + (t.usage?.cache_read_input_tokens ?? 0), 0),
          cacheWriteTokens: all.reduce((a, t) => a + (t.usage?.cache_creation_input_tokens ?? 0), 0),
          costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((a, c) => a + (c ?? 0), 0),
        },
        scenarios: results,
      };
      const saved = saveResults(run);
      const s = run.summary;
      console.log(
        `-> ${cfg.name}: ${s.scenariosPassedAllTrials}/${s.scenarios} scenarios passed (${s.trialPasses}/${s.trialTotal} trials)` +
          (cfg.mode === "live" ? `, ${s.inputTokens} in / ${s.outputTokens} out tokens, $${(s.costUsd ?? 0).toFixed(4)}` : ""),
      );
      console.log(`   saved ${path.relative(PROJECT_ROOT, saved.latest)}`);
      if (cfg.mode === "oracle") oracleFailures += s.scenarios - s.scenariosPassedAllTrials;
    }
  } finally {
    before.close();
    if (!args.keep) fs.rmSync(runDir, { recursive: true, force: true });
    else console.log(`Kept scenario databases in ${path.relative(PROJECT_ROOT, runDir)}`);
  }

  console.log(`Wrote ${path.relative(PROJECT_ROOT, writeReport())}`);
  // The oracle is a self-test of server + graders: anything below 100% is a harness bug.
  if (oracleFailures > 0) fail(`Oracle failed ${oracleFailures} scenario(s): the server or the graders are wrong.`);
}

main().catch((err) => fail(`Eval run crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
