import { z } from "zod";
import { isoTimestamp } from "../clock.js";
import { transaction } from "../db/connection.js";
import { ORDER_STATUSES, type OrderStatus } from "../db/schema.js";
import { requireOrder, writeAudit } from "../domain/orders.js";
import { allowedNextStatuses, canTransition } from "../domain/status-machine.js";
import { ConflictError } from "../errors.js";
import { defineTool, orderIdField, writeAnnotations } from "./types.js";

const statusEnum = z.enum(ORDER_STATUSES);

const input = z.strictObject({
  order_id: orderIdField,
  status: statusEnum.describe("Target status. Allowed moves: pending->paid|cancelled, paid->shipped, shipped->delivered."),
  note: z.string().trim().max(500).optional().describe("Optional context stored in the audit log (e.g. tracking number)."),
});

const output = z.object({
  order_id: z.number().int(),
  previous_status: statusEnum,
  status: statusEnum,
  changed: z.boolean().describe("False when the order was already in the requested status (no-op)."),
  allowed_next_statuses: z.array(statusEnum),
  updated_at: z.string(),
});

const TIMESTAMP_COLUMN: Partial<Record<OrderStatus, string>> = {
  paid: "paid_at",
  shipped: "shipped_at",
  delivered: "delivered_at",
  cancelled: "cancelled_at",
};

function transitionHint(from: OrderStatus, to: OrderStatus): string | null {
  if (to === "refunded") {
    return "Use issue_refund instead; an order becomes 'refunded' automatically once refunds reach its total.";
  }
  if (to === "cancelled" && from !== "pending") {
    return "Only unpaid (pending) orders can be cancelled. For a paid order, issue a refund instead.";
  }
  if (from === "pending" && (to === "shipped" || to === "delivered")) {
    return "The order has not been paid. Only mark it 'paid' once payment has actually been received; never skip steps to force a status.";
  }
  return null;
}

export const updateOrderStatus = defineTool({
  name: "update_order_status",
  title: "Update order status",
  kind: "write",
  description:
    "Move an order through its lifecycle: pending->paid|cancelled, paid->shipped, shipped->delivered. Any other transition is rejected (CONFLICT) with the allowed next statuses. 'refunded' is never set directly (use issue_refund). Setting the current status again is a no-op. Changes are audit-logged.",
  input,
  output,
  annotations: writeAnnotations("Update order status", { destructive: true, idempotent: true }),
  handler: ({ db, clock, actor }, { order_id, status, note }) =>
    transaction(db, () => {
      const order = requireOrder(db, order_id);
      const allowed = [...allowedNextStatuses(order.status)];

      if (order.status === status) {
        return {
          data: {
            order_id,
            previous_status: order.status,
            status,
            changed: false,
            allowed_next_statuses: allowed,
            updated_at: order.updated_at,
          },
          summary: `Order ${order_id} is already '${status}'. Nothing changed.`,
        };
      }

      if (!canTransition(order.status, status)) {
        const hint = transitionHint(order.status, status);
        throw new ConflictError(
          "INVALID_STATUS_TRANSITION",
          `Cannot change order ${order_id} from '${order.status}' to '${status}'. Allowed next statuses: ${allowed.length ? allowed.join(", ") : "none (terminal status)"}.${hint ? ` ${hint}` : ""}`,
          { order_id, from: order.status, to: status, allowed_next_statuses: allowed, ...(hint ? { hint } : {}) },
        );
      }

      const now = isoTimestamp(clock());
      const column = TIMESTAMP_COLUMN[status];
      db.prepare(`UPDATE orders SET status = ?, updated_at = ?${column ? `, ${column} = ?` : ""} WHERE id = ?`).run(
        ...(column ? [status, now, now, order_id] : [status, now, order_id]),
      );
      writeAudit(db, {
        at: now,
        actor,
        action: "order.status_changed",
        entity: "order",
        entityId: order_id,
        details: { from: order.status, to: status, ...(note ? { note } : {}) },
      });

      return {
        data: {
          order_id,
          previous_status: order.status,
          status,
          changed: true,
          allowed_next_statuses: [...allowedNextStatuses(status)],
          updated_at: now,
        },
        summary: `Order ${order_id} moved from '${order.status}' to '${status}'.`,
      };
    }),
});
