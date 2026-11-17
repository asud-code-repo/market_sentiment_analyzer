# Hazard Model: Current State and Rebuild Brief

*Prepared 2026-11-15 as the starting brief for a dedicated analysis session.
It merges two earlier discussions and checks them against the code.
Read it alongside `rule_engine/src/hazardModel.ts`,
`reference_docs/hazard-model-explained.md` (plain-language walkthrough),
and the "Statistical Hazard Model (10% Drawdown)" section of
`reference_docs/rules/crash-check-rules.md`. Where this brief and the code
disagree, the code wins.*

**Status: design decided 2026-11-16 (section 10); nothing built yet.**
Section 7 lists the decisions still open. Settle those with the maintainer
before writing code.

---

## In plain language

### The problem

The system has a "crash warning" score. When we tested it honestly
(a replay over 1994–2026, section 4), three problems showed up:
- **It mostly warns after the market has already started falling.** On
  sudden crashes it warned only 2–4 trading days ahead.
- **Its percentages are exaggerated.** When it says "93% chance," the real
  historical rate is about 54%.
- **Nobody can check how it was built.** The original code was lost, and
  only the final numbers survived.

### What we're going to do

1. **Start keeping score.** From now on, record every day whether the
   warning turned out right, next to a simple "how far has the market
   fallen and how jumpy is it" rule. Over time this shows whether the model
   actually beats the simple rule. It's cheap, and it never stops gathering
   evidence.
2. **Rebuild the model properly in a separate, private workshop.** That's a
   new private Python repo where models are designed and tested. The
   rebuild will:
   - use only the information that was available at the time, with no
     hindsight;
   - be tested the honest way: trained on the past, tested on the future;
   - keep every piece of code and every result saved, so nothing gets lost
     again.
3. **Ask more useful questions.** Instead of "will we hit −10%?", focus on:
   - **"Once a fall has started, will it get worse?"** This is what the
     buying plan actually needs.
   - **"How bad could it get?"** This is the method central banks use.
4. **Add a "jumpiness" forecast.** Big daily swings tend to come in
   clusters, which makes them predictable even when direction isn't. When
   the forecast says JUMPY, purchases are split over several days instead
   of made all at once. The number of days stays in the private settings.
5. **Only expand if it works.** Other countries' stock markets would give
   many more crash examples to learn from. We'll add them only if the US
   version shows real promise.

### How it fits together

- **The private workshop** builds and tests models, and hands over a small
  finished "recipe" file.
- **The existing system** uses that recipe every day, exactly as it works
  now.
- **Personal rules** stay on the laptop, as they do today.

### What we decided against

- **Kubernetes or a big ML setup.** There's nothing for it to scale: one
  score a day, and very little data.
- **A model that retrains itself automatically.** Big crashes happen about
  once a year, so there's almost nothing new to learn from week to week.
- **Fancy AI forecasting models.** They would likely have already "seen"
  the history we'd test them on, so a good result would mean nothing.

### Ground rules

- **Agree the pass/fail test before seeing results.** If the new model
  doesn't beat the simple rule, we replace it with the simple rule. That
  counts as success.
- **Keep nothing important only on the laptop.** Code, results and data
  copies all live in the cloud.
- **Total cost: $0.**

### Realistic expectations

The win is a warning you can **trust**: honest numbers, a known lead time,
and fully repeatable. Don't expect one that predicts crashes much better;
no one can do that reliably. Sudden shocks like COVID stay unpredictable.

---

## 1. What the model is today

**Question it answers:** "If the S&P is not already 10% or more below its
all-time high, what's the chance it reaches a ≥10% drawdown within the next
21 trading days?"

**Type:** a logistic regression with 32 features, then isotonic
calibration, then a 3-level band. The coefficients were fitted once,
offline, around 2026-08-26, and hand-ported into TypeScript as frozen
constants. Nothing retrains at runtime.

**Where it runs:** `rule_engine/src/classify.ts` calls it once a day,
Mon–Sat, inside the `ingest-then-classify` GitHub Action. It reads only
from Supabase `data_points` and never calls FRED directly.

**Eligibility gate (`classify.ts`, around line 132):**
- If the live drawdown is ≥10%, it records `ALREADY_BREACHED` and leaves
  the scores null, because the target has no meaning past the threshold.
- Otherwise it calls `gatherHazardFeatures()` and then
  `computeHazardProbability()`, wrapped in a try/catch.
- Any missing input series records `UNAVAILABLE` (null fields). This never
  blocks the core 6-indicator panel.

**Stored on `crash_checks`:**
- `hazard_10pct_raw_pct`
- `hazard_10pct_calibrated_pct`
- `hazard_10pct_band`
- `hazard_10pct_as_of`

**Shown in:**
- the `get_indicator_panel` MCP tool, field `hazard_model_10pct`, which
  includes `historical_hit_rate_pct`;
- the public dashboard's "Statistical Hazard Model" card.

Both show the band plus its **measured** hit rate (3 / 16 / 54%), not the
calibrated percentage. That change was made 2026-11-09.

**What it is deliberately NOT used for:**
- It is not one of the six inputs to the 3-of-6 stress gate.
- It is not an input to wave triggers. Those are evaluated locally from
  drawdown, VIX and `sp500_days_since_252d_low` by
  `mcp_server/src/lib/waveEvaluation.ts`, using private local policy.
- It is not an input to `write_snapshot` synthesis.
- It is never blended with `crash_probability_pct`, which is LLM judgment.

In short: **it is purely advisory today.**

---

## 2. How a score is calculated (`hazardModel.ts`)

1. **Gather 32 raw values.** That's 18 base inputs (16 FRED series plus
   two derived values) and 14 changes over 5 and 20 trading days.
   - The 5 and 20 trading-day anchor dates come from
     `getTradingDayAnchor()`, which counts back rows in `SP500`.
   - VIX, DGS10, Sahm and drawdown are passed in from `classify.ts`.
   - Everything else is read with `getLatestDataPoint()`, the latest
     available row.
2. **Standardize** each value: `z = (x − scaler_mean) / scaler_scale`.
   The means and scales are frozen from the training period.
3. **Combine:** `logit = −2.557114 + Σ zᵢ·coefᵢ`.
4. **Sigmoid:** `raw = 1 / (1 + e^(−logit))`.
5. **Calibrate:** linear interpolation through an 18-point isotonic table.
   - The table has two wide flat plateaus: raw scores up to ~0.15 map to
     ~22–24%, and raw 0.257–0.826 maps to **92.7%**.
   - Almost all the differentiation is in raw scores between 0.15 and 0.26.
6. **Band** the calibrated value: **LOW** <35%, **TRANSITIONING** 35–90%,
   **HIGH** ≥90%.

**Sign convention:** `rules.ts` `drawdownPct()` is positive for a decline,
but the model was trained on negative values. `hazardModel.ts` negates it.
Any rebuild must keep its convention explicit.

**Realized volatility:** sample standard deviation (ddof=1) of the last 20
daily log returns of `SP500`, × √252 × 100.

### The 32 features, with frozen values

"Kind" says whether the input is stationary (fluctuates around a stable
mean, which is fine) or a **level that trends over decades** (a defect).

| Feature | Mean | Scale | Coef | Kind |
|---|---|---|---|---|
| drawdown_pct (negative = below ATH) | −2.71 | 2.75 | **−0.795** | stationary; the dominant term |
| BAA10Y (Baa − 10y spread) | 2.04 | 0.48 | +0.439 | stationary |
| curve_2s10s | 0.66 | 0.70 | −0.392 | stationary |
| NFCI_d5 | 0.001 | 0.018 | +0.325 | change |
| RECPROUSM156N | 0.57 | 3.79 | +0.306 | **leaky** (revised with hindsight) |
| DRTSCILM | 1.26 | 16.98 | −0.267 | stationary |
| spy_realized_vol_20d | 13.36 | 5.92 | +0.239 | stationary |
| DGS10_d20 | 0.014 | 0.221 | +0.233 | change |
| NFCI | −0.52 | 0.21 | +0.203 | stationary |
| STLFSI4 | −0.27 | 0.43 | −0.193 | stationary |
| curve_2s10s_d20 | −0.006 | 0.132 | −0.183 | change |
| BAA10Y_d20 | −0.014 | 0.122 | +0.175 | change |
| DGS10 | 3.95 | 1.94 | −0.170 | **level / regime** |
| STLFSI4_d20 | −0.008 | 0.280 | −0.139 | change |
| DRCCLACBS | 3.18 | 0.99 | +0.106 | slow-moving level |
| drawdown_pct_d20 | 0.26 | 2.88 | −0.094 | change |
| DGS10_d5 | 0.003 | 0.112 | +0.091 | change |
| NFCI_d20 | 0.002 | 0.065 | −0.082 | change |
| SAHMREALTIME | 0.22 | 1.06 | +0.080 | stationary |
| DCOILWTICO | 52.60 | 27.84 | +0.075 | **nominal level** |
| UNRATE | 5.01 | 1.20 | −0.068 | **level / regime** |
| ICSA | 316,260 | 149,882 | −0.067 | **level** (grows with the labour force) |
| VIXCLS | 17.30 | 5.05 | +0.064 | stationary |
| VIXCLS_d20 | −0.12 | 4.07 | −0.064 | change |
| STLFSI4_d5 | −0.003 | 0.182 | +0.059 | change |
| CCSA | 2,558,824 | 1,796,969 | +0.052 | **level** |
| drawdown_pct_d5 | 0.07 | 1.68 | −0.045 | change |
| VIXCLS_d5 | −0.03 | 2.68 | +0.035 | change |
| CPIAUCSL | 226.5 | 55.6 | +0.031 | **nominal index level** (~320 today) |
| RSAFS | 422,335 | 172,833 | −0.018 | **nominal level** |
| curve_2s10s_d5 | −0.002 | 0.066 | +0.011 | change |
| BAA10Y_d5 | −0.003 | 0.055 | −0.003 | change |

Things that stand out:
- VIX itself carries little weight (+0.06). Volatility enters mostly
  through realized volatility and drawdown.
- Several coefficients are noise-sized (CPI, RSAFS, BAA10Y_d5,
  curve_2s10s_d5).
- Some signs are hard to interpret: STLFSI4 is negative while NFCI is
  positive, and ICSA is negative. That's a typical symptom of correlated
  inputs in an over-parameterized model.

---

## 3. Where the model came from (provenance)

The original research claimed:
- walk-forward validation with an expanding window;
- leave-one-crisis-out across dot-com, the GFC, Dec 2018, COVID and 2022;
- isotonic recalibration (5-fold, stratified, on pooled out-of-sample
  predictions);
- an episode-level block bootstrap showing a real edge over the base rate;
- a companion 20% target that was shelved because its interval spanned
  zero (only 4 episodes).

**None of this can be verified** (confirmed 2026-09-19). The training code,
label and fold definitions, bootstrap output and artifact manifest are all
gone. They lived in an earlier session's scratchpad and were never committed.

> **Lesson for this rebuild: all research code goes in the private
> research repo (section 7) and gets committed as it is written. It must
> not live in a scratchpad.**

### What happens to the lost history

**Decision: don't try to reconstruct the original experiment.** A search on
2026-11-15 found nothing more: no artifact JSON, training code or bootstrap
output anywhere in the repo or the surviving scratchpads. Only the frozen
coefficients in `hazardModel.ts` and the two migrations survive. Fitted
coefficients can't be turned back into the training run that produced
them. Guessing at the lost code would only produce a new, unverified
experiment labelled as the old one.

What *can* be recovered, and how:

| Lost or at risk | What we do instead |
|---|---|
| Training code, folds, bootstrap | Not recovered. **Variant A** (same 18-input spec, same target, refit walk-forward in the new harness) is the honest stand-in. It tests the original's *claims*, not its exact run. |
| Whether the frozen coefficients were sound | Sanity check: compare Variant A's full-period coefficients to the frozen ones. Similar signs and sizes suggest the original was fitted roughly as described; large differences are a finding in their own right. |
| The 20% companion target ("shelved, CI spanned zero") | Rerun cheaply in the new harness as a side output. Expect the same answer, since the episode count hasn't changed. |
| The Nov 9 replay (scripts plus cached data, in a temp folder) | **Copy into the research repo first**, before any cleanup. It's the only surviving evaluation code. |
| Daily frozen-model scores 1994–2026 | Regenerate from the rescued replay and commit the output as a fixed record of the old model, so later variants can be compared day by day. |
| Live production scores since 2026-08-26 | Already safe in `crash_checks`. Stage 0 scores them as outcomes resolve. |

When the rebuild finishes, update the "Statistical Hazard Model" section
of `crash-check-rules.md`. Replace the "as originally claimed" paragraphs
with the new, reproducible results and a link to the research repo's
commit. Keep the history of what was claimed in a short note.

---

## 4. Measured performance: the 2026-11-09 in-sample replay

**Method:** the frozen model was replayed over 5,058 scorable days from
1994-02 to 2026-10.
- Data: Supabase `data_points`, plus Yahoo `^GSPC` for S&P history,
  because Supabase `SP500` only starts 2016-08.
- Label: 1 if the drawdown reaches ≥10% on any of the next 21 trading
  days. Days already at ≥10% are excluded.
- Base rate: **11.8%**.

**Caveats that flatter the results:**
- It's in-sample: the model was fitted on this same history.
- It uses latest-revised values, not what was published at the time.
- Lookups are by observation date with no release lag. For monthly series
  (CPI, RSAFS, UNRATE, DRCCLACBS) that's look-ahead of weeks.

| Measure | Result |
|---|---|
| AUC | **0.889** model; 0.825 drawdown only; 0.834 drawdown + VIX |
| LOW band | claims ~24%, actual **3.3%** |
| TRANSITIONING band | claims ~60%, actual **16%** |
| HIGH band | claims ~93%, actual **54%** (about 4.6× the base rate) |
| HIGH as an alert | 54% precision / 66% recall, vs 38% / 68% for "drawdown ≥5%" |
| False alarms | 32 of 65 HIGH stretches |
| Episodes caught | 20 of 21 ≥10% episodes flagged beforehand |
| Lead time on sudden crashes | only **2–4 trading days** (2015, Feb 2018, 2020, 2025) |

**Replay code:** `analyze.mjs`, `load.mjs`, `gspc.mjs` and others,
including cached `series.json` and `gspc.json`, sit in a local temp folder on the maintainer's laptop (a Claude Code
session scratchpad, `...\scratchpad\hz\`; the full path is kept off this
public repo).
- It's at risk of cleanup, so copy it into the research repo first.
- It **only scores** the frozen coefficients; it has no fitting code.
- It's reusable for data loading, labels and metrics, not for training.

---

## 5. Diagnosed defects (why it behaves this way)

1. **The target rewards being close, not seeing ahead.** "Touches −10%
   within 21 days" is nearly satisfied once you're at −8%. So current
   drawdown dominates (−0.80), and the model mostly flags markets that are
   already falling. Adding features can't fix this; only a different
   target can.
2. **Inputs that trend over decades.** 7 of the 18 base inputs are raw
   levels: CPIAUCSL, RSAFS, CCSA, ICSA, UNRATE, DGS10, DCOILWTICO.
   Today's values sit far outside the training distribution (CPI reads
   about +1.7 standard deviations). Levels like these teach the model
   about eras, not stress.
3. **Overfitting.** 32 parameters against about 21 independent episodes.
   Daily rows inside one episode share a label (~20 overlapping days), so
   the effective sample is tiny.
4. **Leakage.** `RECPROUSM156N` is revised with hindsight (its producer's
   FAQ says so) and carries the 4th-largest weight. Because coefficients
   are fitted jointly, it **can't be fixed by deleting the line**; it needs
   a refit.
5. **The calibration overfit.** Isotonic regression on few positive
   examples produced wide plateaus (any raw score above 0.26 becomes 93%).
6. **Can't be reproduced.** See section 3.
7. **Not point-in-time.** Revised values, and no release lags.

---

## 6. Recommendations (consolidated, in order)

### Stage 0: score it live (cheap, permanent, do it regardless)

Every day's band is already stored. Add automatic scoring as each 21-day
outcome resolves, the same way the event-conditional (E8) scenarios are
scored.

**Also store and score a simple baseline band each day**, such as
drawdown + VIX. Otherwise the live record shows hit rates but not whether
the model beats the simple option. Store the raw score and a snapshot of
the inputs too, so the record stays readable if the model changes.

This is the only truly out-of-sample evidence available. It builds slowly
(roughly one 10% episode a year) but never stops. About one session of
work, in `rule_engine/`.

### Stage 1: make it measurable (needed before any refit)

- A **reproducible training and evaluation script** in the private
  research repo, committed.
- **Write the input-building code as functions that can score a single
  day**, not only rebuild history. That keeps the later runtime choice open
  (section 7).
- **Point-in-time data.** FRED's standard `series/observations` endpoint
  takes `realtime_start`, `realtime_end` and `vintage_dates` (ALFRED), on
  the same free key. Apply each series' real release lag.
  - VIX and S&P aren't revised.
  - Claims, payrolls, retail sales and CPI are.
  - Some vintages are patchy before the 1990s.
- **Validation:** walk-forward with a gap the length of the horizon
  around each test block. With about 21 episodes, leave-one-crisis-out
  (with gaps) is probably the practical choice. If used, label it
  honestly, since it trains on later crises. Fit any scaling inside each
  fold.
- **Baselines:** base rate, drawdown only, drawdown + VIX, and
  drawdown + VIX + credit (BAA10Y).
- **Metrics:** AUC; precision and recall when HIGH; a calibration table
  with a minimum count per bin; lead time (trading days from the first
  HIGH to the start of the drawdown); false-alarm count. Every metric gets
  an **episode-level bootstrap interval**.
- **Important:** the frozen model can't be tested out of sample. It was
  fitted on the full period. The honest estimate for "today's model" is to
  **refit the same 18-input spec walk-forward**. Expect it to score below
  0.889.

### Stage 2: fix the known defects and refit

- Drop `RECPROUSM156N`.
- Replace levels with changes or z-scores: CPI year-on-year, claims vs
  their 52-week average, oil year-on-year, retail sales year-on-year in
  real terms, unemployment change (Sahm already covers it), and the curve
  in place of the 10Y level.
- Cut to about **6–8 inputs**, with regularization (L1/L2).
- **Use the ready-made stress composites rather than many raw stress
  series.** NFCI is already a factor model built from 105 financial series,
  and STLFSI4 one built from 18. Collapsing correlated inputs into one or
  two factors directly addresses the overfitting problem, and the Fed has
  already done that work. Building custom factors (for example PCA over
  stress series) is a later option. If tried, estimate them **within each
  training window**, or the factors quietly use future data.
- Recalibrate **only on out-of-sample predictions**, with a minimum count
  per bin. Or skip the probability entirely and report each band's
  empirical hit rate, recomputed walk-forward.

### Stage 3: change the question (the real lever)

There are two candidate questions, and they serve different decisions:

**(a) "Will an existing decline deepen?"** Given the market is already down
about 5%, what's the chance it reaches 10%, 15% or 20%?
- This fits **wave deployment**, which acts after a decline has started.
- It could also close the open backlog item on whether the Wave 2/3
  trigger levels are calibrated.
- It accepts that the model is late, rather than fighting it.
- Since 1994 there are perhaps 50–60 declines of 5% or more, about 21 of
  which reached 10%. That's more positive days, but still a small number
  of independent events.
- **Build the transparent baseline first:** a table of how often a 5%
  decline went on to 10%, 15% or 20%, split by VIX level and credit-spread
  trend. Any model must beat this table, and the table may be enough on
  its own.

**(b) "Will a fresh fall start?"** A further 10% fall from today's level,
or a 10% drawdown that starts while the market is still near its high.
- This is true early warning.
- It has a lower base rate and is notoriously hard to beat chance on.
  **Expect a negative or marginal result.**
- Only worth pursuing if an earlier warning would actually trigger an
  action.

**Horizon:** test 21 and 63 trading days side by side. Macro data tends to
predict better over about 3 months; precision falls as the horizon
lengthens.

### Stage 4: better inputs (only if Stage 3 shows a real edge)

- **Excess Bond Premium** (Gilchrist–Zakrajšek, Fed Board, monthly, from
  1973). The best-documented free candidate. **Caveat:** it's
  re-estimated from scratch each release, so its history isn't
  point-in-time. It has the same kind of look-ahead as `RECPROUSM156N`
  and is published with a lag, so treat any result as optimistic.
- Other candidates:
  - VIX term-structure inversion;
  - market breadth;
  - funding stress;
  - credit-spread *changes*.

  Many of these have short histories: HY OAS in Supabase only starts
  2023-07, and SOFR starts 2018. BAA10Y goes back to 1986 and is already
  used.
- **The project's rule applies:** every new input must show forward edge
  in the backtest. A positioning idea (VIX inversion / SPY flows) has
  already failed that test (2026-10-30).
- **CBOE SKEW** (free, daily since 1990). Unlike Kalshi it *can* be
  backtested, so it's a cheap Stage 4 test. Published evidence on it as a
  crash predictor is weak; expect it to fail and stay context only.
- **Prediction markets (Kalshi; Polymarket is already ingested): context
  only, never a model input.**
  - Useful as a live outside comparison: what the market prices for
    contracts like "S&P below X by date."
  - Contract histories are short (Kalshi from about 2021), with no crisis to
    test against, so they can't pass the backtest rule. Same status as the
    CDS idea.

### Proposed scoped experiment (the agreed next step, pending decisions)

Fit and evaluate on identical data, out of sample:

| Variant | Description |
|---|---|
| A | The current 18-input spec, refit walk-forward (honest estimate of today's model) |
| B | Stationary inputs, `RECPROUSM156N` dropped, about 8 inputs, regularized |
| C | B plus Excess Bond Premium |
| D | Question (a) "already down 5%", against the empirical-table baseline |
| E | **Quantile regression ("growth-at-risk")**: tail forecasts (5th and 10th percentile) of 21- and 63-day forward S&P returns, from B's stationary inputs |
| F | *Optional:* a regularized gradient-boosted classifier on B's inputs. A single check on whether a nonlinear model helps; expected to overfit. |
| G | **Volatility forecast (HAR)** for purchase pacing. A separate output, not a crash predictor; see "Volatility forecast for purchase pacing" below. Also tested as an input to B, D and E. |

Compare each against the baselines on ranking (AUC), precision when HIGH,
calibration, and lead time, all with bootstrap intervals.

**About Variant E.** Instead of "will we hit −10%? yes or no," it predicts
the bad tail of future returns directly: "given today's conditions, the
worst-5% outcome over the next 63 days is −14%." This is the standard
Fed/IMF/BIS approach (Adrian, Boyarchenko and Giannone, "Vulnerable
Growth", *AER* 2019).
- **Why it fits:**
  - It learns from the whole return distribution every day, not mainly
    from the ~21 positive episodes. That gets more out of the same history.
    Overlapping windows still limit the true sample, so this improves
    efficiency without fixing the shortage of episodes.
  - It answers both Stage 3 questions: how bad things could get from here
    covers (a), and the conditional tail covers (b).
  - It's linear, with frozen coefficients and the same answer every run, so
    it suits the Option 1 model file.
  - Its central finding is well established: loose financial conditions
    mean a calm centre but a fatter left tail.
- **How to judge it:**
  - Quantile loss, against two baselines: the historical (unconditional)
    quantile, and a quantile regression on drawdown + VIX alone.
  - Coverage: realized returns should fall below the 5% forecast about 5%
    of the time, out of sample.
  - For direct comparison with A–D, convert the forecast tail into a
    P(≤ −10%), or flag days whose 5% quantile is below −10%. Score those
    with the same AUC, precision and lead-time metrics.
- **Watch for:** separately fitted quantiles can cross (the 5% forecast
  coming out above the 10%). Sort them or fit them jointly. Fit only on
  stationary inputs, the same as B.

### Exit criterion (agree before seeing results)

**Confirmed 2026-11-17, before any model was fitted.** The exact rules,
including how each comparison is measured, are frozen in the research repo
at `experiments/exit_criterion.json`; that file wins over this summary.
Also decided then for question (a): reaching 10% is tested within 21 and 63
trading days, but 15% and 20% are tested as "reached before the market
recovers to within 2% of its high", with no fixed window. Since 1990 only 4
of 50 five-percent declines reached 20%, and only 1 within 63 days.

As agreed:
- **Keep a model** only if the 90% bootstrap interval (resampling whole
  episodes) for its out-of-sample AUC advantage over drawdown + VIX lies
  entirely above zero.
- **Or keep it** if it gives at least 5 more trading days of median lead
  time at no worse precision.
- **For Variant E:** keep it only if its out-of-sample quantile loss beats
  the drawdown + VIX quantile baseline, with a bootstrap interval that
  excludes zero, **and** its 5% coverage is within 3–8%.
- **Otherwise**, replace it with a transparent drawdown + VIX + credit
  score (or the empirical table, for question (a)), keep scoring it live,
  and retire the logistic model.

That counts as a successful outcome.

### Refinements from the 2026-11-16 review (what institutions do)

Big institutions mostly don't try to time crashes. They forecast
volatility, run stress scenarios, estimate downside (growth-at-risk) and
use valuation for long horizons. Checked against this project:

- **The model to beat is drawdown + volatility.** Our own rejected tests
  (VIX inversion, ETF flows, CTA trend estimates) all failed the same way:
  nothing added much once current drawdown and volatility were known.
  Every candidate input must show what it adds **on top of** drawdown +
  volatility, not on its own.
- **Main line of work: question (a) plus Variant E.** "Will an existing
  decline deepen" and "how bad could the downside get" are the questions
  the data can answer. The current target becomes a comparison.
- **More episodes from other countries (gated; see scope below).**
  - Pool 20–40 national indexes for question (a), using **price-only
    inputs** (drawdown, realized volatility, momentum). Those can be
    computed anywhere; macro and stress indexes aren't comparable across
    countries.
  - Crashes are correlated across countries: 2008 in 30 markets is mostly
    one event. **Resample by calendar period, not by country,** or the
    confidence intervals will be far too narrow.
  - Free daily histories (Yahoo, Stooq) mostly start in the 1980s–90s,
    with gaps. Adds regimes the US lacks: Japan 1990–2003, Asia 1997, the
    euro crisis.
  - Success means beating a US-only model **on US data**. The pooled fit
    can also act as a prior to rein in the US model.
- **Shiller's monthly US data (1871 onward): a cross-check only, not
  training data.**
  - Each month's price is the **average of daily closes**, not the
    month-end close. That smooths drawdowns and understates depth, which
    matters directly for a 10% target.
  - Most current inputs don't exist that far back (BAA starts 1919; no VIX
    or NFCI).
  - Pre-1950 markets were a different regime: the gold standard, and no Fed
    before 1913.
  - Best use: a monthly version of question (a)'s deepening table,
    cross-checked against the daily US table.
- **Valuation (CAPE, equity risk premium): a separate dashboard project,
  out of scope here.** It predicts 5–10 year returns and possibly how deep
  a fall gets, not when. It fills the valuation gap flagged in the
  2026-11-14 external-dashboard review.

**Scope gate.** This is a research programme for one maintainer, so expand
only on evidence:
1. US harness plus Stage 0.
2. Variants A–G on US data.
3. Go international **only if** question (a) shows a real out-of-sample
   edge worth enlarging.

### Volatility forecast for purchase pacing (Variant G)

**Outcome 2026-11-17: built, tested, not shipped.** In the research repo,
HAR did not clearly beat VIX at 21 days, so the band became two VIX cutoffs
(JUMPY at about 20, close to the panel's existing VIX AMBER line). The
pacing backtest then found the band JUMPY on every historical wave-trigger
day, so it adds nothing to pacing, and splitting a wave purchase over 3–10
days was not cheaper on average and did not narrow the range of outcomes.
Nothing was added to `crash_checks`. The rest of this section is the
original plan, kept for the record.

**Decided 2026-11-16: the maintainer would split purchases over several
days when markets are very jumpy.** This forecast is built to inform that
decision. It is not a crash predictor or a buy signal, and it never
decides *whether* to deploy. Wave triggers still do that.

**Why it's worth building.** Volatility clusters and is genuinely
predictable a few weeks ahead, unlike direction. When the forecast says
daily swings will be large, the price could easily sit 5% lower or higher
a few days later. Spreading one purchase over several days gives an
average price instead of one lucky or unlucky day.

**The model.** HAR-RV (Corsi 2009): next-period realized volatility
regressed on realized volatility over the last 1, 5 and 22 trading days,
optionally plus VIX.
- Linear, few parameters, frozen coefficients, same answer every run.
  Easy to port (Option 1).
- Forecast horizons: 5 and 21 trading days.

**Output.** A forecast of 21-day annualized volatility, plus a band based
on historical percentiles: **CALM / NORMAL / JUMPY**. The band cutoffs are
set from out-of-sample history in the research repo and published in the
model file.

**How to judge it:**
- Out-of-sample forecast error (QLIKE and MSE on realized variance)
  against two simple baselines: current 20-day realized volatility, and
  VIX (which runs above realized volatility because of a fear premium).
- Band accuracy: how often a JUMPY forecast was followed by realized
  volatility in the top band.
- **Expect a modest win over VIX at 21 days** and a clearer one at 5 days.
  If it can't beat VIX, publish a VIX-based band instead. That still serves
  the pacing decision.

**Pacing backtest.** On past declines that would have triggered a wave,
compare buying everything on the trigger day with splitting over N days
when the band is JUMPY. Measure how widely the average price varies and
the average cost difference.
- **Honest expectation:** splitting mainly **reduces how much the result
  depends on one day's luck**. It doesn't reliably improve the average
  price.
  - When a decline keeps going, splitting helps.
  - When a sharp rebound follows the trigger day, splitting costs a little.
- The backtest says which happened more often historically. Report both.

**Where it lives (respects the public/private split):**
- **Public:** the forecast and band are market information. Compute them
  in `rule_engine` from the model file and store them on `crash_checks`
  (for example `vol_forecast_21d`, `vol_band`). Show them in
  `get_indicator_panel`, and on the dashboard if wanted.
- **Private:** the pacing *rule* (how many days to split over, per band)
  is personal policy. It goes in `local_state/policy.yaml`, with a generic
  example in `policy.example.yaml`. It's applied locally by
  `mcp_server/src/lib/waveDeployment.ts` / `get_deployment_plan`, the same
  way wave triggers are evaluated locally. The pacing backtest runs in the
  private research repo. Nothing about pacing goes in public tables or
  committed files.
- Volatility is a lagging-but-persistent signal: it rises **after** the
  first down days. That suits pacing, which happens after a wave has
  triggered, not early warning.

### Honest expectations

- The realistic gain is a model you can **trust**: no leakage,
  reproducible, honestly calibrated, with a known lead time. Not one that
  predicts much better.
- With about 21 episodes, HIGH being right about 50–60% of the time is
  near the ceiling for any model.
- No data source predicts sudden shocks like COVID.

---

## 7. Open decisions for the maintainer

1. **Goal:** is "will an existing decline deepen" (question a, for wave
   deployment) the main target? If yes, the current target becomes a
   secondary comparison.
2. **Early warning:** would an earlier warning actually trigger any action
   (a readiness flag, a push alert)? If not, skip question (b).
3. **Horizon:** 63 trading days, or 21 and 63 side by side?
4. **Exit criterion:** confirm or adjust the thresholds above.
5. **Runtime handoff (decided 2026-11-15: choose after the experiment).**
   See "Decided: where the research lives" below.
6. **If a new model ships:** does it stay advisory, or does it feed wave
   evaluation? Feeding waves touches private policy (see constraints).
7. **Purchase pacing (decided 2026-11-16: yes).** The maintainer would
   split purchases when markets are jumpy, so Variant G is in scope.
   Still open: the number of days per band. That's a private policy value
   for `local_state/policy.yaml`, informed by the pacing backtest.
8. **International expansion:** gated on the US results (see "Scope gate"
   in section 6).

### Decided: where the research lives

**A separate, private Python repo** (Python + scikit-learn, versions pinned
with a lockfile). Reasons:
- It can read the real wave trigger levels directly, which question (a)
  needs, without the public-repo workarounds.
- It keeps the Python toolchain out of a repo that is otherwise four Node
  packages.
- Research can be messy (notebooks, cached data, failed variants) without
  cluttering the public engine.

The full design (layout, data flow, tracking, durability, cost) is in
section 10.

### Open until the experiment finishes: how results reach this system

| Option | How it works | Best when |
|---|---|---|
| **1. Model file** | The research repo publishes a versioned `hazard_model_vN.json`: inputs, transforms, coefficients, bands and hit rates, a validation summary, and sample inputs with expected scores. `hazardModel.ts` reads it, and a `node:test` case checks the samples. The daily run stays in TypeScript. | A small linear model with simple inputs. Rebuilding the inputs in TypeScript is cheap, and there's one runtime. |
| **2. Python scores daily** | A pinned Python job in the research repo (GitHub Actions, scheduled after ingestion) scores each day and writes to its **own** `hazard_scores` table, never to `crash_checks`. `rule_engine` stops computing hazard; the MCP and dashboard readers switch to the new table. | Complex point-in-time inputs or a nonlinear model. **One implementation beats a parity test.** This project already had a research-to-production mismatch (the 7/28 calendar-day deltas) and a sign-convention trap. |
| **Neither** | Retire the model for a transparent drawdown + VIX + credit score, or the empirical table. A few lines in `rule_engine`. | The experiment shows no out-of-sample edge. |

If Option 2 is chosen, it needs:
- a migration for `hazard_scores`;
- a staleness flag (the MCP tool flags a score older than 2 trading days);
- its own private-terms check, because `write_snapshot`'s guard doesn't
  cover this path. Anything that depends on private policy goes to a
  private table, never a public one.
- the Supabase service key as a secret in the private repo.

### Rejected approach: a self-retraining model

Discussed 2026-11-15 and rejected. Online or automatic retraining gains
almost nothing: new 10% episodes arrive about once a year. Flexible models
overfit about 21 episodes. Automatic retraining also breaks auditability,
can drift silently, and learns "calm" just before a shock.

Use deliberate periodic refits instead: once a year, or after each new
episode resolves. A refit replaces the current model only if it passes the
same out-of-sample test and exit criterion. A regularized gradient-boosted
model may be tested once, as Variant F.

### Rejected: Kubernetes / full MLOps serving stack (reviewed 2026-11-16)

Considered: reusing the maintainer's stock-prediction MLOps setup
(Kubernetes + Helm autoscaling, a FastAPI prediction service, a weekly
retrain cron, Docker images). Rejected because each piece solves a problem
this project doesn't have:
- Kubernetes scales a service under heavy request load. Here there's **one
  score a day**, computed inside `rule_engine` from a model file.
- The data is a few MB (under 100 MB even with 40 countries), and fits take
  seconds to minutes on a laptop.
- What limits this project is the **number of crash episodes, not
  compute.** More machines don't create more crashes.
- A weekly retrain cron conflicts with the rejected self-retraining approach.
- A cluster adds ongoing upkeep (local) or idle monthly cost (cloud) for a
  single maintainer.

**Kept from that repo:** MLflow experiment tracking, the staged pipeline
pattern (ingest → features → train), time-based splits and Parquet
storage. See section 10.

### Rejected: other off-the-shelf model families (reviewed 2026-11-15)

Judged against this problem: a rare yes/no event with ~21 independent
episodes, which must be predicted from data available at the time and give
the same answer every run. Two families were kept: quantile regression (Variant E) and factor
models (as NFCI/STLFSI4, Stage 2). Prediction markets are context only
(Stage 4).

| Model | Why not |
|---|---|
| VARs | Forecast macro variables (GDP, inflation, rates) as continuous series, not crash events. They would forecast our inputs, not our target. |
| FRB/US (Federal Reserve Board) | Large quarterly model of the US economy, built for testing policy scenarios. No equity-drawdown target, and far too heavy for one maintainer. |
| Vanguard's model (VCMM) | Proprietary, and forecasts 10-year return ranges. Its published outlooks could at most feed the Notable Views tab. |
| Hybrid neural-tree ensembles | The most flexible option, so the worst overfitting risk with ~21 events, and hard to audit. |
| Time-series foundation models (TimesFM, Moirai, Chronos) | They forecast a series from its own past. S&P prices are close to a random walk, and the signal comes from *other* variables, which these mostly don't use. **The backtest would be contaminated:** their training data very likely includes the same S&P/FRED history we'd test on. |

---

## 8. Constraints for whoever does the work

- **Read `AGENTS.md` first.**
  - No CI steps, linters or test frameworks.
  - Run each package's commands from inside that package.
  - Run `npm run typecheck` and `npm test` in `rule_engine/` and
    `mcp_server/` after any change.
- **The research repo is offline research, not runtime** (unless Option 2
  is chosen later). Nothing in this repo imports from it.
  - Under Option 1, a new model arrives as a regenerated model file plus
    sample inputs with expected scores, checked by a test.
  - Never hand-edit individual coefficients.
- **This repo is public; the research repo is private.**
  - Wave splits, trigger levels, account names and watchlist tickers live
    only in `local_state/` here (gitignored), or in the private research
    repo.
  - Nothing private flows back into this repo or into public Supabase
    tables: model files, migrations, docs, and the `crash-check-rules.md`
    update all use generic names and public inputs only.
- **Keep `##` / `###` headings stable** in `crash-check-rules.md`;
  `get_rules` serves sections by heading. Update the "Statistical Hazard
  Model" section if anything changes.
- **Data access:**
  - `FRED_API_KEY` is needed for ALFRED vintages; it was missing from the
    shell in an earlier session.
  - A Supabase service-role key is needed to read `data_points`.
  - Pre-2016 S&P history needs Yahoo `^GSPC` (or a similar source).
- **Commit research code as it is written** (see section 3).

---

## 9. Suggested first session

1. Confirm the decisions in section 7 with the maintainer.
2. Create the private research repo with a pinned Python setup, a
   `.gitignore` for cached data, and the README pointing back to this
   brief. Copy in the replay scripts and this brief, and commit.
3. Stage 0: live scoring plus a stored baseline band (small change in
   `rule_engine/` and Supabase, plus a migration).
4. Start Stage 1:
   - a point-in-time data loader (FRED vintages plus release lags), with
     cached outputs gitignored;
   - the label builder;
   - the walk-forward/purged split;
   - the baseline metrics.

   Then regenerate the frozen model's daily 1994–2026 scores from the
   rescued replay and commit them as the reference record (section 3).

   Variant G (HAR volatility forecast) needs only S&P daily closes and
   VIX, so it can be built early. It's a good first fit while the
   point-in-time macro loader is still in progress.

   No crash-model fitting until the baselines reproduce the replay's numbers
   (AUC 0.825 / 0.834) on the non-point-in-time data. That confirms the
   new harness matches the old one before anything is changed.

---

## 10. Solution design (decided 2026-11-16)

**The research repo is the workshop; this repo is the factory.** The
research repo designs and tests models and hands over a finished model
file. This repo runs that file every day, the same way it runs today's
model.

### Data flow

```
 ┌───────────────────────────────────────────────┐
 │  NEW private repo: market-risk-research       │
 │  (Python; run when chosen, no daily schedule) │
 │                                               │
 │  1. Load history: FRED as published at the    │
 │     time (ALFRED), Supabase, Yahoo/Stooq,     │
 │     Shiller                                   │
 │  2. Build inputs + targets                    │
 │  3. Fit and test variants A–G honestly        │
 │  4. Keep or retire (agreed exit criterion)    │
 │  5. Export approved models as files           │
 └──────────────────────┬────────────────────────┘
                        │  hazard_model_vN.json
                        │  vol_model_vN.json
                        │  (+ sample inputs and expected scores)
                        ▼  copied in by a reviewed commit
 ┌───────────────────────────────────────────────┐
 │  THIS public repo (production)                │
 │                                               │
 │  ingestion ─► data_points                     │
 │  rule_engine ─ reads model files, scores      │
 │                daily ─► crash_checks          │
 │                (hazard band, CALM/NORMAL/     │
 │                 JUMPY)                        │
 │  mcp_server ─ applies private rules from      │
 │               local_state/policy.yaml         │
 │               (waves, days to split a buy)    │
 │  dashboard ─ public bands only                │
 └───────────────────────────────────────────────┘
```

### Research repo layout

```
market-risk-research/            (private)
  README.md                      links to this brief
  pyproject.toml + uv.lock       pinned versions, so results don't drift
  .env.example                   names of required secrets (real .env gitignored)
  data/                          local download cache (gitignored; durable copy in cloud storage)
  src/
    data/       loaders: FRED/ALFRED with release lags, Supabase (read-only),
                Yahoo/Stooq indexes, Shiller
    features/   input calculations, written so one function can also score
                a single day (keeps Option 2 cheap)
    targets/    touch −10% (current), will a decline deepen (a),
                fresh fall (b), forward-return quantiles (E),
                realized volatility (G)
    evaluate/   walk-forward and leave-one-crisis-out splits with gaps,
                episode/calendar-block bootstrap, baselines, metrics
    models/     logistic, quantile, HAR, optional gradient boosting
    export/     writes model files + sample inputs with expected scores
  reference/    rescued Nov 9 replay + the frozen model's 1994–2026 daily scores
  experiments/  one config per variant A–G; committed result reports
  releases/     approved, versioned model files
```

### Changes in this repo

1. **Stage 0 first** (no dependency on the research repo): a migration plus
   a `rule_engine` change that scores each stored band once its outcome
   resolves, alongside a stored baseline band.
2. **`hazardModel.ts` reads a model file** instead of hard-coded constants.
   A `node:test` / Vitest case checks the file's sample inputs against
   their expected scores, catching any Python/TypeScript mismatch.
3. **New public outputs on `crash_checks`:** the volatility forecast and
   CALM / NORMAL / JUMPY band, plus new hazard outputs if they pass.
4. **Private rules stay local:** the number of days to split a purchase
   over sits in `local_state/policy.yaml`, applied by `mcp_server`. The
   research repo's pacing backtest reads that file **by path** (configured
   in its `.env`), so policy has one source.

### Experiment tracking: MLflow

- Every run logs its settings, data fingerprints (a hash of each input
  file), the git commit, and its results.
- Use **hosted free MLflow** (for example DagsHub's free tier), or a small
  local MLflow database committed to the repo. Either way the laptop holds
  no unique copy.
- **The committed result reports in `experiments/` are the record of
  truth.** MLflow is for browsing and comparing runs.

### Durability: the laptop holds nothing unique

| Item | Kept durably in |
|---|---|
| Code, result reports, model files, reference scores | Private GitHub repo, **pushed at the end of every session** |
| Experiment runs | Hosted MLflow, or the committed MLflow database |
| Raw data snapshots (FRED vintages, Yahoo/Stooq histories, Shiller) | Free cloud storage (for example Cloudflare R2's free tier), with each file's hash recorded in git. Yahoo histories can change or vanish, so reruns need the exact same files. |
| Secrets (FRED key, Supabase read key) | GitHub secrets and a password manager, never only in a laptop `.env` |

**Compute is interchangeable:** the laptop by default, GitHub Codespaces
(free monthly hours) as a fallback, GitHub Actions (free minutes on
private repos) for long bootstrap runs or a later Option 2. The repo must
set itself up from scratch (`uv sync`, then fetch the data snapshots), so
any of these works.

### Access and safety rules

- **Model files must be safe to publish.** Only coefficients, transforms,
  bands, hit rates and validation summaries. No private policy values.
- **The research repo never writes to Supabase** under Option 1. It only
  reads. If `data_points` is publicly readable (it feeds the public
  dashboard), use the read-only key, not the service-role key. **Check this
  when setting up the repo.**
- No daily job in the research repo. Refits are deliberate (yearly, or
  after a new episode resolves) and must pass the same exit criterion.

### Cost

All free: the laptop, a private GitHub repo with Actions minutes,
Codespaces free hours, hosted MLflow free tier, cloud storage free tier,
and the existing Supabase and FRED accounts. **Total new cost: $0.**
Free-tier terms change over time, so nothing should depend on a single
provider: everything durable is in git or plain files that can be moved.

### Order of work

1. Create the research repo; rescue the replay scripts; push.
2. Stage 0 in this repo.
3. Variant G (volatility forecast) first: it needs only S&P closes and
   VIX, so it's a quick first win.
4. Build the honest testing harness; confirm it reproduces the Nov 9
   numbers; run variants A–F.
5. Export whatever passes; wire it into `rule_engine` via model files.
