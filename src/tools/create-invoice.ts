import { z } from "zod";
import { addDays, isoDate, isoTimestamp } from "../clock.js";
import { transaction } from "../db/connection.js";
import { requireOrder, writeAudit } from "../domain/orders.js";
import { ConflictError } from "../errors.js";
import { formatCents } from "../money.js";
import { defineTool, orderIdField, writeAnnotations } from "./types.js";

const input = z.strictObject({
  order_id: orderIdField,
  due_in_days: z
    .number()
    .int()
    .min(0)
    .max(90)
    .default(14)
    .describe("Payment terms for unpaid orders (default 14). Paid orders are invoiced as due today."),
  notes: z.string().trim().max(500).optional().describe("Optional note printed on the invoice."),
});

const output = z.object({
  invoice: z.object({
    invoice_number: z.string(),
    order_id: z.number().int(),
    amount_cents: z.number().int(),
    issued_at: z.string(),
    due_date: z.string(),
    notes: z.string().nullable(),
    payment_status: z.enum(["paid", "unpaid"]),
  }),
});

export const createInvoice = defineTool({
  name: "create_invoice",
  title: "Create invoice",
  kind: "write",
  description:
    "Issue the invoice for an order (amount = order total). Each order can have only one invoice: a second request is refused with the existing invoice number (CONFLICT). Cancelled and refunded orders cannot be invoiced.",
  input,
  output,
  annotations: writeAnnotations("Create invoice", { destructive: false, idempotent: true }),
  handler: ({ db, clock, actor }, { order_id, due_in_days, notes }) =>
    transaction(db, () => {
      const order = requireOrder(db, order_id);
      const existing = db.prepare("SELECT invoice_number, issued_at FROM invoices WHERE order_id = ?").get(order_id) as
        | { invoice_number: string; issued_at: string }
        | undefined;
      if (existing) {
        throw new ConflictError(
          "INVOICE_ALREADY_EXISTS",
          `Order ${order_id} already has invoice ${existing.invoice_number} (issued ${existing.issued_at}). No new invoice was created.`,
          { order_id, invoice_number: existing.invoice_number, issued_at: existing.issued_at },
        );
      }
      if (order.status === "cancelled" || order.status === "refunded") {
        throw new ConflictError("ORDER_NOT_INVOICEABLE", `Order ${order_id} is ${order.status} and cannot be invoiced.`, {
          order_id,
          status: order.status,
        });
      }

      const now = clock();
      const issuedAt = isoTimestamp(now);
      const paid = order.paid_at !== null;
      const dueDate = paid ? isoDate(now) : addDays(isoDate(now), due_in_days);
      const invoiceNumber = `INV-${order.placed_at.slice(0, 4)}-${order_id}`;
      db.prepare(
        "INSERT INTO invoices (invoice_number, order_id, amount_cents, issued_at, due_date, notes) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(invoiceNumber, order_id, order.total_cents, issuedAt, dueDate, notes ?? null);
      writeAudit(db, {
        at: issuedAt,
        actor,
        action: "invoice.created",
        entity: "order",
        entityId: order_id,
        details: { invoice_number: invoiceNumber, amount_cents: order.total_cents, due_date: dueDate },
      });

      const invoice = {
        invoice_number: invoiceNumber,
        order_id,
        amount_cents: order.total_cents,
        issued_at: issuedAt,
        due_date: dueDate,
        notes: notes ?? null,
        payment_status: paid ? ("paid" as const) : ("unpaid" as const),
      };
      return {
        data: { invoice },
        summary: `Created invoice ${invoiceNumber} for order ${order_id}: ${formatCents(order.total_cents)}, ${paid ? "already paid" : `due ${dueDate}`}.`,
      };
    }),
});
