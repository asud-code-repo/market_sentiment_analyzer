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
never a silently softened threshold. Vague language in this file isn't just
an "AI might interpret loosely" risk — it's a spec that literally cannot be
coded as written, which is a harder failure mode for a system whose entire
premise is that classification is deterministic.

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
`local_state/portfolio.yaml` for the live dollar figure). All S&P/VIX
conditions below require confirmation per the Signal Tiering rule — true
across 2+ distinct daily ingestion runs, not just repeated intraday checks
against the same day's data — a single volatile trading day does not
authorize deployment, even once that day's data has landed.

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
| Credit card delinquency rate | FRED `DRCCLACBS` | Rising = consumer financial stress increasing | See Complacency Watch Bands above |
| WTI crude oil | FRED `DCOILWTICO` | Above $100/barrel = stagflation accelerant | See Recovery/Complacency band above |
| Retail sales (advance, all stores) | FRED `RSAFS` | Closest free proxy for consumer/card spending strength — FRED has no public real-time card-swipe series | See Complacency Watch Bands above |

---

## Crash-Probability Scoring Methodology (DEFERRED — draft, not implemented)

> **Status as of 2026-07-11:** this section was originally written on the
> suspicion that the live crash-probability % might be coming from the LLM
> reporting layer instead of the deterministic rule engine — a live
> violation of this doc's own "no LLM does numeric classification" rule, if
> true. That was checked directly against the code: `rule_engine/src/classify.ts`
> never computes or writes `crash_probability_pct` at all; `mcp_server`'s
> `writeSnapshot()` takes it as a caller-supplied number and inserts it
> verbatim. So yes, the probability is 100% LLM-judgment today — but this
> turned out to be a **deliberate, pre-existing design decision** from early
> in this project (the original build spec wanted the rule engine to own
> `crash_checks`; the master-prompt task list explicitly scoped "crash
> probability + scenario distribution" as Claude's qualitative synthesis job
> — resolved by relaxing NOT NULL constraints so the rule engine writes
> partial rows and a later `write_snapshot` call fills in the rest), not an
> oversight this doc caught.
>
> What *was* a real bug: the LLM was shown its own prior probability/notes
> before forming a new estimate, creating anchoring rather than independent
> daily judgment. That's fixed at the instruction level (commit-before-peek
> ordering in the project instructions) and the tool level (`get_latest_snapshot`
> now diffs against the last row with a real probability, not just the
> chronologically-previous row) — see commit `5d791f1`. Probability itself
> **stays LLM-synthesized for now**, anchoring-fixed rather than replaced.
>
> The formula below is kept as a draft for if/when a deterministic version is
> wanted later — every weight in it is `[new default — calibrate]`, a
> reasonable starting structure, not a validated model, and it has not been
> back-tested against any historical data.

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

This formula should be treated as a working draft — back-test it against
whatever historical readings you have before letting the computed % replace
whatever ad hoc method has been producing it, and adjust the point splits
once you've seen how it tracks against known past drawdowns.

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
  type diagnosis (if drawdown ≥15%), the radar chart, and brokerage-window
  watchlist. Label it distinctly (e.g. "Full Report") so the history view
  never makes the user guess which kind of entry they're looking at.

**Scan order, top to bottom (fixed):**
1. RED ALERT banner, if any indicator/wave condition is confirmed or pending confirmation
2. Crash-probability meter: point %, confidence tag (Low/Medium/High
   persistence, per the Crash-Probability Scoring Methodology's confirmation
   count), 3-day Δ, 7-day Δ, visual meter. Color code: green 0–20%, amber
   20–35%, red 35%+
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

**Confidence and recency (applies everywhere a point estimate is shown):**
- Every probability/point estimate carries a confidence interval or, where a
  true statistical CI isn't available, an explicit Low/Medium/High persistence
  tag per the Signal Tiering escalation rule — never a bare point figure.
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
