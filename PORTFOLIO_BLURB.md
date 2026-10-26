# Portfolio blurb

## Title

Shopkeeper MCP: a guarded store back office for Claude, with evals

## Description (3 lines)

An MCP server in TypeScript that lets Claude handle orders, refunds, invoices, sales reports and inventory for an online store, with server-side guardrails: refund caps, idempotency keys that make retries safe, an order state machine, and an audit log.
It ships with an eval harness that runs 15 realistic requests against the real server and a fresh database each time, and grades them deterministically on final DB state, tool-call trace and answer (oracle 15/15, naive baseline 6/15, no-op 0/15).
92 tests, typed errors, MCP annotations, Inspector-ready, and drop-in configs for Claude Desktop and Claude Code.

## Skills / tags

Model Context Protocol (MCP), MCP Server, Claude API, Anthropic SDK, AI Agents, Tool Use / Function Calling, LLM Evaluation, Agent Evals, TypeScript, Node.js, SQLite, Zod, Vitest, API Design, Idempotency, Guardrails, AI Safety
