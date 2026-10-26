import type { OrderStatus } from "../db/schema.js";

/**
 * Order lifecycle. `refunded` is reachable only through `issue_refund` (when the
 * cumulative refunds reach the order total), never by a direct status update,
 * and cancellation is only allowed before payment - a paid order is unwound
 * with a refund instead, so money and status can never disagree.
 *
 *   pending -> paid -> shipped -> delivered
 *      \-> cancelled
 */
export const STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
  refunded: [],
};

export function allowedNextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return STATUS_TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses in which money has been captured and can be (partly) refunded. */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = ["paid", "shipped", "delivered"];

/** Statuses that count as revenue in reports (cancelled/pending never captured money). */
export const REVENUE_STATUSES: readonly OrderStatus[] = ["paid", "shipped", "delivered", "refunded"];
