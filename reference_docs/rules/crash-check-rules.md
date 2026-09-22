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

> **Changelog vs. v3, consolidated:** (1) added the Layer Boundary section
> below — every rule in this file must be codeable as a deterministic
> comparison; anything that can't be is flagged as an open item, not
> softened into an LLM judgment call. (2) Added Signal Tiering & a
> Confirmation rule (Tier 1 vs. Tier 2 indicators; a threshold breach must
> hold across 2+ distinct daily ingestion dates, not just repeated same-day
> checks, before it authorizes a wave or flips a crash type) — this closes
> an asymmetry where Stage 4 recovery required VIX sustained below 25 for 3
> weeks but wave entry required zero persistence at all. (3) Replaced every
> vague qualifier (bank stress "rising," capex "cuts," claims "sustained
> rising trend," delinquency "rising," breakeven "meaningfully above") with
> numeric proxies, each marked `[new default — calibrate]` so you can tell
> what's inherited vs. what needs your sign-off before it's load-bearing.
> **All 9 were reviewed and approved as-is on 2026-07-11** — the tags below
> are left unmarked now that they're settled, not because they're
> unimportant. Revisit if real-world backtesting later suggests a
> proxy/threshold isn't holding up.
> (4) Added a draft Crash-Probability Scoring Methodology, since no version
> of this file ever specified how the displayed % is computed — checked
> against the actual code (2026-07-11): it's 100% LLM-judgment today
> (`classify.ts` never touches it), which turned out to be a deliberate
> decision from early in the project, not an oversight. The scoring formula
> stays **deferred** (draft only); what was a real bug — the LLM anchoring
> to its own prior probability/notes instead of judging independently each
> run — was fixed separately at the instruction + tool level (commit
> `5d791f1`), without changing who computes the number. (5) Standardized
> 3-day/7-day delta reporting,
> confidence tagging, and a fixed dashboard scan order, and distinguished
> "automated indicator refresh" runs from "full chat-triggered report" runs
> (observed as an already-real distinction in exported output that the
> rules never formalized).

---

## Layer Boundary (read this first)

This system's own design philosophy states: **"No LLM does numeric
classification. Every threshold, band, and RED/AMBER/GREEN color is computed
by deterministic code... never inferred by an LLM."** Everything below is
written to that standard, and this section makes the standard explicit so
future edits don't drift from it.

**Rule engine (deterministic, layer 3) owns:** every threshold and band in
this file, the 3-of-6 wave gate, and the confirmation/persistence logic. All
of it gets written to the "current state" table. None of it is inferred,
estimated, or "reasonably judged" by an LLM at report time.

**LLM narrative/qualitative layer (reporting) owns:** the crash-type
diagnosis and the 4-way scenario distribution — despite the Stage 1 criteria
below being written with hard numeric triggers, `crash_type` is never
computed by the rule engine; it's only ever set by a caller-supplied input to
`write_snapshot`. The scenario distribution is 100% LLM judgment too.
**`crash_probability_pct` (and its low/high range) is the one exception,
changed 2026-09-22**: it's no longer a caller-supplied judgment at all —
`write_snapshot` (in `mcp_server`, not the rule engine) now derives it
deterministically from the scenario distribution the caller supplies (point =
`scenario_crash_pct` + 0.5×`scenario_bear_pct`; low = `scenario_crash_pct`;
high = `scenario_bear_pct`+`scenario_crash_pct`) — see the "Crash-Probability
Scoring Methodology" section below for why. This is a narrow exception to the
Rule Engine Output Contract below, not a violation of it: the derivation
lives in `mcp_server`, not `rule_engine/`, specifically because its input
(the scenario split) is itself LLM judgment, not a real market data series —
a genuinely deterministic layer computed from a non-deterministic input, not
the same thing as the 6-indicator panel's bands. This is a **deliberate,
pre-existing design decision** for `crash_type`/scenario distribution
remaining LLM-judged, not an oversight this doc failed to catch — but it
means this section previously overstated what's actually deterministic for
the crash-probability headline specifically, and this paragraph exists to
correct that rather than let the contradiction stand.
The LLM layer also reads news and Fed communication to inform the Warsh
classification (an explicitly flagged manual judgment call — see below), and
renders the dashboard from values the rule engine already computed for
everything it *does* own. It **renders, it does not recompute** — if the
rule engine says confirmed RED, the report says confirmed RED; it doesn't
get softened, hedged, or independently re-estimated in prose.

**The test for every rule in this file:** could a developer implement it as
an `if`/`else` without asking what you meant? If yes, it belongs in a
section below, stated as a hard number. If no — as with Warsh MODERATE/
DOVISH criteria, crash-type diagnosis, and crash probability — it stays an
explicitly flagged manual/LLM judgment call, never a silently softened
threshold. Vague language in this file isn't just an "AI might interpret
loosely" risk — it's a spec that literally cannot be coded as written, which
is a harder failure mode for a system whose entire premise is that
*mechanical* classification (bands, confirmation, wave gates) is
deterministic — the qualitative layer (probability, crash-type, narrative)
was never meant to be, and should not be presented as if it were.

---

## What this system actually is

**This is a stress-monitoring and discretionary deployment dashboard, not a
calibrated crash-probability model.** The 6-indicator panel, band colors,
confirmation windows, and wave-trigger thresholds are genuinely deterministic
— reproducible, inspectable, and owned entirely by code. The crash
probability, crash-type diagnosis, scenario distribution, and Fed/Warsh
classification are not: they are a single person's (via an LLM) qualitative
judgment, informed by the deterministic panel and web research, with no
defined forecast horizon, no historical labels, no out-of-sample validation,
and no reliability testing behind the displayed percentage. A crash
probability of 15% is not evidence that a crash-defining event will occur
roughly 15% of the time — treat it as a considered opinion, not a statistic.
This system should never be presented or relied upon as if the three-wave
deployment thresholds were empirically optimal, or as if the probability
score were calibrated — because neither is true today.

---

## Signal Tiering & Confirmation Windows

Every indicator used anywhere in this file is one of two tiers. This section
is the single source of truth for how "signal" is separated from "noise" —
every other section below refers back to it instead of re-deriving the logic.

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

**Confirmation rule.** The live system already computes and displays a
per-indicator streak counter (e.g., "GREEN for 13 checks, since Jul 9") — this
rule governs *that* field rather than inventing a parallel mechanism, and
should be computed in the deterministic rule engine (layer 3), written to the
"current state" table alongside RED/AMBER/GREEN — not left to the LLM
reporting layer to track. Because ingestion is daily but the dashboard checks
~6–7x/day (observed: 13 checks over 2 calendar days), most checks re-evaluate
the *same* day's already-ingested value — so a raw check-count is not
independent confirmation, it's the same data point counted repeatedly. The
rule engine should instead track **distinct ingestion dates**: any Tier 1
threshold that would authorize a wave or flip a crash type must hold across
**2 or more separate daily ingestion runs** (i.e., the breach must still be
true the next time fresh data lands, not just the next time the dashboard
re-renders). Until a second distinct day confirms it, the dashboard shows the
indicator as "RED — pending confirmation (1 of 2 days)," not as authorizing.
This closes the asymmetry in v3, where Stage 4 recovery required VIX
sustained below 25 for 3 consecutive *weeks* but wave entry required zero
persistence at all — without this fix, a single volatile trading day could
still authorize a real-money deployment the moment that day's data lands,
and a high same-day check frequency would create the illusion of a "streak"
that isn't really independent confirmation.

> **2026-08-15 historical check (finding, not a rule change):** an external
> quant review argued this 2-day rule creates false negatives in fast,
> event-driven crashes (citing Feb–Mar 2020 as the canonical example). Queried
> real `data_points` history for that window rather than assuming either way:
> VIX crossed into confirmed RED (>35, 2 distinct dates) by **2020-02-28** —
> three-plus weeks before the actual market bottom. The S&P drawdown *band*
> (>20%, one of the six RED-count indicators) reached confirmed RED by
> **2020-03-17**, six days before the bottom (2020-03-23), while VIX had
> already been RED for weeks. On the two indicators checkable against real
> data, confirmation cleared with real runway to spare — it wasn't obviously
> the dominant source of lag in this one episode. This is **not conclusive**:
> `BAMLH0A0HYM2` (HY spread) has no rows before ~2023 in this database, so the
> full 3-of-6 `wave_authorized` timeline for 2020 can't be reconstructed, and
> Fed pivot's manually-judged, confirmation-exempt status is a wildcard this
> check can't account for either. No rule was changed on the strength of one
> partially-verifiable episode — a magnitude-based fast-confirmation path
> would be a new, unvalidated policy choice, not a fix, and stays out of scope
> until real backtesting (the deferred hazard-model work) can support it.

**Escalation without gating.** Sustained Tier 2 deterioration — 3 or more Tier
2 indicators moving in the adverse direction across 4+ consecutive weekly
readings — never flips a hard gate, but must raise the confidence qualifier on
the crash-probability estimate (Low → Medium → High persistence; see
Formatting Requirements). This is how systemic drift gets surfaced without
letting daily retail-sentiment noise touch the deployment logic.

---

## Crash Mode Protocol

If the S&P 500 has fallen **≥10% from its most recent all-time high**
(confirmed per the Signal Tiering rule above — true across 2+ distinct
ingestion dates, not just repeated same-day checks) since the last check,
lead with a RED ALERT banner: drawdown % from ATH + exact S&P level, which
wave threshold is triggered (1/2/3/none), how many of the 6 indicators are
RED, each RED indicator's confirmation status (confirmed vs. pending — with
days-confirmed count shown), and deployment action. Skip macro narrative
preamble in this mode.

## 6-Indicator Panel (RED/AMBER/GREEN bands)

All Tier 1, computed deterministically by the rule engine at each ingestion;
persistence enforced via the confirmation rule above (2+ distinct ingestion
dates), not a single day's snapshot.

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
rule (true across 2+ distinct ingestion dates). A RED reading that hasn't
cleared confirmation counts toward the "pending" tally shown in the
dashboard, not the authorizing tally — e.g. "1 of 6 RED confirmed, 1 pending
(confirmed on 1 of 2 required days)."

Additional bond-market bands (Tier 1, elevated priority, informational):
- 10yr Treasury: amber above 4.5%, RED above 5.0%
- 30yr Treasury: above 5.0% = bond vigilante signal
- Rate hike probability (CME FedWatch): flag if >30% for any meeting in the cycle
- Shiller CAPE: flag above 35x as extreme

## Wave Deployment Thresholds (tactical account only)

Deploy in 3 waves only — **never all at once, never two waves in the same
week.** Amounts are % of the account's dry-powder pool (see
`local_state/portfolio.yaml` for the live dollar figure). Note: the
drawdown/VIX conditions below (`activeWave()` in `rules.ts`) are evaluated
same-day, not run through the Signal Tiering 2-distinct-date mechanism the
6 core indicators use — a documentation/code discrepancy noted 2026-09-19,
left as-is since fixing it wasn't in scope of the slow-bear pathway work
below and changing it would affect the fast-panic pathway's already-
validated lead times. The **slow-bear pathway** added below *does* use
real 2-day confirmation.

Triggers are expressed as **drawdown from the running all-time-high**, not
fixed nominal S&P index levels — a fixed level like "S&P ≤ 6,200" decays as
the index's nominal level rises over time (what was a ~16% drawdown when
that number was chosen becomes a smaller, less meaningful move once the ATH
has risen further), while a drawdown percentage stays meaningful regardless
of when it's evaluated.

A wave's drawdown/VIX condition being met is **not, by itself, authorization
to deploy** — `get_deployment_plan` also requires `wave_authorized` (3 or
more of the 6 indicators confirmed RED, per the wave-deployment-authorization
rule above). A wave whose drawdown/VIX threshold has fired but where
`wave_authorized` is still false is shown as observed-but-not-yet-authorized,
not as a deployable plan.

**WAVE 1 fires when:** S&P drawdown from ATH ≥ 16% AND VIX > 28, both confirmed
→ Move **~17.4% of dry powder**, split:
- 50% → Healthcare-sector defensive equity fund
- 25% → Real-estate/real-asset fund
- 25% → International equity (add to existing position)

**WAVE 2 fires when:** S&P drawdown from ATH ≥ 24% AND VIX > 35, both confirmed
→ Move **~21.7% of dry powder**, split:
- 40% → Target-date/glide-path fund (add)
- 32% → International equity (add again)
- 16% → Energy sector ETF (via brokerage window)
- 12% → Inflation-protected securities (TIPS, via brokerage window)

**WAVE 3 fires when:** S&P drawdown from ATH ≥ 35% AND VIX > 45, both confirmed
→ Move **~17.4% of dry powder**, split:
- 40% → US large-cap value/income fund (restore to prior weight)
- 35% → Target-date/glide-path fund (final add)
- 25% → Gold ETF (via brokerage window)

### Slow-bear pathway (Wave 2/3 only, added 2026-09-19)

A second, independent way to reach Wave 2/3, alongside the drawdown+VIX
pathway above — never a replacement for it. Fixes a gap an external
backtest found: replaying the original pathway against all 5 real
≥20%-drawdown S&P episodes since 1993 (dot-com, GFC, Dec 2018, COVID, 2022)
showed Wave 3 never confirmed for dot-com (the single worst crash in the
dataset, -49.1%, because VIX only touched 45 for one day) and Wave 2 never
confirmed for 2022 (because VIX's peak and the deepest drawdown never
coincided in that grinding, low-volatility bear).

**Condition:** `drawdown ≥ wave's threshold (24% for Wave 2, 35% for Wave 3)
AND the S&P has set a fresh ~1-year (252-trading-day) rolling low within
the last 40 trading days`, confirmed across 2+ distinct observation dates
(real Signal Tiering confirmation, via `confirmation_state.slow_bear_w2` /
`slow_bear_w3`) — unlike the pathway above, this one is genuinely
confirmation-gated, not same-day.

The freshness requirement (not just depth alone) is load-bearing: SPY
didn't reclaim its October 2007 high until 2013, so "still below the
all-time high" stayed true for *years* after the GFC actually bottomed and
markets calmed down. A depth-only check with no freshness filter fired
constantly through the calm 2010-2011 recovery period in backtesting —
this distinguishes an actively deteriorating market from one merely still
below a stale multi-year-old peak.

Backtest result (33 years / 8,467 trading days of real SPY+VIX+FRED
history): the slow-bear Wave 3 pathway produces 5 events, all 5 inside
dot-com/GFC, zero false positives. The slow-bear Wave 2 pathway produces
13 events — 10 inside the 5 labeled episodes (including 2022) and 3 that
are real, separately-identifiable stress episodes (the Aug-Oct 2011
debt-ceiling crisis/US credit downgrade, and COVID's own volatile tail one
week past its trough), not genuinely ordinary days — the same "a near-miss
is a real crisis, not a false alarm" standard the original backtest already
established for 1998 LTCM/April 2025.

`wave_active_reason` (`FAST_PANIC` or `SLOW_BEAR`, null when no wave is
active) records which pathway actually produced a given day's `wave_active`
value. Whichever pathway reaches the higher wave wins; on a tie, the
fast-panic pathway's reason is reported.

Total across all 3 waves: ~56.5% of dry powder. Remainder stays in stable value —
deployment is intentionally partial, not full liquidation of the reserve.

Deployment is **cumulative**: if a deep, fast drawdown reaches Wave 3's
threshold without Wave 1/2 ever separately confirming first, `get_deployment_plan`
returns the combined breakdown for every wave up to and including the
current one that hasn't already been executed — not just Wave 3's slice —
so the intended diversification across waves isn't skipped. Which waves have
actually been executed is tracked in `local_state/wave_deployment_state.yaml`,
set only via the `record_wave_deployment` tool after trades are actually
placed — never inferred or set automatically.

**Hard rules — never violate under any circumstances:**
- Never sell existing equity positions on the way down
- Never deploy all 3 waves in the same week
- Never fire a wave off an unconfirmed threshold breach (confirmed on fewer
  than 2 distinct ingestion dates)
- Never go 100% stable-value mid-crash (market timing requires being right twice)
- Never stop 401k paycheck contributions during a crash
- Never touch the passive long-duration account (RRSP-equivalent) during a crash
- Never apply wave deployment logic to accounts with no deployment mechanism (e.g. spouse 401k) — monitor only

> **2026-08-15 review note:** an external quant review flagged "never sell on
> the way down" as a blanket behavioral guardrail that should arguably be
> conditioned on liquidity, concentration, valuation, or tax status rather
> than applied uniformly. Checked against the actual account structure
> (`local_state/portfolio.yaml`): the two accounts that concern would most
> plausibly apply to — the passive long-duration account (RRSP-equivalent)
> and the monitored spouse 401k — are already permanently excluded from wave
> deployment by their own account-level flags (`crash_protocol: none`,
> `deployment_mechanism: none`), independent of this rule. No carve-out
> identified for the tactical 401k itself as of this review; rule stands
> as-is.

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
  for 2+ consecutive quarters (v3 said only "bank stress indicators rising,"
  no proxy or magnitude)

**TYPE D — AI / TECH BUBBLE** — confirm with ALL THREE:
- Mag 7 down more than 40% from peak
- Two or more of {Microsoft, Alphabet, Amazon, Meta} guiding next-quarter capex
  down ≥10% QoQ, or explicitly cutting full-year capex guidance, in the same
  earnings season (v3 said only "cutting AI capex guidance," undefined magnitude)
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

**Recovery confirmed when ALL THREE are true simultaneously** (implemented
2026-08-16 in `rule_engine/src/classify.ts` — previously pure prose here
with no corresponding code):

1. **S&P has recovered 15%+ from its confirmed trough price.** The trough is
   a running minimum of the S&P level, tracked only while a drawdown episode
   is active — defined as drawdown ≥10% from ATH, the same threshold the
   Crash Mode Protocol RED ALERT banner already uses above, not a separately
   invented number. The trough only moves on a new low (frozen once the
   market starts recovering) and resets once drawdown falls back under 10%
   (episode over, whether via recovery or a fresh ATH).
2. **Fed has either cut rates OR explicitly signalled cuts within 2
   meetings.** Reuses the existing Fed pivot signal (`fed_pivot_signal ===
   "CUT"`) directly rather than a new field — the "within 2 meetings"
   recency qualifier is **not independently tracked**, same honesty-first
   treatment as every other manual/LLM-judged field in this document (see
   Warsh classification below).
3. **VIX has sustained below 25 for 3+ consecutive weeks.** Implemented via
   the same confirmation-streak mechanism as the 6-indicator panel
   (`computeConfirmation`), reusing distinct-observation-date persistence
   but with a 15-count bar instead of the panel's standard 2 (~3 weeks of
   trading days) — tracked as its own `vix_recovery` confirmation entry,
   separate from the panel's own VIX confirmation (different threshold: 25,
   not the panel's 20/35 bands).

`recovery_confirmed` is a fact about the *most recent* drawdown episode, not
a value that flickers day to day — once true it stays true until a new
episode begins (a fresh drawdown crossing back over the 10% boundary), at
which point it resets for that new episode.

**Not yet built**: the month-by-month execution tracking below is still
manual — there is no equivalent of `wave_deployment_state.yaml`/
`record_wave_deployment` for recovery yet. `recovery_confirmed` tells you
*whether* to start this table; nothing tracks *which month/step* you're
actually on.

| Month | Action |
|---|---|
| 1 | Universal core complete + crash-type layer deployed. Assess recovery signal. |
| 2–3 | Recovery confirmed. Begin reducing stable value toward long-term target floor. Rotate into glide-path + international. |
| 4 | Continue stable-value reduction. Complete brokerage-window position building to target weights. |
| 5 | Add/complete defensive-equity and real-asset positions to long-term target weights. |
| 6 | Arrive at long-term target allocation (see `local_state/portfolio.yaml` for the account's specific target %). |

## Warsh Fed Classification — HAWKISH / MODERATE / DOVISH

> **Gap flagged, not invented:** the source doc documents the criteria that
> triggered a HAWKISH classification on one specific cycle (dot plot median
> rising + own dot projection withheld + easing bias language removed) but does
> **not** state symmetric, fully general criteria for MODERATE or DOVISH
> outcomes. Per the build spec's instruction not to invent or simplify numbers,
> this classification should stay a **manual/LLM judgment call** — not a
> deterministic Stage 3 rule engine output — until you supply the missing
> criteria. Treat this as an open item before wiring Warsh classification into
> the automated rule engine.

**Criteria observed for HAWKISH (from the one documented instance):**
- Dot plot median rises, implying an additional hike this cycle
- Fed chair withholds their own dot projection — treated as an explicit hawkish signal
- Any prior easing-bias language is fully removed

**HAWKISH classification activates these hard rules (no discretion):**
- Delay all tactical-account rotation
- Suspend any stable-value → inflation-hedge reallocation rule
- Hold fully defensive until the next classification gate or the stated CPI threshold is met

## Personal Decision Trigger Types (structure, not live dates)

Four triggers: Fed-event, inflation-print, earnings-guidance, and a
rate-reset trigger tied to a stable-value fund. Trigger definitions
themselves (dates, exact thresholds) belong in the live master-prompt doc /
a config the user updates.

**Correcting an overstatement here as of 2026-08-17**: this section
previously claimed "the rule engine evaluates each trigger's status... and
writes the result into `crash_checks.trigger_status`" — checked against the
actual code, that's not true for any of the four. `trigger_status` is never
computed by `rule_engine`/`classify.ts`; it's either carried forward
unchanged from the prior row or supplied by the LLM to `write_snapshot`. The
first three genuinely need qualitative judgment (was the Fed's tone
hawkish/dovish, did earnings guidance beat/miss) and stay LLM-judged for
that reason. The **rate-reset trigger is the one exception**: it's a plain
date comparison against locally-recorded portfolio data
(`nyl_anchor_rate_through`), not a judgment call — after prose instructions
asking the LLM to do that comparison itself repeatedly produced wrong
results in practice (confirmed live, multiple reports in a row), it was
made deterministic (`mcp_server/src/lib/portfolio.ts`'s
`computeRateResetTriggerStatus()`, exposed via `get_portfolio_snapshot`'s
`rate_reset_trigger` field) — the LLM reports what's already computed for
this one trigger, it doesn't reason about the dates itself.

**Fed-event and inflation-print got a narrower, different fix as of
2026-08-26, not the same one as rate-reset.** A real chat-generated report
was observed still showing "Fed-event trigger — July FOMC — FIRED" with
nothing that would have advanced it to September's meeting — the specific
event/date each of these two triggers refers to had never been anything
more than hand-typed prose in a gitignored local file, with no mechanism
rolling it forward once the current occurrence passed. Unlike rate-reset,
this is **not** a fired/pending binary — an FOMC meeting has no "waiting
period" the way a declared rate does. Instead, because FOMC meeting dates
and CPI release dates are published on a fixed public schedule (unlike a
discretionary declared rate), *which specific meeting/release is currently
relevant* is now computed deterministically
(`mcp_server/src/lib/economicCalendar.ts`'s `computeFedEventTrigger()`/
`computeInflationPrintTrigger()`, exposed via `get_trigger_status`'s
`fed_event_trigger`/`inflation_print_trigger` fields): `current_target_date`/
`current_target_label` identify the most recent past occurrence (whose
outcome may still need qualitative assessment), and `next_target_date`/
`next_target_label` identify what to watch next — so the target rolls
forward automatically instead of depending on a human to keep editing prose.
The qualitative read itself (hawkish/dovish, beat/miss) stays 100%
LLM-judged, unchanged. If `calendar_needs_update` is true, the hardcoded
calendar has run past its last known date and needs manual maintenance (see
that file's own header comment for the source URLs and update cadence) —
this is flagged explicitly rather than silently returning a stale date; the
Fed's own 2027 FOMC dates are marked tentative for the same reason (only
confirmed at the meeting immediately preceding each one), and 2027 CPI
dates are omitted entirely because BLS has not published them yet, not
because of an oversight. **Earnings-guidance is not given this
treatment** — exact earnings report dates vary by company and aren't
published on a fixed public schedule far in advance, so it stays entirely
an LLM judgment call (see `project-instructions.md`'s trigger re-check
step), the same treatment already working well for ad-hoc catalysts like a
Fed Chair's first Jackson Hole keynote.

**A related but distinct gap surfaced 2026-09-12 via a live-data
retrospective, not a build-time check**: `trigger_status` never retired old
entries — it only grew. By 2026-08-28 it held 6 simultaneous entries: 4
long-resolved ones (July FOMC, June CPI, Q2 earnings, the rate-reset
trigger) sitting alongside the 2 actually-current ones (September FOMC,
August CPI). This is a different problem from the one above — *which
occurrence is current* was already solved for Fed-event/inflation-print
(and rate-reset); nothing stopped a superseded entry from lingering once a
newer one appeared. Fixed the same way: `write_snapshot`
(`mcp_server/src/lib/supabase.ts`) now deduplicates the array server-side
after persisting, keeping only the latest entry (by `date`) per canonical
trigger type (Fed-event/inflation-print/earnings-guidance/rate-reset,
matched by name *prefix* — the array's `name` field is free-form prose,
never enforced to one exact format). This is array hygiene, not a new
judgment call, and passively covers earnings-guidance too (no deterministic
calendar backs it, but once a newer quarter's entry appears, the same logic
retires the older one).

**A third, narrower gap in this same family surfaced 2026-09-15 via an
external review, confirmed against this system's own live data before
fixing**: `status` could lag its own `note` for Fed-event/inflation-print
entries — a live example showed an August CPI entry with a note accurately
describing the release ("Released Sep 11: headline +0.4%...") while
`status` stayed stuck at `"approaching"`. `write_snapshot` now also forces
`status` to `"fired"` for these two trigger types whenever the entry's own
`date` is today or in the past — purely mechanical ("has this date
passed"), never touching future-dated entries, since approaching-vs-pending
for an upcoming date is a genuine judgment call this doesn't override. The
qualitative content of `note` (was the release/meeting hawkish/dovish,
in-line or a beat/miss) stays 100% LLM-judged, unchanged.

## Recovery / Complacency Watch Bands (informational, always shown — Tier 2 unless noted)

- VIX below 18 in an elevated-macro-risk regime = flag complacency (Tier 1 series, informational use)
- Market breadth below 55% of stocks above 200dma = flag
- ISM Manufacturing Prices above 65 = flag (stagflation transmission)
- Brent/WTI above $100 = flag as stagflation accelerant (automated via `get_context_indicators`, FRED `DCOILWTICO`)
- Initial jobless claims: 4-week moving average up ≥10% from its trailing
  3-month low, sustained for 3+ consecutive weekly prints = flag (replaces
  v3's undefined "sustained rising trend")
- Credit card delinquency (FRED `DRCCLACBS`): up ≥25bps quarter-over-quarter for
  2 consecutive quarters = flag (replaces v3's undefined "rising")
- Retail sales (FRED `RSAFS`): MoM decline for 2+ consecutive months, or
  3-month annualized growth below 0% = flag consumer pullback (replaces v3's
  undefined "deceleration or MoM declines")
- 10yr breakeven inflation (FRED `T10YIE`): above 2.5%, sustained 4+ weeks =
  flag unanchored expectations (replaces v3's undefined "meaningfully above")

## Contextual Indicators (informational only — Tier 2, never gate wave authorization)

Exposed via the `get_context_indicators` MCP tool. These broaden situational
awareness beyond the original 6-indicator panel, using series already free on
FRED. **They are explicitly not part of the 3-of-6 RED wave-authorization
gate** — that formula stays exactly VIX / HY spread / S&P drawdown / 10yr
yield / Sahm Rule / Fed pivot signal, fixed per the build spec's own non-goal
("wave thresholds are set by me... the rule engine does not propose or
auto-update them"). Use these only to enrich narrative synthesis and to set the
confidence qualifier per Signal Tiering.

| Indicator | Source | Signal framing | Suggested magnitude band |
|---|---|---|---|
| St. Louis Fed Financial Stress Index | FRED `STLFSI4` | Positive = above-average financial stress; negative = below-average | 0–0.5 mild, 0.5–1.5 elevated, >1.5 severe |
| Chicago Fed National Financial Conditions Index | FRED `NFCI` | Positive = tighter than average conditions; negative = looser | >0.3 sustained 4+ weeks = flag tightening |
| 10yr breakeven inflation | FRED `T10YIE` | Context vs Fed's ~2% PCE target | See Complacency Watch Bands above |
| Senior Loan Officer Survey (C&I tightening, large/medium firms) | FRED `DRTSCILM` | Positive = net tightening lending standards (credit contracting) | >20% net tightening = flag |
| Overnight reverse repo | FRED `RRPONTSYD` | Liquidity parked at the Fed; declining can reflect either liquidity draining into risk assets or T-bill supply dynamics | Genuinely bidirectional — do not assign a single-direction band; read only alongside NFCI/STLFSI4 direction, per Signal Tiering Tier 2 rule (context only, never scored alone) |
| 2s10s yield curve spread | Derived: FRED `DGS10` − `DGS2` | Below 0 = inverted, historically precedes recessions by several quarters | Tier 1 (already in bond-market bands above) |
| Initial jobless claims | FRED `ICSA` | Sustained rising trend = labor market weakening | See Complacency Watch Bands above (4-week MA rule) |
| Hires rate (`hires_rate_pct`) | FRED `JTSHIR` (BLS JOLTS, monthly) | Added 2026-09-15 (external review): claims measure layoffs, this measures whether people are finding new jobs — a falling hires rate alongside flat claims can mask a hiring slowdown claims alone wouldn't show | Read alongside initial/continuing jobless claims, not as a standalone gate |
| Credit card delinquency rate | FRED `DRCCLACBS` | Rising = consumer financial stress increasing | See Complacency Watch Bands above |
| WTI crude oil | FRED `DCOILWTICO` | Above $100/barrel = stagflation accelerant | See Recovery/Complacency band above |
| Copper price (`copper_price_usd_per_ton`) | FRED `PCOPPUSDM` (IMF-sourced, monthly) | Added 2026-09-22. "Dr. Copper" — a classic leading growth/recession-cycle indicator (industrial demand turns often show up here before official data). No confirmed free-flow (SSGA-style NAV-history) source exists for copper ETFs (CPER is USCF-issued, not SSGA), so this is price-level only, same treatment as WTI oil above | Informational cross-check for the Type B (Recession) crash-type diagnosis (Stage 1 below) — deliberately NOT one of that diagnosis's three hard trigger criteria (unemployment/Sahm/CPI), which stay unchanged. Monthly cadence — a single month's move means little, read the trend |
| Retail sales (advance, all stores) | FRED `RSAFS` | Closest free proxy for consumer/card spending strength — FRED has no public real-time card-swipe series | See Complacency Watch Bands above |
| Secured Overnight Financing Rate (repo stress) | FRED `SOFR` | Spikes above the Fed's target range signal repo/dollar-funding stress (e.g. Sept 2019) | Read alongside overnight reverse repo — no single-direction band |
| Broad U.S. Dollar Index | FRED `DTWEXBGS` | Rising = dollar strength, tightens global dollar-funding conditions and pressures EM/commodities | Read as a global-transmission signal, not directional on its own |
| Chicago Fed NFCI Risk Subindex | FRED `NFCIRISK` | Positive = elevated financial-sector volatility/funding risk; a narrower cut of the composite NFCI already tracked | Same interpretation convention as composite NFCI |
| Chicago Fed NFCI Credit Subindex | FRED `NFCICREDIT` | Positive = tighter credit conditions specifically (vs. the composite NFCI, which blends credit/leverage/risk) | Same interpretation convention as composite NFCI |
| 10yr TIPS real yield | FRED `DFII10` | Rising real yields pressure equity valuations independent of nominal-rate moves | Covers only the real-yield leg of "equity valuation" — no free earnings-yield/CAPE series exists on FRED; do not treat this as a full valuation read |
| Recession probability (smoothed) | FRED `RECPROUSM156N` | Chauvet & Piger's published dynamic-factor Markov-switching model, hosted on FRED by the St. Louis Fed (not built by them — correct attribution matters) | External cross-check against this system's own crash-probability estimate — never validation of it. Agreeing or disagreeing with it doesn't make the estimate more or less correct |
| Recession probability (NY Fed, 12mo) | Computed from FRED `DGS10`/`DGS3MO` | The NY Fed's own published Estrella-Mishkin (1998) yield-curve probit formula, `Φ(-0.5333 - 0.6330 × (DGS10-DGS3MO))`, evaluated here rather than scraped — the NY Fed does not publish this as its own FRED series (verified before adding it). Coefficient corrected 2026-09-15 (was `-0.6629`, stale since first built — an external review live-fetched the NY Fed's current PDF and confirmed `-0.6330`; the NY Fed periodically re-estimates its own published model, same staleness class as the FOMC calendar dates). Also uses spot `DGS10`/`DGS3MO`, not the NY Fed's own monthly-average convention — a known, flagged approximation, not fixed | Same external-cross-check caveat as above. The model is deliberately simple by its own authors' design — adding more variables tends to overfit out-of-sample, worth remembering before adding a 3rd/4th competing probability model here |
| Small-cap breadth (IWM vs. SPY) | Derived: Massive IWM/SPY 7-day return spread | Russell 2000 (IWM) vs S&P 500 (SPY) relative 7-day return — the closest free proxy for market breadth (no raw advance/decline or %-above-200dma series exists for free). Small-caps are more exposed to domestic credit conditions and floating-rate debt, so persistent underperformance can be an early stress signal before it shows up in large-cap earnings | First cut, not backtested — persistently negative for 2+ weeks is worth a second look, not a calibrated threshold. Tracked independently of the BrokerageLink watchlist (`ingestion/src/sources/massive.ts`'s `BREADTH_TICKERS`) so a Portfolio Opportunity Review's full-replacement watchlist sync can never delete it |
| Gold price (`gold_price`) | Massive `GLD` (SPDR Gold Shares) 7-day % change | Directional context for gold's *existing* real allocation in the Type C (6.96%) and Type E (4.35%) crash-type sleeves (see Stage 3 below) — not a new signal. Not a universal hedge: sold off alongside equities during 2008's acute margin-call/liquidity-panic phase before rallying later once the monetary response kicked in | Read directionally alongside the sleeve rationale, not as a hard flag — a decline here doesn't automatically contradict the crash thesis |
| Bitcoin price (`bitcoin_price`) | Massive `X:BTCUSD` (crypto locale) 7-day % change | Added 2026-09-14, tracked for awareness only — explicitly **not** a defensive/hedge asset. Verified against actual crash-period data before adding: BTC fell 40-58% in the March 2020 COVID crash (S&P fell 30-35%) and 77% in the 2022 bear market (S&P -25%/Nasdaq -33%) — higher-beta than equities in both of this system's real crash episodes | Never treat a BTC decline as confirming, or a BTC rally as contradicting, the crash thesis. This is tracking only — it does not add BTC to any crash-sleeve allocation, and does not resolve the still-open "gold sleeve-weight assumptions" question below |
| Sector capital rotation (`sector_rotation`) | State Street's own free NAV-history files (`ingestion/src/sources/ssga.ts`), 11 Select Sector SPDRs + SPY + GLD — NAV price return, an estimated creation/redemption flow (share-count change × NAV), and a `rotation_read` classification at 30/90/180/365 days | Added 2026-09-15 after a long search for a *real* flow signal (not a price proxy) for sector-level capital rotation. Every commercial fund-flow source checked (ICI, ETF.com, EPFR/Lipper/BofA, a third-party ETF.com scraper) was either paid or bot-blocked; the issuer's own regulatory-disclosure NAV-history file turned out to be free, unauthenticated, and genuinely dynamic day-to-day (share-count changes only reflect real creation/redemption, unlike AUM or price). NAV history is **not split-adjusted** — a real 2:1 XLK split on 2025-12-05 initially corrupted every return/flow calculation spanning that date (365d showed a fake -32% instead of the true +36%) until `adjustForSplits()` was added to detect and retroactively correct for it | `flow_estimate_usd` is ETF-**vehicle**-level, not a complete picture of money entering/leaving the underlying sector — investors can get the same exposure through other ETFs (e.g. QQQ/VGT/SMH instead of XLK). `nav_return_pct` is price-only, not total return (dividends excluded — a fast-follow, not v1; Massive's `/stocks/v1/dividends` endpoint was separately verified working). `rotation_read` (`confirmed_in`/`confirmed_out`/`accumulation_divergence`/`distribution_divergence`) exists because return alone can't distinguish genuine rotation from price noise — report it explicitly rather than just the raw return. CFTC COT and Fed Z.1 (also investigated) measure positioning and macro-level transactions respectively, not sector-level flow — kept as separate, deferred items, not folded into this one. Added 2026-09-15 (external review): `nav_return_vs_spy_pct` (return relative to the market — a positive absolute return can still be substantial underperformance, e.g. +2.9% over 180d while SPY did +15%) and `flow_pct_of_assets` (flow as % of assets at the window's start, so a $1B flow into a $10B sector doesn't read as equally significant as one into a $1T sector) |
| Effective Fed Funds Rate (`effective_fed_funds_rate_pct`) | FRED `DFF`, daily | Added 2026-09-22 (prompted by a discussion of the "fiscal dominance" thesis). The Fed's own overnight rate — distinct from every yield series above (`DGS2`/`DGS10`/`DGS30`/`DGS3MO`), which are market-priced Treasury yields, not the Fed's target/effective rate. Chosen over the monthly `FEDFUNDS` series to match this file's existing daily-series cadence | No single-direction band — read alongside the yield curve and `broad_dollar_index`, not as a standalone gate |
| Federal Debt as % of GDP (`federal_debt_pct_gdp`) | FRED `GFDEGDQ188S`, quarterly | Added 2026-09-22, same prompt as above. The structural debt-load series the "fiscal dominance" thesis centers on — the claim that continued deficit spending/borrowing is now the dominant force on markets, capable of keeping equities resilient even through rising yields (overriding the usual yield-vs-equity relationship this system's own `treasury_10y`/`thirty_year_treasury_pct` bands assume). No free FRED series updates faster than quarterly for this | Watch the trend/rate of change, not a single level — this system does not (yet) have a calibrated threshold for what debt/GDP level itself should change the crash read. Read alongside `gold_price`, which the same thesis treats as the primary debasement/reserve-revaluation hedge |

> **2026-09-14 note:** gold and Bitcoin were added as tracked contextual
> indicators after a discussion about defensive assets. Gold already had a
> real allocation in the crash-type sleeves but no live price was ever
> tracked anywhere — this closes that gap, purely as tracking; it does not
> touch the sleeve allocation percentage, which stays an open, unexamined
> question (see `BACKLOG.md`'s "Allocation assumptions inside the crash-type
> layers"). Bitcoin was added only after verifying — not assuming — its
> actual crash-period behavior; the popular "digital gold, uncorrelated
> hedge" narrative did not survive contact with either real crash episode
> this system tracks, so it is deliberately framed here as informational
> awareness only, never as a defensive signal.

> **2026-08-16 note:** `OECDLOLITOAASTSAM` (OECD Composite Leading Indicator, a candidate
> global-PMI stand-in) was tried and dropped after verification showed its
> latest observation frozen at 2022-11-01 — not merely "monthly and lagged"
> as assumed, but years stale, suggesting FRED has stopped updating or
> discontinued this series code. Presenting a 4-year-old number as a live
> reading would be actively misleading, so it was removed entirely rather
> than kept with a caveat. Global PMI remains an unfilled gap.

---

## Fiscal Dominance Regime Checklist (informational only — never gates, structural cadence)

Added 2026-09-22, prompted by a discussion of the "fiscal dominance"
thesis. **Fiscal dominance has a real, specific
definition** (Leeper 1991's fiscal/monetary policy-regime framework): it is
not "debt is high" or "yields are high" — it is a regime where the fiscal
authority runs deficits without adjusting to stabilize debt (an "active"
fiscal policy), which *constrains* the central bank's ability to set rates
purely on inflation grounds (a "passive," accommodative monetary policy).
Level alone (e.g. `federal_debt_pct_gdp` above) cannot answer whether that
constraint actually exists — these four checks test the constraint more
directly, each with real free data, computed identically in
`mcp_server/src/lib/regimeIndicators.ts` and duplicated client-side in
`dashboard_site/index.html`'s `renderFiscalDominanceChecklist()` (same
duplication convention as every other MCP-mirrored formula in that file).

**Deliberately not a single score.** Exactly like crash-type diagnosis, this
is presented as separate checks with their own caveats, never averaged or
reduced to one "fiscal dominance: yes/no" verdict — doing so would
manufacture a precision none of these four checks individually supports.
This is also a **structural, slow-moving** classification (3 of the 4 inputs
update quarterly or slower) — reassess roughly quarterly in narrative, not
as a daily flag.

| Check | Data / formula | What it tests | Caveat |
|---|---|---|---|
| Taylor Rule gap | `DFF` (effective Fed funds) vs. a Taylor (1993) rule computed from `CPIAUCSL` YoY inflation and an Okun's-Law output-gap proxy (`UNRATE` − `NROU`, CBO's Noncyclical Rate of Unemployment) | Is the Fed's actual rate below what inflation/employment alone would justify — the most direct test of "policy is constrained," the actual definition of fiscal dominance | Assumes a 2% neutral real rate and 2% inflation target (the original paper's own constants, not fitted/calibrated) and an Okun coefficient of 2. A negative gap is *one candidate signal*, not proof — an ordinarily-dovish Fed looks identical in this one number. **`NROU` needed a `fetchLatestObservation`/`fetchFredHistory` fix** (`observation_end` pinned to today) before it could be added at all: CBO publishes this series' full projected path years into the future already populated as real (non-`.`) observations, so the standard "sort desc, take first" ingest pattern would otherwise have silently ingested a decade-future projection as "today's" reading |
| Primary balance | `FYFSD` (OMB annual total budget balance) + `A091RC1Q027SBEA` (BEA net interest, quarterly SAAR) → `primary_balance = total_balance + net_interest` | Is the government running a deficit even *excluding* interest payments — the textbook "active fiscal policy" (non-Ricardian) signature: the fiscal authority isn't adjusting spending/taxes to stabilize debt on its own | `FYFSD` is annual cash-basis (OMB); `A091RC1Q027SBEA` is quarterly accrual-basis (BEA NIPA) — different period and accounting convention, combined as a structural approximation, not a precisely reconciled dollar figure |
| Net interest as % of GDP and % of federal revenue | `A091RC1Q027SBEA` ÷ `GDP`, and `A091RC1Q027SBEA` ÷ `FGRECPT` (all $billions, quarterly SAAR — same units/cadence, clean direct ratios unlike the primary-balance pairing above). `FGRECPT` (BEA's broader "Federal government current receipts" total — tax + social-insurance + other) added 2026-09-22 after external review; `W006RC1Q027SBEA` ("current TAX receipts" only) was checked first and rejected — it excludes social-insurance contributions (~$2.2T/quarter), which would understate the denominator and overstate the burden | Whether debt service is becoming a rising, increasingly hard-to-reverse constraint on the budget — the mechanical channel through which debt actually limits how high the Fed can push rates. The revenue share is the more commonly-cited, more mechanistically direct cut (closer to "can the government service this from its own income," nearer the actual debt-sustainability question) than the GDP share | Watch the multi-quarter trend, not one reading |
| Gold ↔ real-yield correlation | 180-calendar-day rolling Pearson correlation of gold's (`GLD`) daily % change vs. 10yr TIPS real yield's (`DFII10`) daily level change | Whether gold's normal inverse relationship with real yields (higher real yields = opportunity-cost headwind for a non-yielding asset) has broken down — the market-based "debasement hedge" tell, since gold rising *despite* rising real yields is harder to explain any other way | Correlation of day-over-day *changes*, not raw levels (a levels-based correlation over 180 days would mostly just reflect that both series trend). Not backtested/calibrated — a first cut, same tier as every divergence flag in this system. This is also the "rolling-correlation infrastructure" the architecture doc previously listed as deliberately deferred — built now because it's the most direct real-data test of this thesis's most distinctive claim |

Exposed via `get_context_indicators`'s `fiscal_dominance_checklist` field
(mcp_server) and a "Fiscal Dominance Regime Checklist" card on
`dashboard_site`. Not persisted to `crash_checks` — computed fresh from
`data_points` on every read, same treatment as `yield_curve_2s10s` and the
NY Fed recession-probability field above, not a new column/migration.

---

## Cross-Indicator Divergence Detection (informational only — never gates)

Computed once daily by the rule engine (`rule_engine/src/divergence.ts`, not
this doc's own source until now — this section was added 2026-08-16 to close
a real spec gap, since divergence detection existed only in code for weeks
before this). Persisted to `crash_checks.divergence_flags` — `get_context_indicators`
and `dashboard_site`'s "Signal Relationships" card both read that one
persisted value, never recompute independently. Thresholds are a first cut,
not backtested/calibrated — same caveat as everything else in this document
marked as a starting point rather than a validated model. Each pair uses a
7-day delta (most recent value vs. the most recent observation on or before
7 calendar days prior, not a strict trading-day offset).

| Pair | Diverging condition | `diverging: true` means |
|---|---|---|
| IG vs. HY credit spread | IG widened ≥3bps/7d while HY moved ≤1bps/7d | Concerning — quality-flight signal ahead of the gating HY spread |
| Initial vs. continuing jobless claims | Continuing claims rose ≥15,000/7d while initial claims moved ≤5,000/7d | Concerning — laid-off workers taking longer to find new jobs |
| VIX vs. HY credit spread | VIX rose ≥3pts/7d while HY moved ≤5bps/7d | **Reassuring** — equity-specific noise, not confirmed credit stress |
| HY widening vs. VIX calm | HY widened ≥5bps/7d while VIX moved ≤3pts/7d | Concerning — credit stress surfacing before equity vol does (credit often leads equity) |
| Gold vs. silver | Gold's 7d % change exceeds silver's by ≥3 percentage points | Gold outperforming silver by this much is a classic flight-to-safety read (investors favoring the purer monetary metal over the more industrially/growth-linked one) — not proof of anything on its own |

The last pair before gold-vs-silver is the reverse direction of the third —
added 2026-08-16, previously the more concerning "credit moves first"
direction was missing entirely. Its thresholds deliberately reuse the
VIX-vs-HY pair's own two constants (5bps, 3pts), flipped, rather than a
fresh unbacktested number.

**Gold vs. silver (added 2026-09-22)** is the one pair here compared by
7-day **percent** change rather than a raw delta — gold's and silver's
price levels differ too much for a raw $ move to mean anything side by
side, unlike the bps/pts pairs above which share comparable units within
each pair. This is a delta-based read on short-term relative performance,
not an absolute gold/silver *ratio level* analysis (the more commonly-cited
version of this signal, which needs historical percentile bands this
system doesn't compute) — same "first cut, not backtested" caveat as every
other threshold here. Silver (`SLV`, tracked via Massive) exists only as
this pair's input — deliberately not exposed as its own standalone
contextual indicator, since it has no tied decision the way gold's Type
C/E sleeve allocation does; a bare silver price line would just be noise.

**Known data limitation**: `BAMLH0A0HYM2`/`BAMLC0A0CM` (the two credit-spread
series feeding 3 of these 4 pairs) only have real history back to
2023-07-11/2023-07-17 in this system, not the 1996 inception commonly cited
for these FRED series — confirmed via live query and backfill logs, not an
ingestion bug. This meaningfully limits how far back any future calibration
of these thresholds can be checked.

Deliberately deferred, not started: rolling-correlation infrastructure, and
a regime-dependent 10yr-Treasury-vs-equities pair (its intended meaning
genuinely differs by macro regime, so it needs the regime concept from the
future hazard-model work to mean anything, not a naive non-regime-aware
version now).

---

## Statistical Hazard Model (10% Drawdown)

**What it estimates**: P(S&P drawdown reaches ≥10% from its all-time-high
within ~21 trading days), conditional on not already being past that
threshold — a "is a fresh correction about to start" read, not "how deep is
the current one." Computed once daily by `rule_engine/src/hazardModel.ts`,
alongside the 6-indicator panel. **This is rule-engine-owned and
deterministic, the same way the panel above is** — contrast with the
"Crash-Probability Scoring Methodology" section directly below: `crash_
probability_pct` is arithmetically derived (in `mcp_server`, not the rule
engine) from the scenario distribution, which is 100% LLM judgment with no
backtest behind it — a genuinely different kind of number from this
walk-forward-validated model, not just a different owner. The two numbers
measure different things and are never meant to be blended, averaged, or
treated as validating one another.

**Methodology (as originally claimed — see status note below)**: a logistic
regression over 32 features (FRED macro/market levels + their trading-day
deltas, plus a derived 2s10s curve spread and 20-day realized volatility) —
walk-forward validated with an expanding window, leave-one-crisis-out across
the 5 real ≥20%-drawdown episodes since 1993 (dot-com, GFC, Dec 2018, COVID,
2022), then recalibrated with isotonic regression (stratified 5-fold on the
pooled out-of-sample predictions) after the raw model was found
miscalibrated. An episode-level block bootstrap (resampling whole crises,
not individual days — daily observations inside one crisis aren't
independent) reportedly confirmed a real, non-noise edge over a naive
base-rate guess specifically for this 10% target.

**A companion 20%-drawdown target was reportedly tested and shelved** — its
bootstrap confidence interval spanned zero (given only 4 usable real
episodes for that deeper threshold), meaning it couldn't be statistically
distinguished from a naive guess. Not shipped in any form.

**Status (confirmed 2026-09-19)**: the original training script/notebook,
the trained artifact's derivation, label/fold definitions, and bootstrap
output are not recoverable from this repository — an external review plus
a follow-up search turned up nothing beyond the frozen coefficients already
in `hazardModel.ts`. Everything in the two paragraphs above is what the
original research *claimed*, not something anyone can currently
independently verify or reproduce. Treat this model's validation as
documented but unverified, not as an established fact, until a full rebuild
(point-in-time data reconstruction, refit, leakage-safe backtest against
simple baselines — a substantial standalone project, not a quick check) is
actually done.

**Why it's shown as a band, not a percentage**: the isotonic calibration
curve is steppy, not smooth — two wide flat plateaus (~22-24% for any raw
model score below ~15%, ~93% for any raw score from ~26% up to ~83%), with
almost all real differentiation packed into the narrow 15-26% raw-score
band between them. Displaying a precise-looking percentage would overstate
how finely this model can actually discriminate. Bands (on the calibrated
probability): **LOW** <35%, **TRANSITIONING** 35-90%, **HIGH** ≥90% —
chosen to align with the plateau structure, not evenly spaced, and
deliberately not styled with the panel's green/amber/red convention (see
Formatting Requirements below) since this isn't a gating status.

**Dashboard presentation fix (2026-09-15)**: the public dashboard card was
found to directly contradict this design choice — it showed the band, then
immediately displayed "Calibrated X% (raw model output Y%)" in the
prominent slot right below it, undermining the whole "shown as a band, not
a precise percentage" rationale. The exact raw/calibrated numbers are still
shown (this project's own transparency standard — never hide real data),
just moved into the card's smaller methodology-detail text rather than the
headline slot, so the presentation actually matches the stated intent.

**Trading-day-exact deltas (fixed 2026-09-15)**: the research validated this
model using 5-trading-day/20-trading-day deltas. Production previously
approximated these as 7/28 calendar days (flagged, not silent) — an external
review pointed out this was an avoidable research-to-production mismatch,
especially since a small raw-score movement can cross a plateau boundary in
the isotonic calibration curve. Fixed via `getTradingDayAnchor()`
(`rule_engine/src/lib/seriesDelta.ts`), which counts back rows in `SP500`
(this system's own market-calendar reference series) instead of
approximating with calendar subtraction. Verified live: 5 trading days back
from 2026-09-14 correctly resolves to 2026-09-04, properly skipping both the
weekend and Labor Day — the old calendar-7-day approximation landed on
2026-09-07 (Labor Day itself, not a real trading day).

**Credit-spread proxy**: uses `BAA10Y` (Moody's Baa − 10yr Treasury spread)
rather than the production HY OAS series (`BAMLH0A0HYM2`), because the
latter has no usable history before 2023-07-11 — nowhere near enough to
validate against any of the 5 real historical crises this model was trained
and tested on. `BAA10Y` is a different economic object (an investment-grade
spread, not a junk-grade one) and a reasonable, not exact, substitute. An
external review (2026-09-15) confirmed this substitution is sound as long as
training and production score off the same series consistently (true here)
— the dangerous version would be training on one and scoring on the other.

**Known, confirmed data-leakage issue — not fixed, requires retraining, not
just a code change**: `RECPROUSM156N` (Chauvet-Piger smoothed recession
probability) is one of the 32 trained features. Its producer's own FAQ
confirms smoothed historical values are revised using data that wasn't
available at the time ("potentially influenced by data that wasn't
available the first time a recession probability for a particular month was
calculated" — jeremypiger.com/recession_probs_faq), plus a real December
2020 methodology change for the COVID period. This means the model's
`RECPROUSM156N` coefficient (+0.306) was fit on hindsight-contaminated
historical data — confirmed via an external review, verified independently
against the producer's own documentation before accepting it, not just
taken on the reviewer's word. **This is deliberately not patched by editing
`FEATURES`/`INTERCEPT`** — coefficients in a fitted logistic regression are
joint; deleting or zeroing one feature's line without refitting the whole
model doesn't remove the contamination, it just introduces a different,
uncontrolled distortion (equivalent to silently injecting a constant bias).
The only valid fix is retraining with the feature removed or replaced with
point-in-time (ALFRED) vintages — real research work, not available in this
session (the original training pipeline was never preserved in this repo).
Tracked in `BACKLOG.md`.

**Where it's surfaced**: `get_indicator_panel` (the `hazard_model_10pct`
field) and the dashboard's "Statistical Hazard Model" card, placed
separately from the crash-probability meter, never adjacent to or blended
with it. **Where it deliberately is NOT used**: it is not part of the 3-of-6
wave-authorization gate (that gate's exact six inputs are fixed — see the
Contextual Indicators section's own non-goal above), and it is not an input
to Claude's `write_snapshot` synthesis. `null` fields mean the model
temporarily failed to compute that run (e.g. a transient gap in one input
series) — treat as unavailable, never as a reading of zero.

---

## Crash-Probability Scoring Methodology (IMPLEMENTED 2026-09-22 — derived, not judged)

> **Status as of 2026-09-22 (current):** `crash_probability_pct` (and its
> low/high range) is no longer a second independent LLM judgment — it's a
> fixed arithmetic derivation from the scenario distribution, computed by
> `mcp_server`'s `write_snapshot` (not the rule engine — see the Layer
> Boundary section's exception note above for why that's still consistent
> with this doc's layering):
>
> - `crash_probability_pct` = round(`scenario_crash_pct` + 0.5 × `scenario_bear_pct`)
> - `crash_probability_low_pct` = `scenario_crash_pct`
> - `crash_probability_high_pct` = `scenario_bear_pct` + `scenario_crash_pct`
>
> **Why this replaced two independent judgments:** both numbers were
> previously committed by the LLM in the same step, from the same
> underlying data, with only a loose internal-consistency *bound* enforced
> between them (added 2026-09-20, see below) — a 20-point-wide legal band
> that let the headline drift for no explained reason (found live: one real
> report had crash_probability_pct=17% against scenario_crash_pct=5%/
> scenario_bear_pct=20%, technically valid but arbitrary within [5, 25]).
> The scenario distribution is the structurally sounder of the two formats —
> a forced decomposition into 4 mutually exclusive, exhaustive buckets
> summing to 100 is a real forecasting-discipline technique, more resistant
> to anchoring/round-number bias than a single free-floating number, and
> carries strictly more information (4 numbers vs. 1). The system's own
> prior design already treated it as more fundamental (that's why the Sep-20
> fix bounded the headline BY the scenario split, not the reverse) — this
> change follows that logic to its conclusion: stop asking for a second
> guess, derive the headline from the first one.
>
> **What this is not:** neither number is independently validated against
> outcomes — the scenario distribution itself is still 100% LLM judgment,
> with no defined forecast horizon, no historical labels, no backtest. This
> derivation only guarantees internal consistency (impossible to contradict
> itself by construction, instead of merely bounded), not accuracy.
>
> **Original history, kept for context:** this section was originally
> written 2026-07-11 on the suspicion that the live crash-probability %
> might be coming from the LLM reporting layer instead of the deterministic
> rule engine. That was confirmed true but found to be a deliberate,
> pre-existing design decision (the master-prompt task list explicitly
> scoped "crash probability + scenario distribution" as Claude's qualitative
> synthesis job), not an oversight. A real anchoring bug (the LLM seeing its
> own prior probability before forming a new one) was fixed separately at
> the instruction/tool level, without changing who computed the number —
> see commit `5d791f1`. The point-based formula below (0–70 panel-position
> points + confirmation multiplier + context adjustment + crash-type
> proximity) was drafted 2026-07-11 as a possible future deterministic
> replacement, sourced from the 6-indicator panel directly rather than the
> scenario distribution — **never implemented, and superseded by the
> simpler scenario-derived formula above, not merely still-deferred.** Kept
> below only as a record of an alternative that was considered and not
> chosen, not as a live draft.
>
> **2026-09-20 — internal-consistency bound (superseded 2026-09-22 by the
> full derivation above, kept for history):** required `scenario_crash_pct
> <= crash_probability_pct <= scenario_bear_pct + scenario_crash_pct` as a
> validation gate on two independently-committed numbers, rather than
> computing one from the other. This closed outright contradiction but not
> arbitrary drift within the legal band — see "why this replaced two
> independent judgments" above for the report that prompted going further.

### Rejected alternative, kept for record (never implemented)

**Base score — Tier 1 panel position (0–70 points):** for each of the 6 core
indicators, score its position within its own band, not just its color:
GREEN = 0–3pts (scaled by proximity to the AMBER line), AMBER = 4–8pts (scaled
by proximity to the RED line), RED = 9–12pts (scaled by distance past the RED
line, capped). Sum across all 6, then normalize to a 0–70 point subtotal.
This keeps a VIX of 34 (just under RED) scoring meaningfully higher than a VIX
of 21 (just over GREEN), instead of collapsing everything to 3 flat buckets.

**Confirmation multiplier:** any indicator still "pending confirmation" (per
Signal Tiering — not yet true across 2 distinct ingestion dates) contributes
at only 50% of its computed points until confirmed. This is what keeps a
single day's data landing on a noisy print from swinging the headline
probability before it's had a chance to persist.

**Context adjustment — Tier 2 overlay (±15 points):** apply only the
escalation rule already defined in Signal Tiering — sustained (4+ week)
adverse moves across 3+ Tier 2 indicators add up to +15 points; do not score
Tier 2 indicators individually or let any single one move the number.

**Crash-type proximity (0–15 points):** if a drawdown ≥15% is active, add
points for how many of a candidate crash type's 3 confirming criteria (Stage
1) are already met (5 points per criterion met, any single type).

**Total = Base + Context adjustment + Crash-type proximity, clamped to
0–100, then divided by 1 (i.e. reported directly as the %).** Recompute at
every check; the confidence tag (Low/Medium/High persistence, per Formatting
Requirements) is Low if fewer than 2 of the 6 core indicators are past their
confirmation bar, Medium if 2–3 are, High if 4+ are.

Not implemented, and not a live draft — superseded by the scenario-derived
formula above. Kept only so a future editor doesn't re-propose the same
approach without knowing it was already considered and set aside in favor
of the simpler, more directly-grounded derivation.

---

## Risk Radar Scoring Methodology (public, daily — `risk_radar`)

**What it is**: a 6-axis discretionary macro-risk read (geopolitical,
policy_fed, inflation, valuation, labor_market, earnings — each 0-100),
required on every `write_snapshot` call, same cadence as
`crash_probability_pct`. Surfaced on the public dashboard.

**Why this exists alongside the private Portfolio Review's own risk_radar**:
that one (`write_portfolio_review`) is Portfolio-Review-triggered, not
daily, and has no documented scoring basis ("reflecting this run's own
judgment" is the entire spec). This section exists specifically to close
that gap for the *public, daily* version — the private one is unchanged.

**Like `crash_probability_pct` above, this is discretionary LLM judgment,
not a calibrated model** — the difference is 4 of the 6 axes are anchored
to real series already tracked in this system, not free-form:

- **`policy_fed`** — anchor to `fed_pivot_signal` (NONE/PAUSE/CUT) and
  `get_trigger_status`'s `fed_event_trigger` proximity. 0-25: NONE, no
  FOMC within 2 weeks. 26-50: PAUSE, or an FOMC meeting within 2 weeks.
  51-75: CUT, or an active hiking cycle. 76-100: emergency/inter-meeting
  action.
- **`inflation`** — anchor directly to `T10YIE`. 0-20: <2.0%. 21-40:
  2.0-2.5%. 41-65: 2.5-3.0% (the existing "sustained 4+ weeks" complacency
  flag threshold). 66-100: >3.0%.
- **`labor_market`** — anchor to the Sahm Rule color, ICSA/CCSA trend, and
  `CGBD2024`. 0-25: Sahm GREEN, stable claims. 26-50: Sahm AMBER, or
  rising claims. 51-75: Sahm RED (unconfirmed), or accelerating claims.
  76-100: Sahm RED confirmed, broad-based deterioration.
- **`valuation`** — anchor to `DFII10` (real yield) as the closest
  available proxy. Same caveat as `tips_real_yield_10y_pct` above: this is
  the real-yield leg only — no free earnings-yield/CAPE series exists on
  FRED, so this axis alone cannot represent a full valuation read.
- **`geopolitical`** and **`earnings`** — **no free anchoring data exists
  for either** (real, standing gaps, same category as the missing
  global-PMI/CAPE series already documented elsewhere in this file). These
  two stay genuinely judgment-based, banded only by narrative severity
  (0-25 no material tension/earnings concern ... 76-100 crisis-level
  escalation/broad earnings collapse) — same tier as `crash_type`/
  `warsh_classification`, already-accepted judgment fields in this system.

**Non-goals**: does not feed `crash_probability_pct` (which is now derived
from the scenario distribution only — see the Crash-Probability Scoring
Methodology section above), does not score into the 3-of-6 wave-
authorization gate, is not validated or back-tested. A reader should not
treat all six axes as equally grounded
— `geopolitical`/`earnings` carry materially less anchoring than the other
four, and the dashboard card says so explicitly.

---

## Formatting Requirements

**Rule Engine Output Contract (read alongside Layer Boundary above).** Every
number, color, streak, confirmation status, and probability figure rendered
anywhere in the dashboard must be read directly from what the rule engine
already wrote to the "current state" table. The LLM/reporting layer's job in
formatting is to lay that data out clearly — never to restate a value in its
own words with different precision, round it differently, hedge it verbally
("looks close to RED"), or fill in a number the rule engine didn't provide.
If a value is genuinely missing (e.g. no probability score exists yet for
this run), the dashboard shows "not available," never a narrative estimate
standing in for it.

**Render every full crash check as an HTML artifact using `dashboard-template.html`
(in this same folder) as the base — not as plain chat text.** Reuse its structure,
CSS custom properties, and component classes (`.cc-card`, `.cc-indicator`,
`.cc-pill`, `.cc-stackbar`, `.cc-trigger`, `.cc-table`, etc.); replace the example
content with this run's live values. Keep the status-color semantics fixed:
green = `--good`, amber = `--warning`, red = `--critical` — never repurpose them
for anything that isn't a GREEN/AMBER/RED-style status. If a section's data isn't
available this run (e.g. no delta because it's the first check), omit or note it
rather than inventing a value.

**Two run types, explicitly labeled.** At ~6–7 checks/day, most runs are
lightweight automated indicator refreshes, not full narrative reports — the
observed export already distinguishes these ("No narrative for this entry —
this was an automated daily indicator refresh, not a full chat-triggered
report"). Make the distinction a rule, not an implicit side effect:
- **Automated indicator refresh** (the default, most runs): render the RED
  banner (if any), the 6-indicator grid with streak/confirmation status, the
  crash-probability meter, trigger status, and contextual indicators. No
  narrative synthesis, no crash-type diagnosis, no radar chart — label the
  run itself "Indicator Update" as already shown.
- **Full chat-triggered report** (on demand, or automatically when a
  confirmed threshold newly fires): adds narrative synthesis, Stage 1 crash-
  type diagnosis (if drawdown ≥15%), and brokerage-window watchlist. Label
  it distinctly (e.g. "Full Report") so the history view never makes the
  user guess which kind of entry they're looking at. (The radar chart is
  specific to the Portfolio Opportunity Review — see below — not part of
  this report.)

**Scan order, top to bottom (fixed):**
1. RED ALERT banner, if any indicator/wave condition is confirmed or pending confirmation
2. Crash-probability meter: point %, 3-day Δ, 7-day Δ, visual meter. Color
   code: green 0–20%, amber 20–35%, red 35%+. (A "confidence tag" based on a
   confirmation count was part of the rejected point-based formula above and
   was never implemented anywhere — dropped from this scan order rather than
   left as a dangling reference to a methodology that no longer computes it.)
3. 6-indicator grid — each row shows current value, RED/AMBER/GREEN pill,
   3-day Δ, 7-day Δ, and confirmation status (`Confirmed` / `Pending
   confirmation (day 1 of 2)`), with RED count displayed prominently (e.g.
   "1 of 6 RED confirmed, 1 pending — wave deployment not yet authorized")
4. Crash-type diagnosis (only rendered when drawdown ≥15%)
5. Wave status + brokerage-window watchlist: ticker | current price | Wave 1
   target | % distance | 3-day Δ | 7-day Δ | status pill (WAIT >20% above
   target / WATCH 5–20% above / BUY ZONE at or below)
6. Contextual (Tier 2) indicators — clearly labeled "informational, does not
   gate," each with an "as of" timestamp reflecting real source lag (FRED
   series are not same-day)
7. Narrative prose last, outside all widgets — no explanatory text inside
   dashboard components themselves

**Delta standard (applies everywhere a trend is shown):** always report both a
**3-day Δ** (short-horizon, noise-sensitive — flags a possible spike, not
yet actionable on its own) and a **7-day Δ** (velocity — the number that
matters for trend confirmation), explicitly labeled as such. Do not report a
bare "delta vs prior check" with an unstated window — if checks run
irregularly, compute both deltas off calendar days, not check-to-check gaps.

**The delta log itself is persisted structured data, not just rendered
prose (since 2026-08-27).** `write_snapshot`'s optional `delta_log` field
(`{sign: "pos"|"neg", text}[]`) captures the same colored bulleted list
already shown in the chat HTML artifact — previously this was only ever
built live at render time, so the public dashboard could only show
whatever unstructured prose ended up in `notes`, with no way to reconstruct
the colored +/- list from it. `dashboard_site` now renders `delta_log`
directly, using CSS that had sat unused since before this field existed.

**Confidence and recency (applies everywhere a point estimate is shown):**
- Every probability/point estimate carries a low-high range and an explicit
  Low/Medium/High persistence tag per the Signal Tiering escalation rule —
  never a bare point figure. This is judgment-based bracketing, not a
  statistical confidence interval — no version of this system has ever
  computed a true CI (see "What this system actually is," above), and this
  section should not be read as implying otherwise.
- Every externally-sourced figure (FRED series, CME FedWatch, etc.) carries an
  "as of" date reflecting the source's actual publication lag, not the
  dashboard's render time.

- KPI cards always show a color-coded benchmark pill: `"Favourable: X–Y / Now: Z"`
- Scenario distribution always shown as 4 buckets (Bull/Base/Bear/Crash) summing to 100%
- Brokerage-window watchlist and 6-indicator grid both carry a sparkline or
  delta-arrow per row so trajectory is visible, not just current state

**Render every Portfolio Opportunity Review as an HTML artifact using
`portfolio-review-template.html` (in this same folder) as the base** — same rule
as the crash check, not plain chat text. Reuse its component classes (`.cc-verdict-headline`,
`.cc-alloc-row`/`.cc-alloc-target`, `.cc-flag-card`, `.cc-ticker-card`/`.cc-prox-track`,
`.cc-source-card`, etc.); replace the example content with this run's live values.
The tactical 401k's allocation bars are informational context (it's wave-gated, not
drift-scored) — never color them as a drift alarm. The ticker proximity meter's
BUY/WATCH/WAIT zone widths and marker position should reflect each ticker's actual
price relative to its Wave 1/2/3 targets, not be evenly spaced by default.
- Radar chart comparing current vs prior check across: Geopolitical, Policy/Fed,
  Inflation, Valuation, Labor Market, Earnings
- No excessive prose inside dashboard widgets — explanatory text goes outside them
