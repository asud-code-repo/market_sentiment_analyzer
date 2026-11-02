# 401k Allocation Analysis — Prompt

On-demand deep-dive on the current 401k breakdown. Paste everything below
the line into a Claude Desktop chat inside the crash-check project (the
local `crash-check` MCP server must be running). It's separate from
"run crash check" and "run portfolio review" in
`reference_docs/rules/project-instructions.md`. Those two answer "what
does the macro panel say" and "has anything drifted / is the watchlist in
range". This one answers **"is the current 401k breakdown the right one
for the conditions we're tracking, and what would I change?"**

This file is tracked in a public repo: it must never contain real fund
names, balances, or percentages. All personal data comes from the tools
at run time.

---

Run a **401k allocation analysis** of my current portfolio. Use the
crash-check MCP tools for everything the pipeline tracks, and web search
for fund-level and market information the pipeline doesn't have. Follow
the steps in order.

## Ground rules (apply throughout)

- **Tool output is authoritative.** RED/AMBER/GREEN bands, RED count,
  wave status and authorization, drift classification, watchlist status,
  hazard-model band, and deployment dollar amounts all come from the
  tools. Report them as-is and never re-derive or override them. If a
  field is `null`, say "unavailable", never zero.
- **Rules are fixed and proposals stay separate.** `crash-check-rules.md`
  is the operating policy: wave triggers, dry-powder deployment, the
  universal core, and the crash-type layers. Keep two lists in the
  output: (a) actions that fit inside the current rules, and (b)
  proposals that would *change* the rules. Each proposal needs evidence
  and a stated trade-off. Never present (b) as something to do now.
- **Privacy.** This analysis stays in chat only. Do **not** call
  `write_snapshot`, `write_full_report`, `write_portfolio_review`,
  `write_watchlist`, or `record_wave_deployment`. Dollar figures may
  appear in this chat, but show percentages first, with dollars as
  secondary context.
- **Cite everything external.** Every fund fact (expense ratio, holdings,
  equity/bond split, duration, historical drawdown) needs a source and an
  as-of date. If you can't find a fact, say so. Never fill a gap from
  memory, and never guess what the plan's fund menu contains.
- **Note staleness.** Check `updated_at` / `value_as_of` in the portfolio
  file. If either is more than 30 days old, put a warning at the top that
  the holdings percentages may not match the live account, and ask me to
  confirm or paste current percentages before step 5.

## Step 1 — Pipeline state (tools)

Call these first and keep the results for later steps:

1. `get_indicator_panel`: check `data_freshness.is_fresh` first. If it's
   false, say so and continue, but label every macro read in the output
   "as of <date>". Record the 6-indicator panel, RED count, wave status,
   and `hazard_model_10pct` band.
2. `get_portfolio_snapshot`: all accounts. The focus is the tactical
   401k. The spouse 401k, RRSP, and SIP brokerage are household context.
   Record the dry-powder (stable value) rate, its period, and
   `rate_reset_trigger`.
3. `get_portfolio_drift`: drift per fund and `standing_flags`, as-is.
4. `get_deployment_plan`: what each wave would deploy, and which waves
   are already executed. Cross-reference fund names against step 2.
5. `get_watchlist_status`: BrokerageLink tickers vs. wave targets.
6. `get_context_indicators`: you'll mainly need
   `tips_real_yield_10y_pct`, `breakeven_inflation_10y`, the 2s10s and
   3-month yields, `effective_fed_funds_rate_pct`, the two
   recession-probability models, `sector_rotation`, `market_positioning`,
   `divergence_flags`, `fiscal_dominance_checklist` (including
   `rates_decomposition`), `macro_regime_signals.stock_bond_correlation`,
   gold, and copper.
7. `get_trigger_status`: upcoming Fed and inflation events, and the
   Warsh Fed classification.
8. `get_latest_snapshot`: the latest scenario distribution (bull, base,
   bear, crash), the derived crash probability, and `risk_radar`. Use
   these as the macro regime read. Don't form a new one.
9. Optional: `get_series_deltas` for SP500, VIXCLS, BAMLH0A0HYM2, DGS10
   and the watchlist tickers, if you need recent direction.

## Step 2 — Fund-level research (web)

Find the current fact sheet for **each fund in the tactical 401k**
(names from step 2) and for the spouse 401k's funds. Use the plan
provider's fund page, Morningstar, or the fund family's site. Collect:

- Expense ratio (net), and the share class actually held, if
  identifiable
- Asset mix (US equity / international equity / bonds / cash / other).
  For target-date funds, also the **current equity %** and where the
  fund sits on its glide path.
- US vs. international vs. EM split; top sectors; top 10 holdings and
  their % of the fund; value/blend/growth style; market-cap tilt
- For bond or stable-value funds: duration, credit quality, and the
  current crediting rate or SEC yield
- 1, 3, 5 and 10-year returns vs. category, and **max drawdown in 2008,
  2020 and 2022** (or the nearest available history)

Also search:
- This year's and next year's IRS 401k limits (elective deferral,
  catch-up, total additions), from irs.gov
- One or two current mainstream outlooks (e.g. JPMorgan Guide to the
  Markets, Vanguard or BlackRock capital market assumptions) for
  **10-year expected returns** by asset class. Use them only as a
  reference range, never as a forecast.
- Anything material about the funds themselves: manager change, merger,
  closure, fee change, or the stable-value issuer's credit rating

## Step 3 — Current breakdown and look-through exposure

1. **Breakdown table:** fund | actual % | target % | drift status (from
   the tool) | expense ratio | role (dry powder / core equity / satellite
   / glide path).
2. **Look-through exposure.** Combine each fund's weight with its fact
   sheet to get the *real* exposure of the tactical 401k by asset class
   (equity / bonds / stable value / real assets), by region (US / intl
   developed / EM), by sector (flag any sector over 25% of equity), and
   by style. Pay particular attention to the target-date fund, which
   hides its own international and bond allocation.
3. **Overlap.** Find where funds duplicate each other: the target-date
   fund vs. the standalone international fund, the value fund vs. the
   target-date fund's US sleeve, and BrokerageLink watchlist names vs.
   the SIP positions (e.g. stacked AI-capex or infrastructure exposure).
   Name the largest overlap.
4. **Weighted expense ratio** for the account, current vs. at target.
5. **Household view** (percentages only): equity/bond/cash and
   US/intl/EM across all four accounts, with the 401k's share of each.
   This shows whether 401k decisions are offset or amplified elsewhere,
   e.g. the RRSP's equity weight and the spouse 401k's bond weight.

## Step 4 — Cost of holding dry powder

The tactical 401k deliberately holds a large stable-value sleeve as
wave-gated dry powder. Measure what holding it costs right now:

- Stable-value crediting rate vs. 3-month T-bill, fed funds, 10y
  breakeven, and 10y TIPS real yield. Report the **real yield of the dry
  powder** (crediting rate minus breakeven) and its gap to the TIPS real
  yield. If the rate-reset date is close, say what the rate is likely to
  reset toward, based on the current rate environment and a source.
- **Expected-value framing.** Use the stored scenario distribution and
  the hazard-model band, not your own estimate. Compare (a) the expected
  drag from holding cash while equities rise in the bull/base scenarios
  with (b) the expected benefit of deploying at a wave-trigger drawdown
  in the bear/crash scenarios. Use the step 2 expected-return ranges.
  Show the arithmetic and every assumption, and give a range, not a
  point estimate. This is a sanity check on the current strategy, not a
  new rule.
- How long the dry powder has sat undeployed, and which wave is next
  (from step 1.4).

## Step 5 — Regime fit and stress test

1. **Regime fit.** For each fund, say whether the current regime is a
   tailwind, neutral, or a headwind, with the specific indicator values
   behind it. Draw on the scenario distribution, risk radar, fiscal
   dominance checklist, rates decomposition, stock/bond correlation
   (if it's positive, bonds aren't diversifying), sector rotation,
   positioning, and divergence flags. Don't combine these into a single
   composite score.
2. **Crash-type exposure.** For each crash type in `crash-check-rules.md`
   (A stagflation, B recession, C credit/liquidity, D AI/tech bubble,
   E hybrid), say which current holdings are most exposed and which
   would hold up, and whether the rules' Stage 3 layer for that type
   fits what's actually held today. Flag any type where the current
   breakdown and the planned response point the same way and compound
   the risk.
3. **Stress test.** Apply each fund's actual historical drawdown (step 2)
   to its current weight for 2008-style, 2020-style and 2022-style
   scenarios. Report the estimated account drawdown in %, current vs.
   at target. Then compare with the waves' drawdown triggers: would the
   account hit the waves' entry points with the intended dry powder
   still intact?

## Step 6 — Recommendations

Organize as:

1. **Verdict (one paragraph):** is the current breakdown appropriate for
   current conditions and my stated strategy? Yes / mostly / no, and why.
2. **Within current rules:** concrete actions such as rebalancing drifted
   funds, the next wave's readiness, and fund-level swaps *only* where a
   cheaper or better equivalent is confirmed to exist on the plan menu
   (ask me if you don't know the menu). For each: what, why, the
   evidence, and the trade-off.
3. **Proposals that would change the rules:** e.g. long-term target
   weights, dry-powder size, or how the stable-value sleeve is used.
   Each with evidence, the counterargument, and what data would confirm
   or refute it. These are for discussion, not action.
4. **Spouse 401k:** a one-paragraph status on its structural issue. Use
   the percentage gap to a comparable equity glide path, not a dollar
   figure.
5. **What to watch:** the 2–3 indicators or events from steps 1 and 7
   that would most change this analysis, with the threshold that matters.
6. **Contribution check:** am I on track to max this year's deferral
   limit? Ask me for the YTD contribution if it isn't in the portfolio
   file, and don't guess.

## Output format

Render as an HTML artifact using `portfolio-review-template.html`'s CSS
and component classes. Sections in order: verdict hero → breakdown table
→ look-through exposure bars → dry-powder cost → regime fit and
crash-type matrix → stress test → recommendations (within rules /
proposals, visually distinct) → what to watch → sources (with as-of
dates). Keep the status-color semantics fixed (green/amber/red =
good/warning/critical).

End with the standard disclaimer: informational only, not investment
advice; consult a CFP/RIA, and a cross-border CPA for anything touching
the RRSP or US/Canada tax treatment.
