/**
 * Typed error hierarchy. Every domain failure a tool can produce is one of these
 * four classes; the MCP layer maps them to `isError: true` tool results carrying
 * a machine-readable envelope:
 *
 *   { "error": { "code": "GUARDRAIL_VIOLATION", "reason": "REFUND_EXCEEDS_REFUNDABLE",
 *                "message": "...", "details": { ... } } }
 *
 * `code` is the coarse class (stable, safe to branch on); `reason` is the
 * specific rule that fired.
 */

export type ErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "GUARDRAIL_VIOLATION" | "CONFLICT" | "INTERNAL_ERROR";

export type ErrorDetails = Record<string, unknown>;

export abstract class ShopError extends Error {
  abstract readonly code: ErrorCode;
  readonly reason: string;
  readonly details: ErrorDetails;

  constructor(reason: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.reason = reason;
    this.details = details;
  }

  toJSON(): ErrorEnvelope {
    return { error: { code: this.code, reason: this.reason, message: this.message, details: this.details } };
  }
}

/** The referenced entity (order, customer, product) does not exist. */
export class NotFoundError extends ShopError {
  readonly code = "NOT_FOUND" as const;
}

/** Input is well-typed but semantically invalid (e.g. `from` after `to`). */
export class ValidationError extends ShopError {
  readonly code = "VALIDATION_ERROR" as const;
}

/** A business safety rule blocked the action (over-refund, refund on unpaid order, ...). */
export class GuardrailViolation extends ShopError {
  readonly code = "GUARDRAIL_VIOLATION" as const;
}

/** The action conflicts with current state (duplicate invoice, invalid status transition, key reuse). */
export class ConflictError extends ShopError {
  readonly code = "CONFLICT" as const;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    reason: string;
    message: string;
    details: ErrorDetails;
  };
}

export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof ShopError) return err.toJSON();
  return {
    error: {
      code: "INTERNAL_ERROR",
      reason: "UNEXPECTED",
      message: "Unexpected server error. The action was not completed.",
      details: {},
    },
  };
}
