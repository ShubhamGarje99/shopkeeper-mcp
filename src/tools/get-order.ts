import { z } from "zod";
import { ORDER_STATUSES } from "../db/schema.js";
import {
  DELIVERY_STATUSES,
  deliveryInfo,
  refundEligibility,
  refundedCents,
  requireOrder,
} from "../domain/orders.js";
import { allowedNextStatuses } from "../domain/status-machine.js";
import { formatCents } from "../money.js";
import { defineTool, orderIdField, readOnlyAnnotations } from "./types.js";

const input = z.strictObject({ order_id: orderIdField });

const output = z.object({
  order: z.object({
    id: z.number().int(),
    status: z.enum(ORDER_STATUSES),
    placed_at: z.string(),
    paid_at: z.string().nullable(),
    shipped_at: z.string().nullable(),
    delivered_at: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    shipping_method: z.enum(["standard", "express"]),
    allowed_next_statuses: z.array(z.enum(ORDER_STATUSES)),
  }),
  customer: z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    city: z.string(),
    region: z.string(),
  }),
  items: z.array(
    z.object({
      product_id: z.number().int(),
      sku: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      unit_price_cents: z.number().int(),
      line_total_cents: z.number().int(),
    }),
  ),
  financials: z.object({
    currency: z.literal("USD"),
    subtotal_cents: z.number().int(),
    shipping_cents: z.number().int(),
    total_cents: z.number().int(),
    refunded_cents: z.number().int(),
    refundable_cents: z.number().int(),
  }),
  delivery: z.object({
    status: z.enum(DELIVERY_STATUSES),
    promised_date: z.string(),
    delivered_date: z.string().nullable(),
    days_late: z.number().int(),
  }),
  refund_eligibility: z.object({
    eligible: z.boolean(),
    refundable_cents: z.number().int(),
    reason: z.string().nullable(),
  }),
  invoice: z
    .object({
      invoice_number: z.string(),
      amount_cents: z.number().int(),
      issued_at: z.string(),
      due_date: z.string(),
    })
    .nullable(),
  refunds: z.array(
    z.object({
      id: z.number().int(),
      amount_cents: z.number().int(),
      reason: z.string(),
      idempotency_key: z.string(),
      created_at: z.string(),
    }),
  ),
});

export const getOrder = defineTool({
  name: "get_order",
  title: "Get order",
  kind: "read",
  description:
    "Full detail for one order: status (and which statuses it may move to next), customer, line items, totals in cents, refunds already issued, refundable remainder, invoice, and delivery timing (promised vs actual date, days late). Call this before any write on an order.",
  input,
  output,
  annotations: readOnlyAnnotations("Get order"),
  handler: ({ db, clock }, { order_id }) => {
    const order = requireOrder(db, order_id);
    const customer = db
      .prepare("SELECT id, name, email, city, region FROM customers WHERE id = ?")
      .get(order.customer_id) as { id: number; name: string; email: string; city: string; region: string };
    const items = (
      db
        .prepare(
          `SELECT i.product_id, p.sku, p.name, i.quantity, i.unit_price_cents
             FROM order_items i JOIN products p ON p.id = i.product_id
            WHERE i.order_id = ? ORDER BY i.id`,
        )
        .all(order_id) as Array<{ product_id: number; sku: string; name: string; quantity: number; unit_price_cents: number }>
    ).map((it) => ({ ...it, line_total_cents: it.quantity * it.unit_price_cents }));
    const invoiceRow = db
      .prepare("SELECT invoice_number, amount_cents, issued_at, due_date FROM invoices WHERE order_id = ?")
      .get(order_id) as { invoice_number: string; amount_cents: number; issued_at: string; due_date: string } | undefined;
    const refunds = (
      db
        .prepare("SELECT id, amount_cents, reason, idempotency_key, created_at FROM refunds WHERE order_id = ? ORDER BY id")
        .all(order_id) as Array<{ id: number; amount_cents: number; reason: string; idempotency_key: string; created_at: string }>
    ).map((r) => ({ ...r }));

    const refunded = refundedCents(db, order_id);
    const eligibility = refundEligibility(order, refunded);
    const delivery = deliveryInfo(order, clock());

    const data = {
      order: {
        id: order.id,
        status: order.status,
        placed_at: order.placed_at,
        paid_at: order.paid_at,
        shipped_at: order.shipped_at,
        delivered_at: order.delivered_at,
        cancelled_at: order.cancelled_at,
        shipping_method: order.shipping_method,
        allowed_next_statuses: [...allowedNextStatuses(order.status)],
      },
      customer: { ...customer },
      items,
      financials: {
        currency: "USD" as const,
        subtotal_cents: order.subtotal_cents,
        shipping_cents: order.shipping_cents,
        total_cents: order.total_cents,
        refunded_cents: refunded,
        refundable_cents: eligibility.refundable_cents,
      },
      delivery,
      refund_eligibility: eligibility,
      invoice: invoiceRow ? { ...invoiceRow } : null,
      refunds,
    };

    const timing =
      delivery.status === "delivered_late"
        ? `delivered ${delivery.days_late} day(s) LATE (promised ${delivery.promised_date}, delivered ${delivery.delivered_date})`
        : delivery.status === "delivered_on_time"
          ? `delivered on time (promised ${delivery.promised_date}, delivered ${delivery.delivered_date})`
          : delivery.status === "overdue"
            ? `OVERDUE by ${delivery.days_late} day(s) (promised ${delivery.promised_date}, not delivered)`
            : `${delivery.status.replace(/_/g, " ")} (promised ${delivery.promised_date})`;
    const summary = [
      `Order ${order.id} - status: ${order.status}; ${timing}.`,
      `Customer: ${customer.name} <${customer.email}> (#${customer.id}).`,
      `Total ${formatCents(order.total_cents)} (shipping ${formatCents(order.shipping_cents)}); refunded ${formatCents(refunded)}; refundable ${formatCents(eligibility.refundable_cents)}${eligibility.reason ? ` - ${eligibility.reason}` : ""}.`,
      `${items.length} line item(s). Invoice: ${invoiceRow ? invoiceRow.invoice_number : "none"}. Refunds on file: ${refunds.length}.`,
    ].join("\n");
    return { data, summary };
  },
});
