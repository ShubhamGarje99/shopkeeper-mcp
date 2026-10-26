import { z } from "zod";
import { isoTimestamp } from "../clock.js";
import { transaction } from "../db/connection.js";
import { ORDER_STATUSES } from "../db/schema.js";
import { refundEligibility, refundedCents, requireOrder, writeAudit } from "../domain/orders.js";
import { ConflictError, GuardrailViolation } from "../errors.js";
import { formatCents } from "../money.js";
import { defineTool, orderIdField, writeAnnotations } from "./types.js";

const input = z.strictObject({
  order_id: orderIdField,
  amount_cents: z
    .number()
    .int()
    .positive()
    .describe(
      "Refund amount in integer cents (1050 = $10.50). Must be > 0 and <= the order's remaining refundable amount (get_order -> financials.refundable_cents).",
    ),
  reason: z.string().trim().min(3).max(500).describe("Why the refund is issued; stored in the audit log."),
  idempotency_key: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "Use letters, digits, '.', '_', ':' or '-' only.")
    .describe(
      "Unique key for THIS refund, e.g. 'refund-1042-late-delivery'. Retrying with the same key returns the original refund instead of paying twice. Use a new key only for a genuinely new refund.",
    ),
});

const output = z.object({
  refund: z.object({
    id: z.number().int(),
    order_id: z.number().int(),
    amount_cents: z.number().int(),
    reason: z.string(),
    idempotency_key: z.string(),
    created_at: z.string(),
  }),
  replayed: z.boolean().describe("True when this key was already used for the same refund: nothing new was refunded."),
  order: z.object({
    id: z.number().int(),
    status: z.enum(ORDER_STATUSES),
    total_cents: z.number().int(),
    refunded_cents: z.number().int(),
    refundable_cents: z.number().int(),
  }),
});

interface RefundRow {
  id: number;
  order_id: number;
  amount_cents: number;
  reason: string;
  idempotency_key: string;
  created_at: string;
}

export const issueRefund = defineTool({
  name: "issue_refund",
  title: "Issue refund",
  kind: "write",
  description:
    "Refund money on a paid order. Guardrails: amount must be > 0 and within the remaining refundable amount; unpaid, cancelled and fully-refunded orders are refused; a reason and an idempotency_key are required, and repeating a key replays the original refund instead of paying twice. When refunds reach the order total the order becomes 'refunded'. Every refund is written to the audit log.",
  input,
  output,
  annotations: writeAnnotations("Issue refund", { destructive: true, idempotent: true }),
  handler: ({ db, clock, actor }, { order_id, amount_cents, reason, idempotency_key }) =>
    transaction(db, () => {
      const existing = db.prepare("SELECT * FROM refunds WHERE idempotency_key = ?").get(idempotency_key) as
        | RefundRow
        | undefined;

      if (existing) {
        if (existing.order_id !== order_id || existing.amount_cents !== amount_cents) {
          throw new ConflictError(
            "IDEMPOTENCY_KEY_REUSED",
            `Idempotency key '${idempotency_key}' was already used for a different refund (${formatCents(existing.amount_cents)} on order ${existing.order_id}). Use a new key for a new refund.`,
            { idempotency_key, existing_refund_id: existing.id, existing_order_id: existing.order_id, existing_amount_cents: existing.amount_cents },
          );
        }
        const order = requireOrder(db, order_id);
        const refunded = refundedCents(db, order_id);
        return {
          data: {
            refund: { ...existing },
            replayed: true,
            order: {
              id: order.id,
              status: order.status,
              total_cents: order.total_cents,
              refunded_cents: refunded,
              refundable_cents: refundEligibility(order, refunded).refundable_cents,
            },
          },
          summary: `Replayed: refund #${existing.id} (${formatCents(existing.amount_cents)} on order ${order_id}) already exists for key '${idempotency_key}'. No new money was refunded.`,
        };
      }

      const order = requireOrder(db, order_id);
      const refunded = refundedCents(db, order_id);
      const eligibility = refundEligibility(order, refunded);
      const facts = {
        order_id,
        status: order.status,
        total_cents: order.total_cents,
        already_refunded_cents: refunded,
        refundable_cents: eligibility.refundable_cents,
        requested_cents: amount_cents,
      };

      if (!eligibility.eligible) {
        const fully = order.status === "refunded" || (refunded >= order.total_cents && order.total_cents > 0);
        throw new GuardrailViolation(
          fully ? "ORDER_FULLY_REFUNDED" : "ORDER_NOT_REFUNDABLE",
          `Order ${order_id} cannot be refunded: ${eligibility.reason}`,
          facts,
        );
      }
      if (amount_cents > eligibility.refundable_cents) {
        throw new GuardrailViolation(
          "REFUND_EXCEEDS_REFUNDABLE",
          `Requested ${formatCents(amount_cents)} exceeds the refundable amount ${formatCents(eligibility.refundable_cents)} on order ${order_id} (total ${formatCents(order.total_cents)}, already refunded ${formatCents(refunded)}). No refund was issued.`,
          facts,
        );
      }

      const now = isoTimestamp(clock());
      const result = db
        .prepare("INSERT INTO refunds (order_id, amount_cents, reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(order_id, amount_cents, reason, idempotency_key, now);
      const refundId = Number(result.lastInsertRowid);
      const newRefunded = refunded + amount_cents;
      writeAudit(db, {
        at: now,
        actor,
        action: "refund.issued",
        entity: "order",
        entityId: order_id,
        details: { refund_id: refundId, amount_cents, reason, idempotency_key, refunded_total_cents: newRefunded },
      });

      let status = order.status;
      if (newRefunded === order.total_cents) {
        db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(now, order_id);
        writeAudit(db, {
          at: now,
          actor,
          action: "order.status_changed",
          entity: "order",
          entityId: order_id,
          details: { from: order.status, to: "refunded", via: "issue_refund" },
        });
        status = "refunded";
      }

      const remaining = order.total_cents - newRefunded;
      return {
        data: {
          refund: { id: refundId, order_id, amount_cents, reason, idempotency_key, created_at: now },
          replayed: false,
          order: {
            id: order_id,
            status,
            total_cents: order.total_cents,
            refunded_cents: newRefunded,
            refundable_cents: remaining,
          },
        },
        summary:
          `Refunded ${formatCents(amount_cents)} on order ${order_id} (refund #${refundId}). ` +
          (status === "refunded"
            ? "The order is now fully refunded."
            : `Refunded so far ${formatCents(newRefunded)} of ${formatCents(order.total_cents)}; ${formatCents(remaining)} still refundable.`),
      };
    }),
});
