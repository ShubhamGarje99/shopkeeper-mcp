/**
 * Runs one scenario attempt against the REAL server: copies the seeded template
 * database, spawns `node dist/index.js` over stdio, connects the MCP SDK Client,
 * and records every tool call the agent makes.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PROJECT_ROOT } from "../src/config.js";

export const SERVER_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

export interface ToolCallRecord {
  index: number;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** NOT_FOUND | VALIDATION_ERROR | GUARDRAIL_VIOLATION | CONFLICT | INTERNAL_ERROR | PROTOCOL_ERROR, null on success. */
  errorCode: string | null;
  errorReason: string | null;
  /** Text content blocks as returned by the server (what the model sees). */
  texts: string[];
  structured: Record<string, unknown> | null;
  durationMs: number;
}

/** Classify an isError result: our JSON envelope, or the SDK's schema-validation text. */
function classifyError(texts: string[]): { code: string; reason: string | null } {
  for (const t of texts) {
    try {
      const parsed = JSON.parse(t) as { error?: { code?: string; reason?: string } };
      if (parsed.error?.code) return { code: parsed.error.code, reason: parsed.error.reason ?? null };
    } catch {
      // not JSON
    }
  }
  if (texts.some((t) => /Input validation error/i.test(t))) return { code: "VALIDATION_ERROR", reason: "SCHEMA" };
  return { code: "UNKNOWN_ERROR", reason: null };
}

/** A connected MCP session whose tool calls are traced. */
export class ToolSession {
  readonly trace: ToolCallRecord[] = [];

  constructor(
    private readonly client: Client,
    readonly tools: Tool[],
    readonly instructions: string | undefined,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const started = performance.now();
    let record: ToolCallRecord;
    try {
      const res = (await this.client.callTool({ name, arguments: args })) as CallToolResult;
      const texts = res.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
      const err = res.isError ? classifyError(texts) : null;
      record = {
        index: this.trace.length,
        name,
        args,
        isError: res.isError === true,
        errorCode: err?.code ?? null,
        errorReason: err?.reason ?? null,
        texts,
        structured: (res.structuredContent as Record<string, unknown> | undefined) ?? null,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (e) {
      // Protocol-level failure (e.g. connection lost). Surface it to the agent as a tool error.
      record = {
        index: this.trace.length,
        name,
        args,
        isError: true,
        errorCode: "PROTOCOL_ERROR",
        errorReason: null,
        texts: [e instanceof Error ? e.message : String(e)],
        structured: null,
        durationMs: Math.round(performance.now() - started),
      };
    }
    this.trace.push(record);
    return record;
  }
}

export interface SessionOptions {
  dbFile: string;
  clockIso: string;
}

/** Spawn the built server on `dbFile`, run `fn`, and always shut the server down. */
export async function withServerSession<T>(
  opts: SessionOptions,
  fn: (session: ToolSession) => Promise<T>,
): Promise<{ value: T; trace: ToolCallRecord[]; stderr: string }> {
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} not found - run \`npm run build\`.`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...getDefaultEnvironment(), SHOPKEEPER_DB: opts.dbFile, SHOPKEEPER_NOW: opts.clockIso },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "shopkeeper-evals", version: "0.1.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const session = new ToolSession(client, tools, client.getInstructions());
    const value = await fn(session);
    return { value, trace: session.trace, stderr };
  } finally {
    await client.close();
  }
}
