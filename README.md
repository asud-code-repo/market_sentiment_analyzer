# Macro Crash Check

A market-crash-monitoring system that replaced a giant static prompt
(hand-updated numbers pasted into an LLM chat every time) with a small
pipeline: live data ingestion, a deterministic rule engine, a local MCP
server, and two reporting surfaces — a chat-rendered deep-dive report and a
public historical dashboard.

The core idea: **numeric classification is never an LLM's job.** Every
threshold, band, and RED/AMBER/GREEN color is computed by plain code from
real market data. The LLM's job is qualitative — reading news, judging Fed
communication, synthesizing a narrative — and it always renders what the
rule engine already decided, never re-derives it.

## Architecture

```
FRED / EIA / Massive (market data)
        │
        ▼
┌───────────────┐     ┌────────────────┐     ┌──────────────┐
│  ingestion/    │────▶│  Supabase      │◀────│ rule_engine/ │
│  (GitHub       │     │  (data_points, │     │ (deterministic│
│  Action, daily)│     │  crash_checks) │     │  classify)   │
└───────────────┘     └────────┬───────┘     └──────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            ┌───────────────┐      ┌─────────────────┐
            │  mcp_server/   │      │  dashboard_site/ │
            │  (local, stdio,│      │  (Cloudflare      │
            │  Claude Desktop│      │  Pages, public,   │
            │  tool calls)   │      │  read-only)       │
            └───────┬────────┘      └─────────────────┘
                    │
                    ▼
        Claude Desktop chat — renders
        dashboard-template.html /
        portfolio-review-template.html
```

### Layers

| Layer | What it does | Where |
|---|---|---|
| **Rules** | Static thresholds, bands, wave-deployment percentages, crash-type diagnosis criteria | `reference_docs/rules/crash-check-rules.md` |
| **Ingestion** | Pulls FRED/EIA macro series + watchlist ticker prices daily | `ingestion/` (GitHub Action, `.github/workflows/ingest.yml`) |
| **Rule engine** | Computes the 6-indicator RED/AMBER/GREEN panel, confirmation windows, wave authorization — pure functions, no LLM | `rule_engine/` |
| **MCP server** | Local stdio server exposing 10 tools to Claude Desktop (indicator panel, portfolio drift, watchlist status, deployment plan, etc.) | `mcp_server/` |
| **Reporting** | Two surfaces: a rich chat-rendered report template, and a public historical trend-chart dashboard | `reference_docs/rules/*.html`, `dashboard_site/` |

## The 6-indicator panel

VIX, HY credit spreads, S&P drawdown from ATH, 10yr Treasury yield, the
Sahm Rule, and Fed pivot signal. Wave deployment (a staged, 3-tranche
dry-powder deployment plan) authorizes only when 3 or more are
simultaneously RED — and, per the Signal Tiering confirmation-window rule,
only once a RED reading holds across 2+ distinct ingestion dates, not just
a single noisy print. Full thresholds and the wave-deployment math live in
`reference_docs/rules/crash-check-rules.md`.

## Security model — split storage

This system deliberately never lets personal financial data reach a cloud
service:

- **Supabase** (`crash_checks`, `data_points`) holds macro/market data only
  — VIX, CPI, wave status, indicator colors, crash probability. No dollar
  figures, no account balances, ever.
- **`local_state/`** (gitignored, never committed) holds the real
  portfolio file — account balances, dry powder, allocation targets. Read
  only by the local MCP server.
- **The MCP server runs locally via stdio**, not as a hosted service —
  because it's the one component that touches `local_state/`.

Wave-deployment amounts in the committed rules doc are percentages of "dry
powder," not dollar figures — the MCP server combines that percentage with
the real, local-only balance at read time.

## Repo structure

```
ingestion/           Stage 2 — pulls FRED/EIA/Massive data into Supabase
rule_engine/         Stage 3 — deterministic classification (rule_engine/src/classify.ts)
mcp_server/          Stage 4 — local MCP tools for Claude Desktop
dashboard_site/       Public Cloudflare Pages reporting site
reference_docs/rules/ Source-of-truth rules doc + the two chat-report HTML templates
supabase/migrations/  Schema history
local_state/          Gitignored — real portfolio data lives here, never committed
.github/workflows/    Daily ingestion+classification cron, one-time backfill
```

## Setup

Each of `ingestion/`, `rule_engine/`, and `mcp_server/` has a `.env.example`
— copy to `.env` and fill in:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase project
- `FRED_API_KEY` — free at fred.stlouisfed.org/docs/api/api_key.html
- `EIA_API_KEY` — free at eia.gov/opendata/register.php
- `MASSIVE_API_KEY` — free tier at massive.com, for watchlist ticker prices

Apply `supabase/migrations/` in order via the Supabase SQL editor or CLI.
GitHub Actions secrets mirror the same `.env` values for the scheduled
ingestion job (`.github/workflows/ingest.yml`).

For Claude Desktop: point an MCP server entry at
`mcp_server/src/server.ts` (via `npx tsx`), and attach
`reference_docs/rules/crash-check-rules.md` +
`reference_docs/rules/dashboard-template.html` +
`reference_docs/rules/portfolio-review-template.html` as project
knowledge.

## Two chat-triggered workflows

- **"Run crash check"** — pulls the current indicator panel, contextual
  macro indicators, and (if a wave is active) the deployment plan; does
  qualitative research; renders `dashboard-template.html`; persists the
  qualitative synthesis back via `write_snapshot`.
- **"Run portfolio review"** (on-demand, no fixed schedule) — checks
  portfolio drift against long-term targets, watchlist ticker status
  against Wave price targets, cross-references macro/geopolitical sources,
  and re-underwrites the BrokerageLink watchlist thesis; renders
  `portfolio-review-template.html`.

## Known gaps / backlog

See [`BACKLOG.md`](BACKLOG.md) for open items — things deliberately
deferred rather than forgotten.
