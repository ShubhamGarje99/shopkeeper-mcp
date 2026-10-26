# 90-second Loom script: Shopkeeper MCP

Goal: show a client, in 90 seconds, that you can build an MCP server that is **useful**, **safe on writes**, and **measured with evals**.

## Before you hit record

- [ ] `npm install && npm run seed && npm run build` (fresh store data)
- [ ] Terminal: large font (18pt+), dark theme, repo root, history cleared. Close Slack and mail, turn on Do Not Disturb.
- [ ] Browser tab 1: the repo README on GitHub (or a local Markdown preview), scrolled to the top.
- [ ] Browser tab 2: `npm run inspect` already running (it prints the URL with a token); click **Connect** once so the tool list is loaded.
- [ ] Optional: Claude Desktop configured with the snippet from the README and restarted. Run `npm run seed` right before recording so order 1042 is unrefunded.
- [ ] Optional (if `ANTHROPIC_API_KEY` is set): run `npm run eval` once beforehand so `EVAL_REPORT.md` has the live row filled in.
- [ ] Have `EVAL_REPORT.md` open in a Markdown preview at the "Scenario matrix" section.

## Script

| Time | On screen | Say (roughly) |
|---|---|---|
| **0:00 to 0:10** | README hero: one-liner and the results table | "This is Shopkeeper, an MCP server I built so Claude can run a store's back office: orders, refunds, invoices, reports. The part most demos skip: it ships with guardrails and evals." |
| **0:10 to 0:25** | Inspector, **Tools** tab: scroll the 8 tools, open `issue_refund` to show annotations and schema | "Eight tools: five read-only, three that write, and they're annotated that way so the host knows which ones need confirmation. Inputs are strict zod schemas, and money is integer cents." |
| **0:25 to 0:40** | Inspector: run `get_order` with `order_id: 1042`, then point at `delivery.status: delivered_late`, `days_late: 3` | "Every order comes back with what an agent needs before it acts: refunds so far, what's still refundable, and the promised versus actual delivery date. This one arrived three days late." |
| **0:40 to 0:55** | Inspector: run `issue_refund` with order `1010`, `amount_cents: 50000`, any reason and key, to show `GUARDRAIL_VIOLATION`. Then run `issue_refund` for 1042 (`10500`) **twice with the same key** and show `replayed: true` | "Guardrails live in the server, not the prompt. Ask for $500 on a $58.95 order and it's refused with a machine-readable error. And refunds need an idempotency key, so if an agent retries after a timeout, the second call replays instead of paying twice." |
| **0:55 to 1:15** | Terminal: `npm run eval:oracle` (finishes in a few seconds, 15/15). Then switch to `EVAL_REPORT.md` and the scenario matrix | "Then the evals. Fifteen real requests: late refunds, over-refunds, an ambiguous customer name, read-only questions that tempt a write. Each run gets a fresh database and the real server, and the graders check the final database state and the tool-call trace, not just the wording. The scripted oracle scores 15 out of 15, which proves the graders. A naive agent scores 6 and a do-nothing agent scores 0, which proves they discriminate. `npm run eval` runs the same suite against Claude and reports pass rate, tokens and cost." |
| **1:15 to 1:30** | Optional Claude Desktop: type "Refund order 1043 if it arrived late". Otherwise back to the README "Design decisions" | "If you need an agent that touches real data, whether that's an MCP server, LangGraph or a RAG pipeline, I build it with the guardrails and the evals from day one, so you can see it works before you ship it. Links are below." |

## Fallbacks

- **Inspector won't connect:** use `npm run inspect:cli` (terminal tool list) and `npm run smoke`, which prints a read and the $500 refusal.
- **Running long:** drop the Claude Desktop beat; the eval matrix is the more important closing shot.
- **No API key:** say "live Claude numbers are one command away", and don't show a live row that doesn't exist.

## After recording

- Re-run `npm run seed` (the demo refunds changed the data).
- Paste the Loom link into the README "Screenshots" section and into the Upwork portfolio item.
