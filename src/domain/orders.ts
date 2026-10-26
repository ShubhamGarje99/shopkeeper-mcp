import { daysBetween, isoDate } from "../clock.js";
import type { Db } from "../db/connection.js";
import type { OrderStatus } from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import { REFUNDABLE_STATUSES } from "./status-machine.js";

export interface OrderRecord {
  id: number;
  customer_id: number;
  status: OrderStatus;
  placed_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  promised_delivery_date: string;
  shipping_method: "standard" | "express";
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  updated_at: string;
}

export const DELIVERY_STATUSES = [
  "awaiting_payment",
  "awaiting_shipment",
  "in_transit",
  "overdue",
  "delivered_on_time",
  "delivered_late",
  "cancelled",
  "not_applicable",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryInfo {
  status: DeliveryStatus;
  promised_date: string;
  delivered_date: string | null;
  /** Days past the promised date (delivered late, or still undelivered and overdue). 0 otherwise. */
  days_late: number;
}

const ORDER_COLUMNS = `id, customer_id, status, placed_at, paid_at, shipped_at, delivered_at, cancelled_at,
  promised_delivery_date, shipping_method, subtotal_cents, shipping_cents, total_cents, updated_at`;

export function findOrder(db: Db, id: number): OrderRecord | undefined {
  const row = db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id);
  return row ? ({ ...row } as unknown as OrderRecord) : undefined;
}

export function requireOrder(db: Db, id: number): OrderRecord {
  const order = findOrder(db, id);
  if (!order) {
    throw new NotFoundError("ORDER_NOT_FOUND", `Order ${id} does not exist.`, { order_id: id });
  }
  return order;
}

export function refundedCents(db: Db, orderId: number): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE order_id = ?").get(orderId) as
    | { total: number }
    | undefined;
  return row?.total ?? 0;
}

export function deliveryInfo(order: OrderRecord, now: Date): DeliveryInfo {
  const promised = order.promised_delivery_date;
  const delivered = order.delivered_at ? order.delivered_at.slice(0, 10) : null;
  const base = { promised_date: promised, delivered_date: delivered };

  if (order.status === "cancelled") return { ...base, status: "cancelled", days_late: 0 };
  if (delivered) {
    const late = daysBetween(promised, delivered);
    return late > 0
      ? { ...base, status: "delivered_late", days_late: late }
      : { ...base, status: "delivered_on_time", days_late: 0 };
  }
  if (order.status === "refunded") return { ...base, status: "not_applicable", days_late: 0 };
  if (order.status === "pending") return { ...base, status: "awaiting_payment", days_late: 0 };

  const today = isoDate(now);
  const overdueBy = daysBetween(promised, today);
  if (overdueBy > 0) return { ...base, status: "overdue", days_late: overdueBy };
  return { ...base, status: order.shipped_at ? "in_transit" : "awaiting_shipment", days_late: 0 };
}

export interface RefundEligibility {
  eligible: boolean;
  refundable_cents: number;
  reason: string | null;
}

export function refundEligibility(order: OrderRecord, alreadyRefunded: number): RefundEligibility {
  const remaining = Math.max(0, order.total_cents - alreadyRefunded);
  if (order.status === "refunded" || (REFUNDABLE_STATUSES.includes(order.status) && remaining === 0)) {
    return { eligible: false, refundable_cents: 0, reason: "Order is already fully refunded." };
  }
  if (order.status === "pending") {
    return { eligible: false, refundable_cents: 0, reason: "Order is unpaid; no payment has been captured." };
  }
  if (order.status === "cancelled") {
    return { eligible: false, refundable_cents: 0, reason: "Order was cancelled before payment; nothing to refund." };
  }
  return { eligible: true, refundable_cents: remaining, reason: null };
}

export function writeAudit(
  db: Db,
  entry: { at: string; actor: string; action: string; entity: string; entityId: string | number; details: unknown },
): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)").run(
    entry.at,
    entry.actor,
    entry.action,
    entry.entity,
    String(entry.entityId),
    JSON.stringify(entry.details),
  );
}
