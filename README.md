# Macro Crash Check

A market-crash-monitoring system that replaced a giant static prompt
(hand-updated numbers pasted into an LLM chat every time) with a small
pipeline: live data ingestion, a deterministic rule engine, a local MCP
server, and three reporting surfaces — a chat-rendered deep-dive report, a
public historical dashboard, and a private "Full Report" page.

The core idea: **numeric classification is never an LLM's job.** Every
threshold, band, and RED/AMBER/GREEN color is computed by plain code from
real market data. The LLM's job is qualitative — reading news, judging Fed
communication, synthesizing a narrative — and it always renders what the
rule engine already decided, never re-derives it.

**This is a stress-monitoring and discretionary deployment dashboard, not a
calibrated crash-probability model.** The 6-indicator panel, band colors,
confirmation windows, and wave-trigger thresholds are genuinely deterministic.
Crash probability, crash-type diagnosis, and the Fed/Warsh classification are
not — they're LLM/human qualitative judgment with no defined forecast
horizon, no historical labels, and no back-testing behind the displayed
percentage. Both public-facing report pages say this explicitly now (added
2026-08-15, after an external review flagged the gap between the system's
framing and what it actually does) — see
`reference_docs/architecture-summary-for-external-review.md` for the full
findings-and-status writeup.

## Architecture

```
FRED / EIA / Massive (market data)
        │
        ▼  (GitHub Action, 10am ET daily, weekdays)
┌───────────────┐     ┌──────────────────────┐     ┌──────────────┐
│  ingestion/    │────▶│  Supabase             │◀────│ rule_engine/ │
│  (plausibility │     │  (data_points,        │     │ (deterministic│
│  guard on the  │     │  crash_checks,        │     │  classify +  │
│  way in)       │     │  watchlist_tickers,   │     │  ntfy push)  │
└───────────────┘     │  full_report_snapshots,│     └──────────────┘
                       │  portfolio_review_     │
                       │  snapshots)            │
                       └──────────┬─────────────┘
                                  │
             ┌────────────────────┼────────────────────┬───────────────────┐
             ▼                    ▼                     ▼                   ▼
   ┌──────────────────┐ ┌──────────────┐    ┌────────────────────┐ ┌──────────────────┐
   │  mcp_server/      │ │ dashboard_   │    │ full_report_site/   │ │ Claude Desktop    │
   │  (local, stdio,   │ │ site/        │    │ (Cloudflare Pages    │ │ chat — renders    │
   │  14 tools, incl.  │ │ (Cloudflare  │    │ Function, service_   │ │ dashboard-        │
   │  5 write/persist  │ │ Pages,       │    │ role key, Cloudflare │ │ template.html /   │
   │  tools + a data-  │ │ public,      │    │ Access-gated: OTP    │ │ portfolio-review-  │
   │  freshness check) │ │ read-only)   │    │ or GitHub login)     │ │ template.html     │
   └────────┬──────────┘ └──────────────┘    └──────────────────────┘ └───────────────────┘
            │
   scheduled: Claude Desktop task,
   "run crash check" daily at 2pm ET
```

### Layers

| Layer | What it does | Where |
|---|---|---|
| **Rules** | Static thresholds, bands, wave-deployment percentages, crash-type diagnosis criteria | `reference_docs/rules/crash-check-rules.md` |
| **Ingestion** | Pulls FRED/EIA/Massive market series daily, with a plausibility guard that quarantines implausible values before they ever reach Supabase. The one-time backfill script pulls each FRED series' full available history (since 2026-08-15 — previously a rolling 5yr window), not just enough for the "All" chart toggle | `ingestion/` (GitHub Action, `.github/workflows/ingest.yml`, 10am ET weekdays) |
| **Rule engine** | Computes the 6-indicator RED/AMBER/GREEN panel, confirmation windows, wave authorization (ATH-relative drawdown % triggers, not fixed S&P levels), cross-indicator divergence detection, and fires a push notification on a confirmed-RED threshold crossing — pure functions, no LLM | `rule_engine/` |
| **MCP server** | Local stdio server exposing 14 tools to Claude Desktop — indicator panel, portfolio drift, watchlist status, deployment plan, historical deltas, a data-freshness check, and 5 persistence tools | `mcp_server/` |
| **Reporting** | Chat-rendered HTML reports (2 templates), a public historical dashboard, and a private Full Report page merging crash-check + portfolio-review content | `reference_docs/rules/*.html`, `dashboard_site/`, `full_report_site/` |

## The 6-indicator panel

VIX, HY credit spreads, S&P drawdown from ATH, 10yr Treasury yield, the
Sahm Rule, and Fed pivot signal. Wave deployment (a staged, 3-tranche
dry-powder deployment plan) authorizes only when 3 or more are
simultaneously RED — and, per the Signal Tiering confirmation-window rule,
only once a RED reading holds across 2+ distinct ingestion dates, not just
a single noisy print. Full thresholds and the wave-deployment math live in
`reference_docs/rules/crash-check-rules.md`.

**Wave deployment** triggers on ATH-relative S&P drawdown % (16/24/35 for
Waves 1/2/3), not fixed nominal index levels — a fixed level decays in
meaning as the market's all-time high rises over time; a drawdown
percentage doesn't. `get_deployment_plan` requires *both* the price/VIX
trigger and `wave_authorized` (the confirmed 3-of-6-RED gate) before
returning a dollar plan — previously it only checked the former. Deployment
is cumulative and execution-aware: a fast, deep drawdown that satisfies
Wave 3's condition without Wave 1/2 ever separately confirming still
returns the combined breakdown for every not-yet-executed wave, and
`record_wave_deployment` tracks which waves have actually been executed
(`local_state/wave_deployment_state.yaml`) so an executed wave isn't
re-proposed.

Supplementary Tier 2 context — financial stress indices, breakeven
inflation, continuing jobless claims, investment-grade credit spreads,
2s10s curve, WTI, retail sales, repo/liquidity stress (SOFR), the broad
dollar index, bank-funding/credit-conditions stress (NFCI risk/credit
subindexes), the 10yr TIPS real yield, etc. — is available via
`get_context_indicators` and on `dashboard_site`, informational only,
never part of the gate. `get_series_deltas` provides real 3-day/7-day
historical lookback for any series, fulfilling the rules doc's
delta-reporting requirement.

**Cross-indicator divergence detection**: three pairs of normally-correlated
series (IG-vs-HY credit spreads, initial-vs-continuing jobless claims,
VIX-vs-HY credit spreads) are checked daily for a 7-day-delta split large
enough to suggest they've decoupled — a relationship-level signal the
6-indicator panel's individual bands can't see. Computed once in
`classify()` and persisted to `crash_checks.divergence_flags`, so
`get_context_indicators` and `dashboard_site`'s "Signal Relationships" card
both read the same value rather than recomputing it independently. VIX-vs-HY
is the one pair where a flagged divergence is the *reassuring* reading
(equity-specific noise, not confirmed credit stress) — the opposite of the
other two.

## Security model — split storage

This system deliberately never lets personal financial data reach a cloud
service:

- **Supabase** holds macro/market data and — as of the Full Report page —
  crash-type diagnosis narrative and Portfolio Opportunity Review content
  (drift %, ticker thesis, risk-radar scores). **No dollar figures, no
  account balances, ever** — enforced in code, not just by convention:
  every write path that persists free text (`write_snapshot`,
  `write_full_report`, `write_portfolio_review`) cross-references the real
  local portfolio file's actual dollar figures and throws before writing
  if any appear.
- **`local_state/`** (gitignored, never committed) holds the real
  portfolio file — account balances, dry powder, allocation targets, the
  BrokerageLink watchlist's position sizing (`max_position_usd`, which
  never reaches Supabase even though everything else about the watchlist
  now does), and which wave-deployment tranches have actually been
  executed (`wave_deployment_state.yaml`) — action state tied to real
  trades, same trust boundary as the rest of this directory. Read only by
  the local MCP server.
- **The MCP server runs locally via stdio**, not as a hosted service —
  because it's the one component that touches `local_state/`.
- **Two access tiers in Supabase**: `crash_checks`/`data_points`/
  `watchlist_tickers` are anon-readable (RLS + GRANT scoped to macro-only
  data — safe to share publicly, which is exactly what `dashboard_site`
  does). `full_report_snapshots`/`portfolio_review_snapshots` are **never**
  anon-readable (RLS deny-all for anon/authenticated) — the only reader is
  the `full_report_site` Cloudflare Pages Function, which holds the
  `service_role` key server-side (never shipped to the browser) behind
  Cloudflare Access.

Wave-deployment amounts in the committed rules doc are percentages of "dry
powder," not dollar figures — the MCP server combines that percentage with
the real, local-only balance at read time, and that output is chat-only,
never persisted.

## Two reporting sites

- **`dashboard_site`** (public, `market-sentiment-analyzer.pages.dev`, page
  title "Macro Market Stress Monitor" as of 2026-08-16 — renamed from
  "Macro Crash Check" since that name implied prediction/detection rather
  than monitoring) — historical trend charts and the current indicator
  panel, reading only anon-safe macro data. Intentionally left
  unauthenticated so it can be shared with others.
- **`full_report_site`** (private, `market-sentiment-full-report.pages.dev`,
  Cloudflare Access-gated via email one-time-PIN or GitHub login) — the BrokerageLink
  watchlist with live status, crash-type diagnosis, qualitative portfolio
  context, and the full Portfolio Opportunity Review (drift bars, ticker
  thesis re-underwrite, macro cross-reference, a server-side-rendered risk
  radar chart). Rendered server-side by a Cloudflare Pages Function using
  the `service_role` key — no client-embedded credential to leak.

Both are installable as a home-screen PWA (manifest + icons, no service
worker — deliberately avoids caching the Access-gated site's content past
a logged-out session). The installed app shows a refresh button (standalone
mode strips the browser's own pull-to-refresh/URL bar); a normal browser
tab doesn't show it, since it doesn't need it.

## Repo structure

```
ingestion/            Stage 2 — pulls FRED/EIA/Massive data into Supabase, plausibility-guarded
rule_engine/           Stage 3 — deterministic classification + threshold-crossing push notification
mcp_server/            Stage 4 — local MCP tools for Claude Desktop (14 tools)
dashboard_site/        Public Cloudflare Pages reporting site
full_report_site/      Private Cloudflare Pages Function — Access-gated Full Report page
reference_docs/rules/  Source-of-truth rules doc + the two chat-report HTML templates
supabase/migrations/   Schema history
local_state/           Gitignored — real portfolio/watchlist data lives here, never committed
.github/workflows/     Daily ingestion+classification cron, one-time backfill
```

## Setup

Each of `ingestion/`, `rule_engine/`, and `mcp_server/` has a `.env.example`
— copy to `.env` and fill in:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase project
- `FRED_API_KEY` — free at fred.stlouisfed.org/docs/api/api_key.html
- `EIA_API_KEY` — free at eia.gov/opendata/register.php
- `MASSIVE_API_KEY` — free tier at massive.com, for watchlist ticker prices
- `NTFY_TOPIC` (optional) — a random, unguessable ntfy.sh topic name for
  push notifications on a confirmed-RED threshold crossing

`mcp_server/.env.example` additionally has `PORTFOLIO_PATH`,
`WATCHLIST_PATH`, and `WAVE_DEPLOYMENT_STATE_PATH` — absolute paths to the
three local, gitignored YAML files under `local_state/` (copy each
`*.example.yaml` there first).

Apply `supabase/migrations/` in order via the Supabase SQL editor or CLI.
GitHub Actions secrets mirror the same values for the scheduled ingestion
job (`.github/workflows/ingest.yml`).

For Claude Desktop: point an MCP server entry at
`mcp_server/src/server.ts` (via `npx tsx`), and attach
`reference_docs/rules/crash-check-rules.md` +
`reference_docs/rules/dashboard-template.html` +
`reference_docs/rules/portfolio-review-template.html` +
`reference_docs/rules/project-instructions.md` as project knowledge.

For `full_report_site`: a separate Cloudflare Pages project (root
directory `full_report_site`), `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
as encrypted environment variables, and a Cloudflare Access Application
with a One-Time-PIN identity provider scoped to your email — see
`full_report_site/README.md` for the exact steps and gotchas. A GitHub
OAuth identity provider can be added alongside OTP for lower-friction
login (register a GitHub OAuth App with callback
`https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`,
add it under Zero Trust → Settings → Authentication, then allow your
GitHub account's email in the Access policy).

## Two chat-triggered workflows

- **"Run crash check"** (also runs unattended via a daily Claude Desktop
  scheduled task, 2pm ET — after a data-freshness check confirms
  ingestion actually ran) — pulls the current indicator panel, contextual
  macro indicators, and (if a wave is active) the deployment plan; commits
  to a crash-probability estimate before ever seeing the prior one
  (anti-anchoring); does qualitative research; renders
  `dashboard-template.html`; persists via `write_snapshot` and
  `write_full_report`.
- **"Run portfolio review"** (on-demand, no fixed schedule) — checks
  portfolio drift against long-term targets, watchlist ticker status
  against Wave price targets, cross-references macro/geopolitical sources,
  and re-underwrites the BrokerageLink watchlist thesis; renders
  `portfolio-review-template.html`; persists via `write_portfolio_review`
  (merged into the Full Report page) and, if the user approves ticker
  changes, `write_watchlist`.

## Known gaps / backlog

See [`BACKLOG.md`](BACKLOG.md) for open items — things deliberately
deferred rather than forgotten.
