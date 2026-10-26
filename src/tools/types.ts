import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { ValidationError } from "../errors.js";

export interface ToolContext {
  db: Db;
  clock: Clock;
  /** Recorded in the audit log for every write. */
  actor: string;
}

export interface ToolOutcome<T> {
  /** Structured result (validated against the tool's output schema). */
  data: T;
  /** Short human/LLM-readable summary, sent as the first text content block. */
  summary: string;
}

export type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolSpec<I extends ObjectSchema = ObjectSchema, O extends ObjectSchema = ObjectSchema> {
  name: string;
  title: string;
  description: string;
  kind: "read" | "write";
  input: I;
  output: O;
  annotations: ToolAnnotations;
  handler: (ctx: ToolContext, input: z.output<I>) => ToolOutcome<z.output<O>>;
}

/** Identity helper that preserves the input/output generics for inference. */
export function defineTool<I extends ObjectSchema, O extends ObjectSchema>(spec: ToolSpec<I, O>): ToolSpec<I, O> {
  return spec;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function readOnlyAnnotations(title: string): ToolAnnotations {
  return { title, ...READ_ONLY };
}

export function writeAnnotations(title: string, opts: { destructive: boolean; idempotent: boolean }): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: opts.destructive,
    idempotentHint: opts.idempotent,
    openWorldHint: false,
  };
}

/**
 * Validate raw input against the tool schema and run it. Used by the MCP layer
 * (after the SDK's own validation) and directly by unit tests, so both paths
 * share exactly the same rules.
 */
export function invokeTool<I extends ObjectSchema, O extends ObjectSchema>(
  spec: ToolSpec<I, O>,
  ctx: ToolContext,
  rawInput: unknown,
): ToolOutcome<z.output<O>> {
  const parsed = spec.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ValidationError("INVALID_INPUT", `Invalid arguments for ${spec.name}: ${z.prettifyError(parsed.error)}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return spec.handler(ctx, parsed.data);
}

// Shared field schemas -------------------------------------------------------

export const orderIdField = z.number().int().min(1).describe("Numeric order ID, e.g. 1042.");

function isRealCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Compact pattern in the advertised JSON Schema; calendar validity checked by refine. */
export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine(isRealCalendarDate, "Not a real calendar date.")
  .describe("Calendar date, YYYY-MM-DD.");
