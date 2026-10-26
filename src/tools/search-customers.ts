import { z } from "zod";
import { normalizeText, tokenSimilarity } from "../domain/fuzzy.js";
import { REVENUE_STATUSES } from "../domain/status-machine.js";
import { defineTool, readOnlyAnnotations } from "./types.js";

const MATCH_TYPES = ["exact_email", "exact_name", "partial", "fuzzy"] as const;
const FUZZY_THRESHOLD = 0.72;

const input = z.strictObject({
  query: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe("Name, email, or part of either. Case/accent-insensitive and tolerant of typos (e.g. 'jon benett')."),
  limit: z.number().int().min(1).max(25).default(10).describe("Maximum matches to return (default 10)."),
});

const match = z.object({
  customer_id: z.number().int(),
  name: z.string(),
  email: z.string(),
  city: z.string(),
  region: z.string(),
  match_type: z.enum(MATCH_TYPES),
  score: z.number().describe("0-1 relevance; exact email = 1.0"),
  order_count: z.number().int(),
  lifetime_net_spend_cents: z.number().int().describe("Paid order totals minus refunds, in cents."),
  last_order_at: z.string().nullable(),
});

const output = z.object({
  query: z.string(),
  matches: z.array(match),
  ambiguous: z.boolean().describe("True when more than one customer matches equally well - confirm with the user before acting."),
  note: z.string().nullable(),
});

interface CustomerRow {
  id: number;
  name: string;
  email: string;
  city: string;
  region: string;
  order_count: number;
  gross_cents: number;
  refunded_cents: number;
  last_order_at: string | null;
}

export const searchCustomers = defineTool({
  name: "search_customers",
  title: "Search customers",
  kind: "read",
  description:
    "Find customers by name or email (exact, partial, or fuzzy/misspelled). Returns contact details, order count and lifetime spend for each match. If `ambiguous` is true, several customers fit equally well: ask the user which one they mean (e.g. by email or city) before acting.",
  input,
  output,
  annotations: readOnlyAnnotations("Search customers"),
  handler: ({ db }, { query, limit }) => {
    const statuses = REVENUE_STATUSES.map((s) => `'${s}'`).join(",");
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.email, c.city, c.region,
                COUNT(o.id) AS order_count,
                COALESCE(SUM(CASE WHEN o.status IN (${statuses}) THEN o.total_cents ELSE 0 END), 0) AS gross_cents,
                COALESCE((SELECT SUM(r.amount_cents) FROM refunds r JOIN orders o2 ON o2.id = r.order_id
                          WHERE o2.customer_id = c.id), 0) AS refunded_cents,
                MAX(o.placed_at) AS last_order_at
           FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
          GROUP BY c.id ORDER BY c.id`,
      )
      .all() as unknown as CustomerRow[];

    const q = normalizeText(query);
    const scored = rows
      .map((c) => {
        const name = normalizeText(c.name);
        const email = c.email.toLowerCase();
        let matchType: (typeof MATCH_TYPES)[number] | null = null;
        let score = 0;
        if (email === q) [matchType, score] = ["exact_email", 1];
        else if (name === q) [matchType, score] = ["exact_name", 0.98];
        else if (name.includes(q) || email.includes(q)) [matchType, score] = ["partial", 0.9];
        else {
          const sim = tokenSimilarity(q, c.name);
          if (sim >= FUZZY_THRESHOLD) [matchType, score] = ["fuzzy", Math.round(sim * 0.85 * 100) / 100];
        }
        return matchType ? { c, matchType, score } : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name) || a.c.id - b.c.id);

    const top = scored[0]?.score ?? 0;
    const tied = scored.filter((m) => top - m.score < 0.05);
    const ambiguous = tied.length > 1;
    const matches = scored.slice(0, limit).map(({ c, matchType, score }) => ({
      customer_id: c.id,
      name: c.name,
      email: c.email,
      city: c.city,
      region: c.region,
      match_type: matchType,
      score,
      order_count: c.order_count,
      lifetime_net_spend_cents: c.gross_cents - c.refunded_cents,
      last_order_at: c.last_order_at,
    }));

    const note = ambiguous
      ? `${tied.length} customers match "${query}" equally well. Confirm which one (e.g. by email or city) before acting on their behalf.`
      : matches.length === 0
        ? `No customers match "${query}".`
        : null;

    const lines = matches.map(
      (m) => `- #${m.customer_id} ${m.name} <${m.email}> (${m.city}, ${m.region}) - ${m.match_type}, ${m.order_count} orders`,
    );
    const summary = [`${matches.length} match(es) for "${query}".${note ? ` ${note}` : ""}`, ...lines].join("\n");
    return { data: { query, matches, ambiguous, note }, summary };
  },
});
