# Macro Crash Check — Architecture & Rules Summary (for external AI review)

This is a self-contained briefing for a fresh model/chat with no other context on this
project. It covers system architecture, data flow, security model, and the full current
rules (thresholds/bands/formulas) that govern the crash-detection and wave-deployment
logic. Paste this whole document as context when asking another model to analyze or
propose changes to the rules — nothing here is sensitive (no dollar figures, no
credentials, no personal account data).

## What this system is

A market-crash-monitoring pipeline that replaced a giant hand-updated prompt with a
small, deterministic pipeline: live data ingestion → a rule engine that classifies
market conditions → a local MCP server exposing tools to Claude Desktop → two
reporting surfaces (a rich on-demand chat report, and two public/private web
dashboards).

**Core design philosophy: numeric classification is never an LLM's job.** Every
threshold, band, and RED/AMBER/GREEN color is computed by plain deterministic code
from real market data — never inferred, estimated, or "reasonably judged" by an LLM
at report time. The LLM's job is strictly qualitative: reading news, judging Fed
communication, writing narrative synthesis — and it always *renders* what the rule
engine already decided, never re-derives or restates it with different precision.

## Architecture

```
FRED / EIA / Massive.com (market & macro data)
        │
        ▼  (GitHub Action, daily 10am ET, weekdays)
┌────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│  ingestion/     │────▶│  Supabase (Postgres) │◀────│  rule_engine/  │
│  fetch + upsert │     │  data_points,         │     │  classify.ts   │
└────────────────┘     │  crash_checks,        │     │  (deterministic)│
                        │  watchlist_tickers,   │     └────────────────┘
                        │  full_report_snapshots,│
                        │  portfolio_review_     │
                        │  snapshots            │
                        └──────────┬────────────┘
                                   │
                ┌──────────────────┼───────────────────┬─────────────────────┐
                ▼                  ▼                   ▼                     ▼
      ┌─────────────────┐ ┌──────────────┐  ┌───────────────────┐ ┌──────────────────┐
      │  mcp_server/     │ │ dashboard_   │  │ full_report_site/  │ │ Claude Desktop    │
      │  (local, stdio,  │ │ site/        │  │ (Cloudflare Pages  │ │ chat — renders    │
      │  Claude Desktop  │ │ (Cloudflare  │  │ Function,          │ │ dashboard-        │
      │  tool calls)     │ │ Pages,       │  │ service_role key,  │ │ template.html /   │
      └────────┬─────────┘ │ public,      │  │ Cloudflare Access  │ │ portfolio-review- │
               │           │ read-only)   │  │ gated)             │ │ template.html     │
               │           └──────────────┘  └────────────────────┘ └───────────────────┘
               │
   scheduled: Claude Desktop task,
   "run crash check" daily at 2pm ET
```

### Layers

| Layer | What it does | Where |
|---|---|---|
| **Rules** | Static thresholds, bands, wave-deployment percentages, crash-type diagnosis criteria | `reference_docs/rules/crash-check-rules.md` (full text reproduced below) |
| **Ingestion** | Pulls FRED/EIA macro series + Massive.com watchlist ticker prices daily | `ingestion/` (GitHub Action, `.github/workflows/ingest.yml`, 10am ET weekdays) |
| **Rule engine** | Computes the 6-indicator RED/AMBER/GREEN panel, confirmation windows, wave authorization, threshold-crossing push notifications — pure functions, no LLM | `rule_engine/` |
| **MCP server** | Local stdio server exposing tools to Claude Desktop (indicator panel, portfolio drift, watchlist status, deployment plan, 4 write/persistence tools, data-freshness check) | `mcp_server/` |
| **Reporting** | Chat-rendered HTML reports (2 templates), a public historical dashboard, and a private "Full Report" page merging crash-check + portfolio-review content | `reference_docs/rules/*.html`, `dashboard_site/`, `full_report_site/` |

## The 6-indicator panel (the deterministic gate)

VIX, HY credit spreads, S&P drawdown from ATH, 10yr Treasury yield, the Sahm Rule, and
Fed pivot signal. Wave deployment (a staged, 3-tranche dry-powder deployment plan)
authorizes only when 3+ are simultaneously RED, **and** each RED reading has held
across 2+ distinct daily ingestion dates (not just repeated same-day checks) — see
Signal Tiering below. Full thresholds and wave math are in the rules doc reproduced
in full below.

## Security model — split storage (why this matters for any rule changes)

- **Supabase** holds macro/market data only — VIX, CPI, wave status, indicator
  colors, crash probability, watchlist ticker prices/targets, and now (as of
  2026-07-16) crash-type diagnosis narrative and Portfolio Opportunity Review
  content (drift %, ticker thesis, risk-radar scores). **No dollar figures, no
  account balances, ever** — enforced in code (`findLeakedDollarFigures()`), not
  just by prompt instruction: every write path that persists free text
  cross-references the real portfolio file's dollar figures and throws if any
  appear, rather than trusting the model to have followed a "don't include $" rule
  correctly every time.
- **`local_state/`** (gitignored, never committed, never leaves the machine) holds
  the real portfolio file — account balances, dry powder, allocation targets, and
  the BrokerageLink watchlist's position-sizing (`max_position_usd`, which *never*
  reaches Supabase even though everything else about the watchlist now does).
- **The MCP server runs locally via stdio**, not as a hosted service — it's the
  one component that touches `local_state/`.
- Wave-deployment amounts in the rules doc are percentages of "dry powder," never
  dollar figures — the MCP server combines the percentage with the real, local-only
  balance at read time, and that computation's output is chat-only, never
  persisted.
- The private "Full Report" page (`full_report_site/`) is gated by Cloudflare
  Access (email one-time-PIN login) *and* reads Supabase server-side with a
  `service_role` key that's never shipped to the browser — closing the
  access-control gap by design rather than relying on Access alone (a plain
  client-embedded anon key with broad SELECT would bypass Access entirely if it
  existed).

## The four MCP write/persistence tools

1. `write_snapshot` — persists the qualitative crash-check synthesis (probability,
   scenario distribution, narrative notes) to `crash_checks`.
2. `write_full_report` — persists watchlist status (recomputed server-side from
   live prices, not trusted from the caller), crash-type diagnosis, and
   qualitative-only portfolio context to `full_report_snapshots`.
3. `write_watchlist` — full-replacement update of the BrokerageLink watchlist
   (targets, thesis, position sizing locally; symbols only synced to Supabase).
4. `write_portfolio_review` — persists a Portfolio Opportunity Review's verdict,
   summary, macro cross-reference, per-ticker thesis re-underwrite, and risk-radar
   scores to `portfolio_review_snapshots`; portfolio drift is recomputed
   server-side, not trusted from the caller.

All four run the dollar-figure guardrail against every free-text field before
writing.

## Anti-anchoring design (crash-check workflow ordering)

The daily "run crash check" workflow deliberately avoids showing the model any
prior probability/narrative until *after* it commits to this run's estimate — steps
are ordered so the indicator panel, contextual macro data, and portfolio snapshot
are read first, the model commits to a probability + scenario distribution using
only that data, and *only then* does it fetch the prior report's stored probability
(to build a delta-log/framing comparison, never to revise the number already
committed to). This exists because an earlier version let the model see its own
prior narrative before forming a new judgment, which produced anchoring instead of
independent daily assessment.

## Signal confirmation (avoiding single-noisy-day false triggers)

A RED reading on any of the 6 core indicators only counts toward wave authorization
once it has held across **2 or more distinct daily ingestion dates** — not just
repeated intraday checks against the same day's already-ingested value. This closes
an asymmetry where the original design required VIX sustained below 25 for 3 weeks
to declare recovery, but required zero persistence at all to authorize a real-money
deployment. The rule engine tracks this via a per-indicator streak counter
(`confirmation_state` jsonb column, `confirmed_red_count` derived from it) —
`wave_authorized` gates on the *confirmed* count, not the raw same-day count.

## Data-freshness guardrail

Before trusting the indicator panel as "today's data," the system compares the
latest `crash_checks` row's date (in America/New_York) against the expected
ingestion date (accounting for weekends — ingestion is weekdays only), and stops
with an explicit warning rather than silently analyzing stale data if ingestion
hasn't run yet. This exists because GitHub Actions' cron scheduler has been
observed firing up to ~60 minutes late in this project's real run history, so naive
fixed-offset scheduling (e.g. "run analysis 30 min after ingestion") isn't reliable
on its own.

## Threshold-crossing push notifications

A free ntfy.sh push notification fires the moment `confirmed_red_count` crosses
*up* into 2+ (not on every day it remains there) — runs inside the same daily
ingestion job, comparing today's row against the prior row to detect the
transition rather than just checking the current level.

---

# Full current rules doc (source of truth — reproduce verbatim below)

The following is the complete, current contents of `reference_docs/rules/crash-check-rules.md`
— this is what actually drives the deterministic rule engine (`rule_engine/src/rules.ts`,
`rule_engine/src/classify.ts`). Any proposed rule changes should be expressed as edits
to this document.

<!-- BEGIN crash-check-rules.md -->

# Crash Check — Rules Layer (Sanitized) — v5

Derived from the local master prompt doc (`MACRO CRASH CHECK — MASTER PROMPT v3.md`,
kept out of git — see `.gitignore`). This file contains only the static, reusable
rules: thresholds, bands, classification criteria, and allocation *percentages*.

**No personal account balances or dollar figures appear in this file.** Wave
deployment and allocation amounts below are expressed as a percentage of the
tactical account's "dry powder" pool. The rule engine (Stage 3) combines these
percentages with the live `dry_powder_usd` figure from `local_state/portfolio.yaml`
(gitignored, local-only) to compute actual dollar amounts — that computation and
its output happen client-side and are never written back to Supabase.

This file is the source of truth for Stage 3 (rule engine). If you edit the
original master prompt doc, mirror any rule/threshold changes here.

---

## Layer Boundary (read this first)

This system's own design philosophy states: **"No LLM does numeric
classification. Every threshold, band, and RED/AMBER/GREEN color is computed
by deterministic code... never inferred by an LLM."** Everything below is
written to that standard, and this section makes the standard explicit so
future edits don't drift from it.

**Rule engine (deterministic, layer 3) owns:** every threshold and band in
this file, the 3-of-6 wave gate, the confirmation/persistence logic, the
crash-type triggers, and the crash-probability score. All of it gets written
to the "current state" table. None of it is inferred, estimated, or
"reasonably judged" by an LLM at report time.

**LLM narrative layer (reporting) owns:** reading news and Fed communication
to inform the Warsh classification (an explicitly flagged manual judgment
call — see below), writing the qualitative crash-type narrative once the
rule engine has already picked the type, and rendering the dashboard from
values the rule engine already computed. It **renders, it does not
recompute** — if the rule engine says confirmed RED, the report says
confirmed RED; it doesn't get softened, hedged, or independently
re-estimated in prose.

**The test for every rule in this file:** could a developer implement it as
an `if`/`else` without asking what you meant? If yes, it belongs in a
section below, stated as a hard number. If no — as with Warsh MODERATE/
DOVISH criteria — it stays an explicitly flagged manual/LLM judgment call,
never a silently softened threshold.

---

## Signal Tiering & Confirmation Windows

Every indicator used anywhere in this file is one of two tiers.

**Tier 1 — structural, gates capital.** Slow-moving, low false-positive rate,
the only indicators allowed to authorize wave deployment or flip a crash-type
classification: VIX, HY credit spreads, S&P drawdown from ATH, 10yr Treasury
yield, Sahm Rule, Fed pivot signal, 2s10s yield curve, unemployment rate, CPI.
Each is read at check time (checks run ~6–7x/day) — persistence is enforced
by the streak-counter confirmation rule below, not by waiting for a specific
daily close.

**Tier 2 — flow/sentiment, narrative only, never gates.** Fast-moving, noisy,
useful for color and for adjusting the *confidence* tag on a probability
estimate, but never sufficient alone to fire a wave or change a crash type:
retail sales, credit card delinquency, weekly initial jobless claims (the raw
weekly print — the 4-week moving average is what's allowed to matter), overnight
reverse repo, single-day volume/breadth chatter, any retail-sentiment or social
read.

**Confirmation rule.** Because ingestion is daily but the dashboard checks
~6–7x/day, most checks re-evaluate the *same* day's already-ingested value —
so a raw check-count is not independent confirmation, it's the same data
point counted repeatedly. The rule engine instead tracks **distinct
ingestion dates**: any Tier 1 threshold that would authorize a wave or flip
a crash type must hold across **2 or more separate daily ingestion runs**
(i.e., the breach must still be true the next time fresh data lands, not
just the next time the dashboard re-renders). Until a second distinct day
confirms it, the dashboard shows the indicator as "RED — pending
confirmation (1 of 2 days)," not as authorizing.

**Escalation without gating.** Sustained Tier 2 deterioration — 3 or more Tier
2 indicators moving in the adverse direction across 4+ consecutive weekly
readings — never flips a hard gate, but must raise the confidence qualifier on
the crash-probability estimate (Low → Medium → High persistence).

---

## Crash Mode Protocol

If the S&P 500 has fallen **≥10% from its most recent all-time high**
(confirmed per the Signal Tiering rule above) since the last check, lead with
a RED ALERT banner: drawdown % from ATH + exact S&P level, which wave
threshold is triggered (1/2/3/none), how many of the 6 indicators are RED,
each RED indicator's confirmation status, and deployment action. Skip
macro narrative preamble in this mode.

## 6-Indicator Panel (RED/AMBER/GREEN bands)

All Tier 1, computed deterministically by the rule engine at each ingestion;
persistence enforced via the confirmation rule above.

| # | Indicator | GREEN | AMBER | RED |
|---|---|---|---|---|
| 1 | VIX | <20 | 20–35 | >35 |
| 2 | HY credit spreads (ICE BofA) | <350bps | 350–500bps | >500bps |
| 3 | S&P drawdown from ATH | <10% | 10–20% | >20% |
| 4 | 10yr Treasury yield | <4.3% | 4.3–5.0% | >5.0% |
| 5 | Sahm Rule reading | <0.3 | 0.3–0.5 | >0.5 |
| 6 | Fed pivot signal | None | Pause language | Cut signal |

**Wave deployment is authorized when 3 or more of the 6 indicators are
simultaneously RED, each independently confirmed** per the Signal Tiering
rule. A RED reading that hasn't cleared confirmation counts toward the
"pending" tally shown in the dashboard, not the authorizing tally.

Additional bond-market bands (Tier 1, elevated priority, informational):
- 10yr Treasury: amber above 4.5%, RED above 5.0%
- 30yr Treasury: above 5.0% = bond vigilante signal
- Rate hike probability (CME FedWatch): flag if >30% for any meeting in the cycle
- Shiller CAPE: flag above 35x as extreme

## Wave Deployment Thresholds (tactical account only)

Deploy in 3 waves only — **never all at once, never two waves in the same
week.** Amounts are % of the account's dry-powder pool. All S&P/VIX
conditions below require confirmation per the Signal Tiering rule.

**WAVE 1 fires when:** S&P ≤ 6,200 AND VIX > 28, both confirmed *(≈ -16 to
-20% drawdown from ATH baseline)*
→ Move **~17.4% of dry powder**, split:
- 50% → Healthcare-sector defensive equity fund
- 25% → Real-estate/real-asset fund
- 25% → International equity (add to existing position)

**WAVE 2 fires when:** S&P ≤ 5,600 AND VIX > 35, both confirmed *(≈ -24 to
-30% drawdown)*
→ Move **~21.7% of dry powder**, split:
- 40% → Target-date/glide-path fund (add)
- 32% → International equity (add again)
- 16% → Energy sector ETF (via brokerage window)
- 12% → Inflation-protected securities (TIPS, via brokerage window)

**WAVE 3 fires when:** S&P ≤ 4,800 AND VIX > 45, both confirmed *(≈ -35 to
-40% drawdown)*
→ Move **~17.4% of dry powder**, split:
- 40% → US large-cap value/income fund (restore to prior weight)
- 35% → Target-date/glide-path fund (final add)
- 25% → Gold ETF (via brokerage window)

Total across all 3 waves: ~56.5% of dry powder. Remainder stays in stable value —
deployment is intentionally partial, not full liquidation of the reserve.

**Hard rules — never violate under any circumstances:**
- Never sell existing equity positions on the way down
- Never deploy all 3 waves in the same week
- Never fire a wave off an unconfirmed threshold breach (confirmed on fewer
  than 2 distinct ingestion dates)
- Never go 100% stable-value mid-crash (market timing requires being right twice)
- Never stop 401k paycheck contributions during a crash
- Never touch the passive long-duration account (RRSP-equivalent) during a crash
- Never apply wave deployment logic to accounts with no deployment mechanism (e.g. spouse 401k) — monitor only

## Post-Crash Allocation Protocol

Four stages: (1) diagnose crash type, (2) deploy universal core, (3) deploy
crash-specific layer, (4) execute 6-month transition to long-term target. Never
apply a fixed post-crash allocation; never skip the universal core; never deploy
crash-specific positions before the universal core is established.

### Stage 1 — Diagnose Crash Type

At each check during a drawdown ≥15%, identify the dominant crash type using
these hard numerical triggers, each Tier 1 unless noted. State the crash type
explicitly before making any allocation recommendation.

**TYPE A — STAGFLATION** — confirm with ALL THREE:
- CPI still above 3.5% YoY during the drawdown (not falling)
- 10yr yield above 4.0% and not declining
- Brent crude above $80

**TYPE B — RECESSION** — confirm with ALL THREE:
- Unemployment rising above 5.5%
- Sahm Rule fired (reading above 0.5)
- CPI falling month-over-month for 2+ consecutive months

**TYPE C — CREDIT / LIQUIDITY (2008-style)** — confirm with ALL THREE:
- HY credit spreads above 700bps
- Fed activating emergency lending facilities or QE
- Bank stress: KBW Bank Index (BKX) down ≥20% from its trailing 3-month high,
  OR FDIC Quarterly Banking Profile showing unrealized securities losses rising
  for 2+ consecutive quarters

**TYPE D — AI / TECH BUBBLE** — confirm with ALL THREE:
- Mag 7 down more than 40% from peak
- Two or more of {Microsoft, Alphabet, Amazon, Meta} guiding next-quarter capex
  down ≥10% QoQ, or explicitly cutting full-year capex guidance, in the same
  earnings season
- Macro otherwise stable (unemployment below 5%, CPI below 3%)

**TYPE E — HYBRID / STAGFLATION-RECESSION** — confirm with BOTH:
- CPI above 3.5% AND unemployment rising above 5.0% simultaneously
- Fed unable to cut (inflation too high) and unable to hike (economy too weak)

If signals point to two or more types simultaneously, classify as Hybrid (Type E).

### Stage 2 — Universal Core (always first, regardless of crash type)

~30.4% of dry powder, already embedded in the Wave 1–3 structure above:
- Healthcare defensive equity — 8.7% (from Wave 1)
- International equity add — 8.7% (from Wave 1+2)
- Target-date/glide-path add — 13.0% (from Wave 2+3)

### Stage 3 — Crash-Type Specific Layer (% of dry powder)

**TYPE A — STAGFLATION:**
| Position | % of dry powder |
|---|---|
| TIPS (brokerage window) | 4.35% |
| Energy sector ETF (brokerage window) | 4.35% |
| Energy single-name #1 (brokerage window) | 2.61% |
| LNG single-name (brokerage window) | 2.61% |
| Real-estate/real-asset fund | 4.35% |
| Remainder | Hold — stagflation crashes have multiple legs, don't rush |

**TYPE B — RECESSION:**
| Position | % of dry powder |
|---|---|
| Target-date/glide-path (additional) | 8.7% |
| AI/tech single-name (brokerage window, Wave 3 tranche only) | 2.61% |
| Infrastructure single-name (brokerage window) | 2.61% |
| US large-cap value/income (restore) | 6.96% |
| Stable value | Reduce to ~10% — recession crashes resolve faster, deploy aggressively |

**TYPE C — CREDIT / LIQUIDITY:**
| Position | % of dry powder |
|---|---|
| Gold ETF (brokerage window) | 6.96% |
| TIPS (brokerage window) | 2.61% |
| Healthcare (additional) | 4.35% |
| Stable value | Hold large portion — credit crashes are long, deploy slowly over 6–12 months |

**TYPE D — AI / TECH BUBBLE:**
| Position | % of dry powder |
|---|---|
| AI/tech single-name (brokerage window) | 4.35% |
| Energy single-name (brokerage window) | 2.61% |
| US large-cap value/income (restore) | 6.96% |
| Infrastructure single-name (brokerage window) | 2.61% |
| International equity (additional) | 4.35% |

**TYPE E — HYBRID (current base case as of doc date):**
| Priority | Position | % of dry powder |
|---|---|---|
| 1st | TIPS (brokerage window) | 4.35% |
| 2nd | Gold ETF (brokerage window) | 4.35% |
| 3rd | Healthcare (additional) | 4.35% |
| 4th | Real-estate/real-asset fund | 2.61% |
| 5th | Wait for confirmed Fed pivot, then rotate into glide-path + AI/tech growth | — |

Hybrid crashes last longer — stretch wave deployment over 6–9 months.

### Stage 4 — Recovery Signal and 6-Month Transition

**Recovery confirmed when ALL THREE are true simultaneously:**
1. S&P has recovered 15%+ from its confirmed trough price (per Signal Tiering streak confirmation)
2. Fed has either cut rates OR explicitly signalled cuts within 2 meetings
3. VIX has sustained below 25 for 3+ consecutive weeks

| Month | Action |
|---|---|
| 1 | Universal core complete + crash-type layer deployed. Assess recovery signal. |
| 2–3 | Recovery confirmed. Begin reducing stable value toward long-term target floor. Rotate into glide-path + international. |
| 4 | Continue stable-value reduction. Complete brokerage-window position building to target weights. |
| 5 | Add/complete defensive-equity and real-asset positions to long-term target weights. |
| 6 | Arrive at long-term target allocation. |

## Warsh Fed Classification — HAWKISH / MODERATE / DOVISH

> **Gap flagged, not invented:** the source doc documents the criteria that
> triggered a HAWKISH classification on one specific cycle but does **not**
> state symmetric, fully general criteria for MODERATE or DOVISH outcomes.
> This classification stays a **manual/LLM judgment call** — not a
> deterministic Stage 3 rule engine output — until the missing criteria are
> supplied.

**Criteria observed for HAWKISH (from the one documented instance):**
- Dot plot median rises, implying an additional hike this cycle
- Fed chair withholds their own dot projection — treated as an explicit hawkish signal
- Any prior easing-bias language is fully removed

**HAWKISH classification activates these hard rules (no discretion):**
- Delay all tactical-account rotation
- Suspend any stable-value → inflation-hedge reallocation rule
- Hold fully defensive until the next classification gate or the stated CPI threshold is met

## Personal Decision Trigger Types (structure, not live dates)

The rule engine evaluates each trigger's status (`fired` / `approaching` /
`pending`) against current dates and data, and writes the result into
`crash_checks.trigger_status`. Trigger definitions themselves (dates, exact
thresholds) belong in the live master-prompt doc / a config the user updates —
treat the 4-trigger structure as: Fed-event trigger, inflation-print trigger,
earnings-guidance trigger, and a rate-reset trigger tied to a stable-value fund.

## Recovery / Complacency Watch Bands (informational, always shown — Tier 2 unless noted)

- VIX below 18 in an elevated-macro-risk regime = flag complacency (Tier 1 series, informational use)
- Market breadth below 55% of stocks above 200dma = flag
- ISM Manufacturing Prices above 65 = flag (stagflation transmission)
- Brent/WTI above $100 = flag as stagflation accelerant
- Initial jobless claims: 4-week moving average up ≥10% from its trailing
  3-month low, sustained for 3+ consecutive weekly prints = flag
- Credit card delinquency (FRED `DRCCLACBS`): up ≥25bps quarter-over-quarter for
  2 consecutive quarters = flag
- Retail sales (FRED `RSAFS`): MoM decline for 2+ consecutive months, or
  3-month annualized growth below 0% = flag consumer pullback
- 10yr breakeven inflation (FRED `T10YIE`): above 2.5%, sustained 4+ weeks =
  flag unanchored expectations

## Contextual Indicators (informational only — Tier 2, never gate wave authorization)

These broaden situational awareness beyond the original 6-indicator panel, using
series already free on FRED. **They are explicitly not part of the 3-of-6 RED
wave-authorization gate** — that formula stays exactly VIX / HY spread / S&P
drawdown / 10yr yield / Sahm Rule / Fed pivot signal, fixed by deliberate design
choice. Use these only to enrich narrative synthesis and to set the confidence
qualifier per Signal Tiering.

| Indicator | Source | Signal framing | Suggested magnitude band |
|---|---|---|---|
| St. Louis Fed Financial Stress Index | FRED `STLFSI4` | Positive = above-average financial stress; negative = below-average | 0–0.5 mild, 0.5–1.5 elevated, >1.5 severe |
| Chicago Fed National Financial Conditions Index | FRED `NFCI` | Positive = tighter than average conditions; negative = looser | >0.3 sustained 4+ weeks = flag tightening |
| 10yr breakeven inflation | FRED `T10YIE` | Context vs Fed's ~2% PCE target | See Complacency Watch Bands above |
| Senior Loan Officer Survey (C&I tightening, large/medium firms) | FRED `DRTSCILM` | Positive = net tightening lending standards (credit contracting) | >20% net tightening = flag |
| Overnight reverse repo | FRED `RRPONTSYD` | Liquidity parked at the Fed; declining can reflect either liquidity draining into risk assets or T-bill supply dynamics | Genuinely bidirectional — read only alongside NFCI/STLFSI4 direction |
| 2s10s yield curve spread | Derived: FRED `DGS10` − `DGS2` | Below 0 = inverted, historically precedes recessions by several quarters | Tier 1 (already in bond-market bands above) |
| Initial jobless claims | FRED `ICSA` | Sustained rising trend = labor market weakening | See Complacency Watch Bands above (4-week MA rule) |
| Credit card delinquency rate | FRED `DRCCLACBS` | Rising = consumer financial stress increasing | See Complacency Watch Bands above |
| WTI crude oil | FRED `DCOILWTICO` | Above $100/barrel = stagflation accelerant | See Recovery/Complacency band above |
| Retail sales (advance, all stores) | FRED `RSAFS` | Closest free proxy for consumer/card spending strength | See Complacency Watch Bands above |

---

## Crash-Probability Scoring Methodology (DEFERRED — draft, not implemented)

> The actual probability shown in reports is 100% LLM-judgment today, by
> deliberate original design (not an oversight) — `rule_engine/src/classify.ts`
> never computes or writes `crash_probability_pct`; the MCP server's
> `write_snapshot` takes it as a caller-supplied number. What *was* a real bug
> — the LLM anchoring to its own prior probability/notes instead of judging
> independently each run — is fixed separately at the instruction + tool
> level (committing to an estimate before ever seeing the prior value). This
> formula below is kept as a draft for if/when a deterministic version is
> wanted; every weight is a starting-point default, not validated or
> back-tested.

**Base score — Tier 1 panel position (0–70 points):** for each of the 6 core
indicators, score its position within its own band, not just its color:
GREEN = 0–3pts (scaled by proximity to the AMBER line), AMBER = 4–8pts (scaled
by proximity to the RED line), RED = 9–12pts (scaled by distance past the RED
line, capped). Sum across all 6, then normalize to a 0–70 point subtotal.

**Confirmation multiplier:** any indicator still "pending confirmation" (not
yet true across 2 distinct ingestion dates) contributes at only 50% of its
computed points until confirmed.

**Context adjustment — Tier 2 overlay (±15 points):** apply only the
escalation rule already defined in Signal Tiering — sustained (4+ week)
adverse moves across 3+ Tier 2 indicators add up to +15 points; do not score
Tier 2 indicators individually or let any single one move the number.

**Crash-type proximity (0–15 points):** if a drawdown ≥15% is active, add
points for how many of a candidate crash type's 3 confirming criteria (Stage
1) are already met (5 points per criterion met, any single type).

**Total = Base + Context adjustment + Crash-type proximity, clamped to
0–100.** Recompute at every check; the confidence tag (Low/Medium/High
persistence) is Low if fewer than 2 of the 6 core indicators are past their
confirmation bar, Medium if 2–3 are, High if 4+ are.

---

## Formatting Requirements

**Rule Engine Output Contract.** Every number, color, streak, confirmation
status, and probability figure rendered anywhere in the dashboard must be
read directly from what the rule engine already wrote. The LLM/reporting
layer never restates a value in its own words with different precision,
rounds it differently, hedges it verbally, or fills in a number the rule
engine didn't provide.

**Two run types, explicitly labeled.** Most runs (~6-7x/day) are lightweight
automated indicator refreshes, not full narrative reports:
- **Automated indicator refresh** (the default, most runs): render the RED
  banner (if any), the 6-indicator grid with streak/confirmation status, the
  crash-probability meter, trigger status, and contextual indicators. No
  narrative synthesis, no crash-type diagnosis, no radar chart.
- **Full chat-triggered report** (on demand, or when a confirmed threshold
  newly fires): adds narrative synthesis, Stage 1 crash-type diagnosis (if
  drawdown ≥15%), and brokerage-window watchlist.

**Scan order, top to bottom (fixed):**
1. RED ALERT banner, if any indicator/wave condition is confirmed or pending confirmation
2. Crash-probability meter: point %, confidence tag, 3-day Δ, 7-day Δ, visual
   meter. Color code: green 0–20%, amber 20–35%, red 35%+
3. 6-indicator grid — current value, RED/AMBER/GREEN pill, 3-day Δ, 7-day Δ,
   confirmation status, RED count displayed prominently
4. Crash-type diagnosis (only rendered when drawdown ≥15%)
5. Wave status + brokerage-window watchlist: ticker | current price | Wave 1
   target | % distance | 3-day Δ | 7-day Δ | status pill (WAIT >20% above
   target / WATCH 5–20% above / BUY ZONE at or below)
6. Contextual (Tier 2) indicators — clearly labeled "informational, does not
   gate," each with an "as of" timestamp
7. Narrative prose last, outside all widgets

**Delta standard:** always report both a **3-day Δ** (short-horizon,
noise-sensitive) and a **7-day Δ** (velocity, the number that matters for
trend confirmation), explicitly labeled.

**Confidence and recency:**
- Every probability/point estimate carries a confidence interval or an
  explicit Low/Medium/High persistence tag — never a bare point figure.
- Every externally-sourced figure carries an "as of" date reflecting the
  source's actual publication lag.

<!-- END crash-check-rules.md -->

---

## Known open items relevant to rule-tweaking

- **Wave 2/3 threshold backtest finding**: backtested against real 2016–2026
  history — Wave 3 (drawdown≥35% & VIX>45) never fired in 2020 despite VIX peaking
  at 82 (drawdown missed the 35% bar by ~1pt). Wave 2 (drawdown≥24% & VIX>35) never
  fired in 2022 despite a real 24%+ drawdown, because VIX never sustained above 35
  in that "grinding" bear market. Worth reconsidering whether the joint
  drawdown-AND-VIX construction is calibrated right.
- **Crash-probability scoring formula** (in the rules doc above) is a documented
  draft, not implemented — the actual probability is 100% LLM-judgment today, by
  original design, with the formula kept only as a starting point for a future
  deterministic version. Not back-tested against historical data.
- **Delta-standard (3-day/7-day Δ)** required by the formatting rules can't
  actually be computed yet — no tool exposes historical N-days-ago lookback values
  despite the underlying history existing in `data_points`.
- **BrokerageLink watchlist ticker selection** has no documented rationale beyond
  a one-line theme tag per ticker — the Portfolio Opportunity Review process is
  meant to close this gap but has so far only re-examined price targets, not
  whether the underlying ticker choices themselves still hold up.

## What NOT to change without a strong reason

- The Layer Boundary principle itself (deterministic rule engine owns all
  thresholds/classification; LLM only narrates) — this is the foundational design
  choice the whole system is built around.
- The split-storage security model (dollar figures never reach Supabase) — this is
  enforced in code, not just policy, and several architectural decisions (separate
  tables, guardrail functions, local-only MCP server) exist specifically to
  preserve it.
- The 6-indicator wave-authorization gate's specific series (VIX / HY spread /
  drawdown / 10yr / Sahm / Fed pivot) — contextual indicators exist to enrich
  narrative but are explicitly excluded from ever gating wave authorization, by
  deliberate design choice, not oversight.
