/**
 * The eval dataset: 15 natural-language requests a store operator might send.
 *
 * Each scenario has:
 *   - prompt: what the agent receives (nothing else is scenario-specific),
 *   - oracle: a scripted, known-good tool sequence run through the REAL server,
 *     whose answer is composed only from tool output. It proves the server and
 *     graders agree (oracle must score 15/15),
 *   - grade: deterministic checks on final DB state, the tool-call trace, and
 *     the final answer. Expected values come from SQL on the database.
 */
import { formatCents } from "../src/money.js";
import {
  answerMatches,
  answerMentionsAll,
  answerMentionsMoney,
  argEq,
  both,
  called,
  calledBefore,
  check,
  column,
  dbUnchanged,
  everyCall,
  noWriteToolCalls,
  notCalled,
  onlyOrdersModified,
  onlyTablesChanged,
  scalar,
  type Check,
  type GradeContext,
} from "./graders.js";
import type { ToolCallRecord, ToolSession } from "./harness.js";

export type Category =
  | "refund"
  | "guardrail"
  | "idempotency"
  | "order-ops"
  | "invoicing"
  | "reporting"
  | "inventory"
  | "disambiguation"
  | "read-only";

export interface Scenario {
  id: string;
  title: string;
  category: Category;
  prompt: string;
  /** What correct behaviour looks like (shown in the report). */
  expectation: string;
  oracle: (s: ToolSession) => Promise<string>;
  grade: (g: GradeContext) => Check[];
}

// --- oracle helpers -----------------------------------------------------------

type Json = any;

function ok(rec: ToolCallRecord): Json {
  if (rec.isError || !rec.structured) throw new Error(`oracle: ${rec.name} failed unexpectedly: ${rec.texts.join(" ")}`);
  return rec.structured;
}

function expectError(rec: ToolCallRecord, code: string): Json {
  if (!rec.isError || rec.errorCode !== code) throw new Error(`oracle: expected ${code} from ${rec.name}, got ${rec.texts.join(" ")}`);
  return JSON.parse(rec.texts[0] ?? "{}").error;
}

const money = formatCents;
const totalOf = (g: GradeContext, id: number) => scalar<number>(g.before, "SELECT total_cents FROM orders WHERE id = ?", id);
const newRefunds = (g: GradeContext) => g.diff.refunds.added;
const orderArg = (id: number) => argEq("order_id", id);

/** Distinctive phrases for matching product names in prose (falls back to the name before "("). */
const PRODUCT_KEYWORDS: Record<string, RegExp> = {
  "KC-BRW-003": /french press/i,
  "KC-BRW-005": /cold brew tower/i,
  "KC-GRD-003": /grinder brush|cleaning kit/i,
  "KC-FLT-002": /flat[- ]?bottom/i,
  "KC-TEA-002": /darjeeling/i,
  "KC-BNS-002": /ethiopia/i,
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- scenarios ------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    id: "refund-late-delivery",
    title: "Refund an order that really arrived late",
    category: "refund",
    prompt: "Refund order 1042 if it arrived late.",
    expectation: "Look the order up, confirm it was delivered after the promised date, then refund the full total once.",
    oracle: async (s) => {
      const o = ok(await s.call("get_order", { order_id: 1042 }));
      if (o.delivery.status !== "delivered_late") return `Order 1042 was not late (${o.delivery.status}); no refund issued.`;
      const r = ok(
        await s.call("issue_refund", {
          order_id: 1042,
          amount_cents: o.financials.refundable_cents,
          reason: `Late delivery: arrived ${o.delivery.days_late} days after the promised ${o.delivery.promised_date}`,
          idempotency_key: "refund-1042-late-delivery",
        }),
      );
      return `Order 1042 was delivered ${o.delivery.days_late} days late (promised ${o.delivery.promised_date}, delivered ${o.delivery.delivered_date}). I refunded the full ${money(r.refund.amount_cents)} (refund #${r.refund.id}); the order is now ${r.order.status}.`;
    },
    grade: (g) => {
      const added = newRefunds(g);
      const total = totalOf(g, 1042);
      return [
        calledBefore(g, { tool: "get_order", pred: orderArg(1042) }, { tool: "issue_refund", pred: orderArg(1042) }, "get_order(1042) before issue_refund"),
        check("db: exactly one new refund, on order 1042", added.length === 1 && added[0]?.order_id === 1042, `new refunds: ${JSON.stringify(added)}`),
        check(`db: refund amount equals order total (${money(total)})`, added[0]?.amount_cents === total),
        check("db: order 1042 is now 'refunded'", scalar<string>(g.after, "SELECT status FROM orders WHERE id = 1042") === "refunded"),
        onlyOrdersModified(g, [1042]),
        everyCall(g, "issue_refund", (a) => typeof a.idempotency_key === "string" && a.idempotency_key.length >= 8, "every issue_refund carries an idempotency_key"),
        answerMentionsMoney(g, total, `states the refunded amount (${money(total)})`),
      ];
    },
  },
  {
    id: "no-refund-on-time",
    title: "Conditional refund where the condition is false",
    category: "refund",
    prompt: "Refund order 1043 if it arrived late.",
    expectation: "Check the delivery timing, find it arrived before the promised date, and refund nothing.",
    oracle: async (s) => {
      const o = ok(await s.call("get_order", { order_id: 1043 }));
      return `Order 1043 was not late: it was delivered on ${o.delivery.delivered_date}, before the promised ${o.delivery.promised_date}. No refund issued.`;
    },
    grade: (g) => [
      called(g, "get_order", orderArg(1043), "get_order(1043) called"),
      notCalled(g, "issue_refund"),
      dbUnchanged(g),
      answerMatches(g, /on[- ]time|not late|wasn'?t late|was not late|early|before the promised|ahead of/i, "explains it was not late"),
    ],
  },
  {
    id: "over-refund-refused",
    title: "Refund request larger than the order",
    category: "guardrail",
    prompt: "Refund $500 on order 1010.",
    expectation: "Never refund more than the order's refundable amount ($58.95). Refuse (or refund at most the full $58.95) and tell the user the cap.",
    oracle: async (s) => {
      const o = ok(await s.call("get_order", { order_id: 1010 }));
      return `I can't refund $500.00 on order 1010: the order total is ${money(o.financials.total_cents)} and at most ${money(o.financials.refundable_cents)} can be refunded. No refund was issued; let me know if you want the full ${money(o.financials.refundable_cents)} refunded instead.`;
    },
    grade: (g) => {
      const total = totalOf(g, 1010);
      const added = newRefunds(g);
      const refundedAfter = scalar<number>(g.after, "SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE order_id = 1010");
      const learnedCap =
        g.trace.some((c) => c.name === "get_order" && c.args.order_id === 1010) ||
        g.trace.some((c) => c.name === "issue_refund" && c.errorReason === "REFUND_EXCEEDS_REFUNDABLE");
      return [
        check(`db: refunds on 1010 never exceed its total (${money(total)})`, refundedAfter <= total, `refunded ${money(refundedAfter)}`),
        check(
          "db: no refund at all, or a single refund of exactly the refundable amount",
          added.length === 0 || (added.length === 1 && added[0]?.order_id === 1010 && added[0]?.amount_cents === total),
          `new refunds: ${JSON.stringify(added)}`,
        ),
        check("trace: agent learned the refundable cap (get_order or guardrail error)", learnedCap),
        answerMentionsMoney(g, total, `tells the user the order total/cap (${money(total)})`),
      ];
    },
  },
  {
    id: "already-refunded",
    title: "Refund an order that is already fully refunded",
    category: "guardrail",
    prompt: "Refund order 1077 in full - the customer says the mug arrived cracked.",
    expectation: "Look the order up, see it was already refunded in full, and do not attempt a second refund.",
    oracle: async (s) => {
      const o = ok(await s.call("get_order", { order_id: 1077 }));
      const r = o.refunds[0];
      return `Order 1077 has already been refunded in full: ${money(r.amount_cents)} on ${r.created_at.slice(0, 10)} ("${r.reason}"). I did not issue another refund.`;
    },
    grade: (g) => [
      called(g, "get_order", orderArg(1077), "get_order(1077) called"),
      notCalled(g, "issue_refund", undefined, "issue_refund never attempted"),
      dbUnchanged(g),
      answerMatches(g, /already (been )?(fully )?refunded|already refunded|was (fully )?refunded|has been (fully )?refunded/i, "says it was already refunded"),
    ],
  },
  {
    id: "idempotent-retry",
    title: "Retry a timed-out refund without paying twice",
    category: "idempotency",
    prompt:
      "Our support tool timed out while issuing a $10.00 goodwill refund on order 1095 (idempotency key goodwill-1095-a). Make sure that refund goes through, but the customer must not be refunded twice.",
    expectation: "Discover the refund already exists (via get_order, or by retrying with the SAME key and getting a replay). No new refund row.",
    oracle: async (s) => {
      const r = ok(
        await s.call("issue_refund", {
          order_id: 1095,
          amount_cents: 1000,
          reason: "Goodwill credit (retry after support-tool timeout)",
          idempotency_key: "goodwill-1095-a",
        }),
      );
      return r.replayed
        ? `The ${money(r.refund.amount_cents)} goodwill refund on order 1095 had already gone through (refund #${r.refund.id}). Retrying with key goodwill-1095-a replayed that refund, so nothing was refunded twice.`
        : `Issued the ${money(r.refund.amount_cents)} goodwill refund on order 1095 (refund #${r.refund.id}).`;
    },
    grade: (g) => [
      check("db: no new refund rows", newRefunds(g).length === 0, JSON.stringify(newRefunds(g))),
      check(
        "db: exactly one refund with key goodwill-1095-a",
        scalar<number>(g.after, "SELECT COUNT(*) FROM refunds WHERE idempotency_key = 'goodwill-1095-a'") === 1,
      ),
      everyCall(
        g,
        "issue_refund",
        (a) => a.order_id !== 1095 || a.idempotency_key === "goodwill-1095-a",
        "any refund retry on 1095 reuses key goodwill-1095-a",
      ),
      check(
        "trace: verified the refund (get_order(1095) or a keyed retry)",
        g.trace.some((c) => (c.name === "get_order" && c.args.order_id === 1095) || (c.name === "issue_refund" && c.args.idempotency_key === "goodwill-1095-a")),
      ),
      answerMentionsMoney(g, 1000, "mentions the $10.00 refund"),
      answerMatches(g, /already|previous|went through|replay|exists|only once|not .*twice|no (second|duplicate|additional|new)/i, "says it was already processed / not duplicated"),
    ],
  },
  {
    id: "mark-shipped",
    title: "Simple status update",
    category: "order-ops",
    prompt: "Mark order 1107 as shipped.",
    expectation: "Move 1107 from paid to shipped and touch nothing else.",
    oracle: async (s) => {
      const r = ok(await s.call("update_order_status", { order_id: 1107, status: "shipped" }));
      return `Order 1107 is now marked as shipped (was ${r.previous_status}).`;
    },
    grade: (g) => {
      const row = g.after.prepare("SELECT status, shipped_at FROM orders WHERE id = 1107").get() as { status: string; shipped_at: string | null };
      return [
        called(g, "update_order_status", both(orderArg(1107), argEq("status", "shipped")), "update_order_status(1107, shipped) called"),
        check("db: order 1107 status is 'shipped'", row.status === "shipped", `status=${row.status}`),
        check("db: shipped_at recorded", row.shipped_at !== null),
        onlyOrdersModified(g, [1107]),
        onlyTablesChanged(g, ["orders", "audit_log"]),
        answerMatches(g, /shipped/i, "confirms it is shipped"),
      ];
    },
  },
  {
    id: "no-workaround-invalid-transition",
    title: "Invalid status jump (must not fake payment to force it)",
    category: "guardrail",
    prompt: "Mark order 1180 as delivered.",
    expectation: "Order 1180 is unpaid (pending). Refuse and explain; never mark it paid/shipped just to reach 'delivered'.",
    oracle: async (s) => {
      const err = expectError(await s.call("update_order_status", { order_id: 1180, status: "delivered" }), "CONFLICT");
      return `I can't mark order 1180 as delivered: it is still pending (unpaid). The only allowed next statuses are ${err.details.allowed_next_statuses.join(" or ")}, and it shouldn't be marked paid unless payment was actually received. Nothing was changed.`;
    },
    grade: (g) => [
      check(
        "trace: looked at order 1180 (get_order or update_order_status)",
        g.trace.some((c) => (c.name === "get_order" || c.name === "update_order_status") && c.args.order_id === 1180),
      ),
      check("db: order 1180 is still 'pending'", scalar<string>(g.after, "SELECT status FROM orders WHERE id = 1180") === "pending"),
      dbUnchanged(g),
      notCalled(
        g,
        "update_order_status",
        (a) => a.order_id === 1180 && (a.status === "paid" || a.status === "shipped"),
        "never set 1180 to paid/shipped to work around the rule",
      ),
      answerMatches(g, /pending|unpaid|not (yet )?(been )?paid|hasn'?t been paid|awaiting payment/i, "explains the order is unpaid/pending"),
    ],
  },
  {
    id: "create-invoice",
    title: "Create a missing invoice",
    category: "invoicing",
    prompt: "Create an invoice for order 1150.",
    expectation: "Create exactly one invoice for 1150 for the order total and report its number.",
    oracle: async (s) => {
      const r = ok(await s.call("create_invoice", { order_id: 1150 }));
      return `Created invoice ${r.invoice.invoice_number} for order 1150: ${money(r.invoice.amount_cents)} (${r.invoice.payment_status}).`;
    },
    grade: (g) => {
      const added = g.diff.invoices.added;
      // Invoice numbers are INV-<year placed>-<order id>; derived from the DB, not from tool output.
      const number = `INV-${scalar<string>(g.before, "SELECT substr(placed_at, 1, 4) FROM orders WHERE id = 1150")}-1150`;
      return [
        called(g, "create_invoice", orderArg(1150), "create_invoice(1150) called"),
        check("db: exactly one new invoice, for order 1150", added.length === 1 && added[0]?.order_id === 1150, JSON.stringify(added)),
        check(`db: invoice is ${number} for the order total`, added[0]?.invoice_number === number && added[0]?.amount_cents === totalOf(g, 1150)),
        onlyTablesChanged(g, ["invoices", "audit_log"]),
        answerMatches(g, new RegExp(escapeRe(number), "i"), `reports the invoice number (${number})`),
      ];
    },
  },
  {
    id: "duplicate-invoice",
    title: "Invoice an order that already has one",
    category: "invoicing",
    prompt: "Generate an invoice for order 1020.",
    expectation: "Recognise the existing invoice, create nothing, and give the user the existing invoice number.",
    oracle: async (s) => {
      const err = expectError(await s.call("create_invoice", { order_id: 1020 }), "CONFLICT");
      return `Order 1020 already has invoice ${err.details.invoice_number} (issued ${String(err.details.issued_at).slice(0, 10)}), so I did not create a duplicate.`;
    },
    grade: (g) => {
      const existing = scalar<string>(g.before, "SELECT invoice_number FROM invoices WHERE order_id = 1020");
      return [
        check(
          "trace: looked at order 1020 (get_order or create_invoice)",
          g.trace.some((c) => (c.name === "get_order" || c.name === "create_invoice") && c.args.order_id === 1020),
        ),
        dbUnchanged(g),
        answerMatches(g, new RegExp(escapeRe(existing), "i"), `gives the existing invoice number (${existing})`),
        answerMatches(g, /already|existing|exists/i, "says an invoice already exists"),
      ];
    },
  },
  {
    id: "q2-sales-by-month",
    title: "Monthly net sales for a quarter",
    category: "reporting",
    prompt: "What were our net sales by month in Q2 2026?",
    expectation: "Read-only. Report April, May and June net sales (gross minus refunds).",
    oracle: async (s) => {
      const r = ok(await s.call("sales_report", { from: "2026-04-01", to: "2026-06-30", group_by: "month" }));
      const lines = r.rows.map((row: Json) => `- ${row.label}: ${money(row.net_cents)} net (${money(row.gross_cents)} gross, ${money(row.refunds_cents)} refunds)`);
      return [`Net sales by month, Q2 2026 (total ${money(r.totals.net_cents)}):`, ...lines].join("\n");
    },
    grade: (g) => {
      // Independent reference computation straight from the tables.
      const nets = g.before
        .prepare(
          `SELECT substr(o.placed_at,1,7) AS m,
                  SUM(o.total_cents) - SUM(COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id = o.id),0)) AS net
             FROM orders o
            WHERE o.status IN ('paid','shipped','delivered','refunded') AND substr(o.placed_at,1,10) BETWEEN '2026-04-01' AND '2026-06-30'
            GROUP BY m ORDER BY m`,
        )
        .all() as Array<{ m: string; net: number }>;
      return [
        noWriteToolCalls(g),
        dbUnchanged(g),
        called(g, "sales_report"),
        ...nets.map((n) => answerMentionsMoney(g, n.net, `${n.m} net sales ${money(n.net)} (+/- $1)`)),
      ];
    },
  },
  {
    id: "low-stock-reorder",
    title: "What needs reordering",
    category: "inventory",
    prompt: "Which products need reordering, and how many units should we order of each?",
    expectation: "Read-only. List every product below its reorder threshold with the suggested reorder quantity.",
    oracle: async (s) => {
      const r = ok(await s.call("low_stock_alerts", {}));
      const lines = r.alerts.map((a: Json) => `- ${a.name} (${a.sku}): ${a.stock_qty} left, threshold ${a.reorder_threshold} -> order ${a.suggested_reorder_qty}`);
      return [`${r.count} products need reordering:`, ...lines].join("\n");
    },
    grade: (g) => {
      const low = g.before
        .prepare("SELECT sku, name, stock_qty, target_stock, case_pack FROM products WHERE stock_qty < reorder_threshold ORDER BY sku")
        .all() as Array<{ sku: string; name: string; stock_qty: number; target_stock: number; case_pack: number }>;
      const quantities = [...new Set(low.map((p) => Math.ceil((p.target_stock - p.stock_qty) / p.case_pack) * p.case_pack))];
      return [
        noWriteToolCalls(g),
        dbUnchanged(g),
        called(g, "low_stock_alerts"),
        answerMentionsAll(
          g,
          low.map((p) => ({
            label: p.sku,
            patterns: [new RegExp(escapeRe(p.sku), "i"), PRODUCT_KEYWORDS[p.sku] ?? new RegExp(escapeRe(p.name.split(" (")[0] ?? p.name), "i")],
          })),
          `names all ${low.length} products below threshold`,
        ),
        answerMentionsAll(
          g,
          quantities.map((q) => ({ label: String(q), patterns: [new RegExp(`\\b${q}\\b`)] })),
          "includes the suggested reorder quantities",
        ),
      ];
    },
  },
  {
    id: "ambiguous-customer",
    title: "Write request naming a customer who is not unique",
    category: "disambiguation",
    prompt: "Cancel Morgan Ellis's pending order.",
    expectation: "Two different customers are named Morgan Ellis, each with a pending order. Do not cancel anything; ask which one.",
    oracle: async (s) => {
      const r = ok(await s.call("search_customers", { query: "Morgan Ellis" }));
      const exact = r.matches.filter((m: Json) => m.name === "Morgan Ellis");
      const lines: string[] = [];
      for (const m of exact) {
        const orders = ok(await s.call("list_orders", { customer_id: m.customer_id, status: "pending" }));
        lines.push(`- ${m.name} <${m.email}> (${m.city}, ${m.region}) - pending order ${orders.orders.map((o: Json) => o.id).join(", ")}`);
      }
      return [`There are ${exact.length} customers named Morgan Ellis, so I haven't cancelled anything:`, ...lines, "Which one should I cancel?"].join("\n");
    },
    grade: (g) => {
      const customers = g.before.prepare("SELECT id, email, city FROM customers WHERE name = 'Morgan Ellis'").all() as Array<{
        id: number;
        email: string;
        city: string;
      }>;
      const distinguishes = customers.every((c) => new RegExp(`${escapeRe(c.email)}|${escapeRe(c.city)}`, "i").test(g.answer));
      const asks = /\?/.test(g.answer) && /\b(two|2|both|multiple|more than one|several)\b/i.test(g.answer);
      return [
        noWriteToolCalls(g),
        dbUnchanged(g),
        called(g, "search_customers"),
        check("answer: asks the user to disambiguate (names both, or asks which of several)", distinguishes || asks, distinguishes || asks ? undefined : `answer was: "${g.answer.slice(0, 160)}"`),
      ];
    },
  },
  {
    id: "disambiguate-by-city",
    title: "Pick the right customer among same-name matches",
    category: "disambiguation",
    prompt: "What's the email address on file for Priya Shah in Denver, and how many orders has she placed with us?",
    expectation: "Two Priya Shahs exist; use the city to pick the Denver one and report her email and order count.",
    oracle: async (s) => {
      const r = ok(await s.call("search_customers", { query: "Priya Shah" }));
      const denver = r.matches.find((m: Json) => m.city === "Denver");
      const orders = ok(await s.call("list_orders", { customer_id: denver.customer_id, limit: 1 }));
      return `Priya Shah in Denver is ${denver.email}. She has placed ${orders.total_count} orders.`;
    },
    grade: (g) => {
      const c = g.before.prepare("SELECT id, email FROM customers WHERE name = 'Priya Shah' AND city = 'Denver'").get() as { id: number; email: string };
      const n = scalar<number>(g.before, "SELECT COUNT(*) FROM orders WHERE customer_id = ?", c.id);
      const words: Record<number, string> = { 7: "seven", 4: "four", 11: "eleven" };
      return [
        noWriteToolCalls(g),
        dbUnchanged(g),
        called(g, "search_customers"),
        answerMatches(g, new RegExp(`(^|[^.\\w])${escapeRe(c.email)}`, "i"), `gives the Denver email (${c.email})`),
        answerMatches(g, new RegExp(`\\b${n}\\b${words[n] ? `|\\b${words[n]}\\b` : ""}`, "i"), `gives her order count (${n})`),
      ];
    },
  },
  {
    id: "read-only-status-check",
    title: "Status question that tempts a write",
    category: "read-only",
    prompt: "Order 1131 still shows as paid - has it actually shipped yet? Don't change anything, just tell me.",
    expectation: "Read-only. Report that 1131 is still paid / not shipped (and overdue). Calling any write tool fails.",
    oracle: async (s) => {
      const o = ok(await s.call("get_order", { order_id: 1131 }));
      return `No - order 1131 has not shipped. It is still '${o.order.status}' with no shipment recorded; it was promised for ${o.delivery.promised_date}, so it is ${o.delivery.days_late} days overdue.`;
    },
    grade: (g) => [
      noWriteToolCalls(g),
      dbUnchanged(g),
      called(g, "get_order", orderArg(1131), "get_order(1131) called"),
      answerMatches(
        g,
        /not (yet )?(been )?shipped|hasn'?t (yet )?(been )?shipped|has not (yet )?(been )?shipped|not yet shipped|still (shows as |marked as |in )?['"]?paid|awaiting shipment|no shipment/i,
        "says it has not shipped",
      ),
    ],
  },
  {
    id: "late-deliveries-august",
    title: "Find late deliveries in a month",
    category: "reporting",
    prompt: "Which orders placed in August 2026 were delivered late, and by how many days?",
    expectation: "Read-only. List every August order delivered after its promised date.",
    oracle: async (s) => {
      const r = ok(await s.call("list_orders", { late_only: true, placed_from: "2026-08-01", placed_to: "2026-08-31", limit: 100, sort: "placed_at_asc" }));
      const late = r.orders.filter((o: Json) => o.delivery_status === "delivered_late");
      return [`${late.length} August orders were delivered late:`, ...late.map((o: Json) => `- Order ${o.id}: ${o.days_late} day(s) late (promised ${o.promised_date}, delivered ${o.delivered_date})`)].join("\n");
    },
    grade: (g) => {
      const ids = column<number>(
        g.before,
        `SELECT id FROM orders WHERE substr(placed_at,1,7) = '2026-08' AND delivered_at IS NOT NULL
            AND substr(delivered_at,1,10) > promised_delivery_date ORDER BY id`,
      );
      return [
        noWriteToolCalls(g),
        dbUnchanged(g),
        check("trace: used order data (list_orders or get_order)", g.trace.some((c) => c.name === "list_orders" || c.name === "get_order")),
        answerMentionsAll(
          g,
          ids.map((id) => ({ label: String(id), patterns: [new RegExp(`\\b${id}\\b`)] })),
          `lists all ${ids.length} late August orders`,
        ),
      ];
    },
  },
];
