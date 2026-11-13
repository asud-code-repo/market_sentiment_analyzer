# Crash-Check Enhancements — Build Spec (E1–E9)

Prepared 2026-11-13. Source: review of Ritesh Jain's (PineTree Macro) Sep 2026 webinar against the crash-check system.
Revised 2026-11-13 with the decisions from the first review pass (marked **Decision** below). This file is the source of truth for the build; update it in the same commit as any decision change.

## How to use this file

- Build in passes, not all at once. **First pass: E9 + E1 only.** Verify against the acceptance criteria before starting the next item.
- Suggested order: **E9 + E1 → E2 → E3 → E5 → E7 → E4 → E6 → E8**.
- Located modules (verify before relying on them):

  | Area | Where |
  |---|---|
  | FRED ingestion (daily + backfill) | `ingestion/src/sources/fred.ts`, run by `ingestion/src/ingest.ts` / `backfill.ts` |
  | Yahoo (VIX, ^GSPC fill) | `ingestion/src/sources/yahoo.ts` |
  | Watchlist / ETF prices | `ingestion/src/sources/massive.ts` (US stocks grouped-daily, no indexes) |
  | Treasury Fiscal Data (incl. auctions) | `ingestion/src/sources/treasury.ts` |
  | Plausibility bounds | `ingestion/src/lib/plausibility.ts` |
  | Band thresholds | `rule_engine/src/rules.ts` |
  | Divergence flags | `rule_engine/src/divergence.ts` |
  | MCP tools | `mcp_server/src/server.ts` |
  | Trigger calendar (FOMC/CPI) | `mcp_server/src/lib/economicCalendar.ts` (hardcoded array) |
  | Trigger dedupe + forced `fired` | `mcp_server/src/lib/supabase.ts` (`CANONICAL_TRIGGER_PREFIXES`; the forced-status check is a separate block) |
  | 3d/7d deltas | `mcp_server/src/lib/seriesDelta.ts` (reads `data_points` by `series_id`) |

- Any threshold marked *provisional* is a first guess, not backtested (see guardrail 4).
- If something in this spec conflicts with the existing codebase or with `project-instructions.md` / `crash-check-rules.md`, stop and ask rather than guess.

## Guardrails (must hold for every change)

1. New indicators (E1, E2, E4, E6) are **context-only**. They must never change `red_count`, `confirmed_red_count`, `wave_authorized` or `wave_active`.
2. Preserve the **anti-anchoring order**: no tool callable in project-instructions steps 1–6 may return a crash probability, scenario split or prior narrative.
3. **No personal dollar figures** in anything written to Supabase. Portfolio data stays local.
4. **Decision:** provisional thresholds are **named constants in code**, documented in `crash-check-rules.md`, and labeled `provisional` in tool output. No config system. A flag ships only after its threshold has been checked against backfilled history.
5. **Never hardcode or guess calendar dates** (refunding, auctions). Source official dates; surface `calendar_needs_update` when the calendar runs out.
6. Missing data is reported as `null` / unavailable — **never as zero or an estimate**.
7. Follow existing schemas: `divergence_flags` entry format, `trigger_status` entry format, `get_series_deltas` behavior.
8. Update `project-instructions.md` and `crash-check-rules.md` **in the same change** as any tool behavior they describe. **Decision:** additions to `project-instructions.md` are one or two lines each (it loads in full as project knowledge, ~21 KB); the detail goes in `crash-check-rules.md`, which `get_rules` serves by section.

---

## E9 — Rules-doc guardrail section · Priority 1 · Ship with E1 · Status: done

- **Touches:** `crash-check-rules.md`
- **Behavior:** Add a section stating E1, E2, E4 and E6 are context-only, never count toward `red_count`, `confirmed_red_count` or wave authorization, and that their thresholds are provisional until backtested.
- **Acceptance:** `get_rules` returns the section; **`rules.ts` and wave gating never consume these indicators** (Decision: reworded, since E2's divergence flag runs inside the rule-engine process).
- **Built:** `crash-check-rules.md` § "Context-Only Enhancement Indicators (E1/E2/E4/E6 — never gate, thresholds provisional)", with a status table and one `###` subsection per indicator.

## E1 — Repo-stress spread (SOFR − IORB) · Priority 1 · Status: done

- **Touches:** daily GitHub Action ingestion; `data_points`; `get_context_indicators`; `get_series_deltas`
- **Data:** FRED `SOFR` (already ingested), `IORB` (added), `IOER` (backfill only, before 2021-07-29). `RRPONTSYD` was already ingested.
- **Decision — storage:** store a derived series `SOFR_IORB_SPREAD_BPS` at ingestion (source `FRED_DERIVED`, same as `SP500_ATH`), so `get_series_deltas` works and history backfills. The rules doc notes it as an exception to the "sourced series only" convention. Net liquidity and stock-bond correlation stay computed at read time.
- **Decision — history:** splice IOER before 2021-07-29 so the spread starts with SOFR on 2018-04-03.
- **Behavior:**
  - Ingest SOFR and IORB daily; derive the spread in bps (each SOFR date paired with the policy rate in force that date).
  - Expose it in `get_context_indicators` as `repo_stress_spread` (spread, SOFR value + date, policy-rate series/value/date) alongside the existing reverse-repo reading.
  - Funding-pressure flag `repo_stress_spread.funding_pressure` (`flag`, `consecutive_days_above`, `above_since`, `provisional: true`), computed in `mcp_server/src/lib/repoStress.ts` over consecutive SOFR observations.
- **Original provisional threshold (rejected by the gate):** SOFR − IORB > 0bp for ≥ 3 consecutive business days.
- **Base rate, 2018-04-03 → 2026-11-12 (2,151 observations):**

  | Candidate | Episodes | Days flagged | Fires in |
  |---|---|---|---|
  | > 0bp × 3d | 25 | 12.5% | 2018–19, late 2025 (39-day run), Feb–Mar 2026, Oct 23–Nov 5 2026 |
  | > +5bp × 3d | 17 | 3.1% | 2018 (2 days), 2019, Oct 2025–Jan 2 2026 |
  | > +10bp × 3d | 8 | 0.7% | 2019 and late-2025 peaks |

  Percentiles: full history p90 = +4, p95 = +7, p99 = +18bp; IORB era p90 = 0, p95 = +3, p99 = +12bp.
  **Decision (2026-11-13): > +5bp on ≥ 3 consecutive business days** (provisional). Fires only in 2019 and the late-2025 pressure, never 2020–2024. A percentile was rejected because the IOER and IORB eras have different normal levels. Replaying the shipped function over the full history reproduces the 66 flagged days (3.1%).
- **Acceptance:**
  - Tool returns spread, both observation dates, and the flag.
  - 3d/7d deltas available via `get_series_deltas` (`SOFR_IORB_SPREAD_BPS`, already bps).
  - Missing data returns `null`, never 0.
  - `red_count` / `wave_authorized` unchanged.
- **Depends on:** E9

## E2 — Bond volatility (MOVE) + divergence flag · Priority 2 · Status: agreed, not built

- **Touches:** ingestion; `data_points`; `get_context_indicators`; `divergence_flags`
- **Data — Decision:** the watchlist feed (Massive grouped-daily) carries no indexes. Pull `^MOVE` through the existing Yahoo module (`yahoo.ts`), **optional and non-fatal** (log a warning, return null). Update the "Investigated and rejected" MOVE entry in `crash-check-rules.md` in the same change, and state the accepted risk there: VIX depends on the same unofficial Yahoo endpoint, so a Yahoo break takes out both.
- **Behavior:**
  - Ingest MOVE daily (plus history via the Yahoo backfill).
  - Add a `move_spike_vix_calm` entry to `divergence_flags` using the existing schema (`pair`, `series_a`, `series_b`, `diverging`, `detail`).
- **Provisional thresholds:**
  - Elevated > 130; stress > 160.
  - **Decision — divergence, absolute deltas to match the schema:** MOVE 7d change ≥ +15pts while VIX 7d change < +3pts (reuses the existing VIX convention). Check against the backfill the same way as E1 before shipping.
- **Acceptance:**
  - MOVE value + 3d/7d deltas returned.
  - New divergence flag appears in `get_indicator_panel` / `get_latest_snapshot` output in the same format as existing flags.
  - `red_count` unchanged.
- **Depends on:** E9

## E3 — Fiscal-event trigger (Treasury quarterly refunding) · Priority 3 · Status: agreed, not built

- **Touches:** `economicCalendar.ts`; `get_trigger_status`; `write_snapshot` server-side trigger dedupe; `project-instructions.md` steps 2 and 11
- **Data:** Treasury quarterly refunding announcement dates from Treasury's official schedule — never guessed.
- **Behavior:**
  - Add `fiscal_event_trigger` to `get_trigger_status` with `current_target_date`, `current_target_label`, `calendar_needs_update` — mirror `fed_event_trigger`.
  - Register `Fiscal-event trigger` as a canonical prefix in `write_snapshot` dedupe.
  - Force status `fired` once its date passes, same as the Fed/inflation triggers. **Decision:** dedupe and forced status are two separate edits.
  - The `note` field holds analyst judgment: coupon sizes, buyback scale, yield-targeting statements.
- **Acceptance:**
  - `get_trigger_status` returns the next refunding date from the calendar.
  - `calendar_needs_update` is true **only once the last known date has passed**. Treasury usually announces just the next date, so a roughly quarterly flip is the reminder working as intended.
  - `write_snapshot` keeps only the latest fiscal entry.
  - Instructions updated so date/label are copied from the tool, not recalled.
- **Depends on:** E9

## E5 — AI single-name credit check (manual) · Priority 4 · Status: agreed, not built

- **Touches:** `crash-check-rules.md` (Type D section); `project-instructions.md` step 6
- **Data:** manual research each run (CDS data is paywalled). Baseline 2026-11-06: NVDA ~139bp, ORCL ~298bp, CRWV ~1,155bp. **Decision:** record tenor and source with each baseline (5Y senior, plus where the quote came from).
- **Behavior:** rules-doc change only, no automation.
  - **Decision:** add "AI single-name credit stress" as a **supporting / escalation signal outside the Type D "ALL THREE" test.** It must not change Type D diagnosis logic or the Stage 3 split.
  - Add a step-6 instruction to report the three levels vs baseline.
- **Provisional escalation:** a CoreWeave credit event, or ORCL CDS > 400bp.
- **Acceptance:** `get_rules` returns the new signal under Type D; step 6 text references it; the "ALL THREE" criteria are unchanged.

## E7 — Distance-to-RED view · Priority 5 · Status: agreed, not built

- **Touches:** `rule_engine/src/rules.ts`; new `crash_checks` JSONB column (migration); new read-only tool (e.g. `get_distance_to_red`) or an extension of `get_indicator_panel`; public dashboard section
- **Data:** existing 6-indicator panel + rule-engine band thresholds
- **Decision — mechanism:** export the band constants from `rules.ts`; `rule_engine` writes thresholds and distances into the new `crash_checks` column; the MCP tool and the dashboard both read that column (no duplicated thresholds).
- **Pre-step — Decision:** fix the 10yr AMBER inconsistency first (panel table 4.3% vs "Additional bond-market bands" 4.5%). Make the doc match what `rules.ts` enforces (**4.3%**, `bandTreasury10y`), then flag it to the user to confirm the intended value.
- **Behavior:** deterministic, no judgment. For each numeric indicator return:
  - current value
  - AMBER and RED thresholds — **read from the rule engine, never hardcoded**
  - absolute and % distance to each
  - confirmation days still needed

  Fed pivot signal is shown as a state, not a distance.
- **Acceptance:**
  - Output matches rule-engine thresholds exactly.
  - Dashboard shows one bar per indicator.
  - Tool exposes no probability or narrative (safe to call in steps 1–6).

## E4 — 10Y/30Y auction quality (phase 2 of E3) · Priority 6 · Status: agreed, not built

- **Touches:** ingestion; `get_context_indicators`
- **Data:** Fiscal Data auction results (bid-to-cover, indirect bidder share).
- **Note (found 2026-11-13):** `treasury.ts` already has `fetchTreasuryAuctions`, and `get_context_indicators` already returns `treasury_auction_demand` (bid-to-cover, dealer take-down and indirect share of the latest 2y/5y/10y/30y auctions vs each tenor's previous 6). Check what it already covers before building; E4 may reduce to adding the weak-auction flag.
- **Behavior:**
  - For each 10Y and 30Y auction, store bid-to-cover and indirect share.
  - **Decision:** indirect share = indirect accepted as % of **competitive** accepted (standard convention).
  - Compare each against its trailing 6-auction average, **including reopenings, within the same tenor** (excluding them would stretch the 10Y window to ~18 months).
  - Free when-issued yields aren't available, so these stand in as the tail proxy.
  - Context only.
- **Provisional threshold:** weak auction = bid-to-cover < trailing avg − 0.2 **and** indirect share < trailing avg − 5pts.
- **Acceptance:**
  - Last auction's metrics + vs-average shown.
  - Flags only on weak auctions.
  - `red_count` unchanged.
- **Depends on:** E3

## E6 — Private-credit proxy (BDC ETF) · Priority 7 · Optional · Status: agreed, not built

- **Touches:** ingestion (`massive.ts` `CONTEXT_TICKERS`, not the personal watchlist table); `get_context_indicators`
- **Data:** BIZD (or similar BDC ETF) from Massive.
- **Behavior:** track 7d/30d change as a private-credit stress proxy. Context only.
  - **Decision:** use total return if Massive provides dividend data. If not, use price and note the bias in the output (BIZD's large quarterly distributions push a price-only 30d change toward the threshold when the window spans an ex-date). Lowest priority; don't over-engineer.
- **Provisional threshold:** stress when 30d change ≤ −10%.
- **Acceptance:** value + deltas returned; `red_count` unchanged.
- **Depends on:** E9

## E8 — Event-conditional scenario splits + scoring · Priority 8 · Status: agreed, not built (stays last)

- **Touches:** `write_snapshot` (new optional field); **`crash_checks` migration (Decision: added)**; `get_latest_snapshot`; `project-instructions.md` steps 7–11
- **Data:** analyst judgment, written **after** step 7
- **Behavior:**
  - Optional field (**Decision:** each branch carries a `probability`):
    ```json
    "conditional_scenarios": [
      {"event": "Dec 2026 FOMC", "event_date": "2026-12-09",
       "branches": [{"outcome": "hold", "probability": 0, "bull": 0, "base": 0, "bear": 0, "crash": 0}]}
    ]
    ```
  - **Decision — validation:** per event, branch probabilities sum to 100; each branch's split sums to 100; the probability-weighted branch splits reconcile with the run's unconditional split within ±5pts per scenario.
  - On the first run after `event_date`, record which branch occurred and the actual split change (scoring). **Decision:** "actual split change" = the next full report's committed step-7 split vs the branch split predicted for the outcome that actually happened.
  - Surface only via `get_latest_snapshot` (step 8), **never** via any step 1–6 tool.
- **Provisional limits:** max 3 events per run.
- **Acceptance:**
  - Field persists and validates branch probabilities, branch sums and reconciliation.
  - A scoring entry is written after the event.
  - Anti-anchoring order preserved.

---

## Out of scope for the build (chat workflows)

These are handled in chat, not code:

- Run "401k analysis" to stress-test the dry-powder level against a slow-rotation / financial-repression path.
- Next "run portfolio review": international underweight vs target, VRT's AI-capex exposure, whether a commodities/gold slot belongs in the deployment registry, DBA vs its 2014 high for NTR.
- Treat NVDA's Nov 17 results as the first post-midterm test in the earnings-guidance trigger note.
