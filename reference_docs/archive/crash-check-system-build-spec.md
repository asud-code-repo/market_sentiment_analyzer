# Macro Crash Check System — Build Spec for Claude Code

## Context

I run a recurring "macro crash check" analysis (market crash risk assessment + personal portfolio tactical positioning) currently as a giant static master prompt (v3.3, ~4,000+ tokens) that I manually re-paste into a fresh Claude Desktop chat every time, updating the "current state" numbers by hand. This is inefficient, error-prone, and doesn't give real delta tracking between runs.

Goal: build a system that separates **static rules**, **live state**, and **data ingestion** into their own layers, so a chat interface only needs to make a few tool calls to get current, accurate context — instead of re-ingesting a giant document and re-deriving everything from scratch each time.

Master prompt reference doc (source of truth for all rules, thresholds, allocations): will be provided separately as `docs/master-prompt-v3.3.md`. Read it fully before building anything — it contains the actual classification logic, wave thresholds, and allocation tables that the code below needs to encode faithfully. Do not invent or simplify these numbers; pull them directly from that doc.

---

## Architecture — four layers

**1. Rules (static, rarely changes)**
Lives as a reference doc / config, not re-sent every run. Encodes: Warsh HAWKISH/MODERATE/DOVISH classification criteria, crash-type diagnosis rules (Types A–E), wave deployment thresholds (Wave 1/2/3), long-term target allocations, indicator RED/AMBER/GREEN bands.

**2. State (live, changes constantly)**
Stored in Supabase Postgres. Each crash check run is a row. Includes crash probability, 6-indicator readings, trigger statuses, prior-run comparison. This is what eliminates manual re-pasting — a run reads the latest row, writes a new one.

**3. Data ingestion (scheduled, deterministic)**
GitHub Action on a cron schedule pulls numeric data from free APIs (FRED, EIA, CBOE, Polymarket, etc.) and writes clean values into Supabase. No LLM involved in this step — pure fetch + write.

**4. Rule engine (deterministic classification)**
A script (can live in the GitHub Action or as a Supabase Edge Function) applies the RED/AMBER/GREEN bands, counts REDs, checks wave triggers, and evaluates the Warsh classification gates — all pure logic, not LLM judgment. This keeps classification consistent run to run.

**What's left for the LLM (Claude, via chat):** qualitative synthesis — geopolitical read, earnings commentary, crash-type diagnosis narrative, dashboard presentation — plus web search for things with no clean API (geopolitics, Fed rhetoric, earnings calls). Claude reads state via a tool call, does NOT re-derive classification math, and writes the new snapshot back via a tool call.

---

## Task breakdown (build in this order)

### Stage 1 — Supabase schema
Design and create tables:
- `crash_checks` — one row per run. Columns should cover: run timestamp, crash probability + range, scenario distribution (bull/base/bear/crash %), 6 indicator readings + colors, RED count, Warsh classification status, trigger statuses (4 personal triggers), notes/narrative summary, raw source data snapshot (jsonb).
- `latest_snapshot` — single-row (or view) convenience table pointing at the most recent `crash_checks` row, so reads don't need ORDER BY + LIMIT every time.
- Consider a `data_points` table for raw ingested numeric series (CPI, VIX, 10yr yield, HY spreads, etc.) with timestamp + source, separate from the derived `crash_checks` interpretation — keeps raw data auditable independent of the rule engine's classification.

Write migrations. Use Supabase CLI conventions.

### Stage 2 — Data ingestion (GitHub Action)
Cron job (daily, or a few times/week — confirm cadence with me) that:
- Pulls from: FRED (STLFSI4, NFCI, BAMLH0A0HYM2, T10YIE, DRTSCILM, RRPONTSYD, CPI, unemployment, 10yr/2yr/30yr yields), CBOE put/call CSV, EIA weekly petroleum, Polymarket API, and any other free sources referenced in the master prompt doc.
- Normalizes and writes results into `data_points` in Supabase.
- Fails loudly (GitHub Action failure notification) if a source is unreachable — don't silently write stale/null data.

### Stage 3 — Rule engine (classification logic)
Deterministic script, run either as part of the ingestion Action or as a separate Supabase function, that:
- Applies the 6-indicator RED/AMBER/GREEN bands from the master prompt (VIX, HY spreads, S&P drawdown from ATH, 10yr yield, Sahm Rule, Fed pivot signal).
- Counts REDs and checks the 3-of-6 wave authorization rule.
- Evaluates Warsh classification (HAWKISH/MODERATE/DOVISH) per the stated criteria.
- Checks each of the 4 personal decision triggers (fired / approaching / pending) against current dates and data.
- Writes results into `crash_checks`.

This is the layer that must exactly encode the master prompt's numeric thresholds — treat the master prompt doc as the spec, not a rough guide.

### Stage 4 — MCP tool layer
Build an MCP server (or Cloudflare Worker exposing MCP-compatible tools) that exposes at minimum:
- `get_latest_snapshot` — returns most recent `crash_checks` row + delta vs prior row.
- `get_indicator_panel` — returns current 6-indicator readings with colors.
- `get_trigger_status` — returns status of the 4 personal decision triggers.
- `write_snapshot` — allows a chat-side "run check" to persist a new synthesized snapshot (crash probability, scenario distribution, narrative) back to Supabase, so next run's delta calc is automatic.

This is what a Claude Desktop chat (or any client) connects to, instead of me re-pasting the master prompt.

### Stage 5 (optional, later) — Cloudflare Pages dashboard + Access
Simple read-only dashboard visualizing `crash_checks` history — indicator panel over time, crash probability trend, trigger status. Gated with Cloudflare Access. Lower priority than Stages 1–4.

---

## Explicit non-goals / constraints

- **Do not automate the rules layer.** Wave thresholds, crash-type criteria, and allocation targets are set by me and reviewed manually when they change. The rule engine executes the current rules faithfully; it does not propose or auto-update them.
- **Do not let the LLM do numeric classification at run time.** RED/AMBER/GREEN, RED counts, and Warsh gate status must come from the deterministic rule engine's output, not be re-derived by Claude reasoning over raw numbers in chat.
- Keep the ingestion layer's data sources to free/public APIs only (no paid data feeds) — the master prompt doc lists the specific free sources already identified.
- Personal account data (401k/RRSP balances, allocations) stays out of any automated pipeline — that's manually updated context, not something to scrape from custodian sites.

---

## First message to send Claude Code

Paste this file plus the master prompt doc (`master-prompt-v3.3.md`) into a new repo, then ask Claude Code to:
1. Read both docs fully.
2. Propose the exact Supabase schema (table + column definitions) for Stage 1, for review before creating anything.
3. Once schema is approved, scaffold the repo structure (folders for the GitHub Action, rule engine, MCP server) before writing implementation code.
