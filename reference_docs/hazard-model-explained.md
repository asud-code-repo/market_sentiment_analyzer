# How the Hazard Model Works

*Written for a data engineer with no ML background. Covers what the model
computes, where its inputs come from, how the math runs end to end, and its
known limitations. For the formal thresholds/bands, see
`reference_docs/rules/crash-check-rules.md`'s "Statistical Hazard Model"
section — this doc is the plain-language companion to that spec, not a
replacement for it.*

## TL;DR

Every weekday, one function (`computeHazardProbability` in
`rule_engine/src/hazardModel.ts`) answers one question: **"if the S&P
isn't already down 10%+ from its high, what's the chance it gets there in
the next ~21 trading days?"** It does this by plugging 32 numbers — mostly
macro/market data already sitting in this system's Supabase database — into
a fixed formula that was reportedly fit *once*, offline, back in August
2026 — see the status note under Known Limitations below: the original
research behind that fit is not independently verifiable from anything in
this repository. Nothing here "learns" or retrains at runtime. Production just replays arithmetic: standardize each
input, multiply by a pre-computed weight, sum it up, squash it into a 0-1
range, then nudge that number through a lookup table to correct for the
model's own known bias. The output is a probability plus a LOW /
TRANSITIONING / HIGH label, stored alongside the rest of the daily market
snapshot and shown as its own card — deliberately never blended with the
system's other (LLM-judgment) crash-probability number.

## The Big Picture: Where This Fits

The hazard model is not a standalone service — it's one function call
inside the bigger daily pipeline that already exists in this repo. As a
data engineer, think of it as **one more derived column computed during
the nightly batch job**, except the "batch job" runs on GitHub Actions
every weekday morning:

```
 FRED (macro/rates/credit)          Massive (market prices)
        |                                   |
        v                                   v
  +--------------------------------------------------+
  |        ingestion/   (scheduled, weekdays)         |
  |  pulls raw series, writes one row per data point  |
  +--------------------------------------------------+
                        |
                        v
  +--------------------------------------------------+
  |   Supabase Postgres: data_points table            |
  |   (series_id, observation_date, value)            |
  +--------------------------------------------------+
                        |
                        v
  +--------------------------------------------------+
  |   rule_engine/  classify.ts   (runs once/day)     |
  |   - computes the 6-indicator RED/AMBER/GREEN panel|
  |   - runs divergence checks                        |
  |   ->>  calls hazardModel.ts  <<-                  |
  |        1. gatherHazardFeatures()  (reads inputs)  |
  |        2. computeHazardProbability()  (pure math) |
  +--------------------------------------------------+
                        |
                        v
  +--------------------------------------------------+
  |   Supabase: crash_checks table (one row/day)      |
  |   hazard_10pct_raw_pct                            |
  |   hazard_10pct_calibrated_pct                     |
  |   hazard_10pct_band                               |
  +--------------------------------------------------+
              |                        |
              v                        v
     mcp_server (Claude Desktop)   dashboard_site (public card)
```

| Layer | What it does | Code |
|---|---|---|
| Ingestion | Pulls raw FRED macro/rate/credit series and market prices, writes them to `data_points` | `ingestion/` |
| `data_points` (Supabase) | Durable time-series store — one row per `(series_id, observation_date)`, the *only* place raw history lives | Supabase Postgres |
| `classify.ts` | Orchestrator that runs once a day, builds the deterministic 6-indicator panel, and calls the hazard model as one additional, non-blocking step | `rule_engine/src/classify.ts` |
| `hazardModel.ts` | Pulls the 32 feature values it needs and runs the fixed formula — no I/O beyond reading; pure math | `rule_engine/src/hazardModel.ts` |
| `crash_checks` (Supabase) | Stores that day's full result, including the three hazard fields | Supabase Postgres |
| MCP server / dashboard | Reads `crash_checks` and surfaces the hazard band to Claude Desktop (chat tool calls) and to the public dashboard's own card | `mcp_server/`, `dashboard_site/` |

The key data-engineering detail: **the hazard model never talks to FRED
directly.** It only reads rows that ingestion already landed in
`data_points`. If a required series hasn't been ingested yet,
`gatherHazardFeatures()` throws, `classify.ts` catches it, and that day's
hazard fields go to `null` rather than blocking the rest of the pipeline.

## What Data Goes In

Every input is a series that's already flowing into `data_points` via
normal daily ingestion — the hazard model adds no new data sources, it
just reads more of what's already there. 16 raw series (mostly from FRED)
plus 2 derived values:

| Series | Plain-English meaning | Why it signals crash risk |
|---|---|---|
| `VIXCLS` (VIX) | Options-implied 30-day expected S&P volatility — the "fear index" | Spikes sharply before/during selloffs |
| `BAA10Y` | Baa corporate bond yield minus 10yr Treasury yield | A credit-spread proxy — widens when investors demand more compensation to hold risky corporate debt |
| `DGS10`, `DGS2` | 10-year and 2-year Treasury yields | Combined into the yield-curve slope (`curve_2s10s`); an inverted curve (2y > 10y) is a classic recession precursor |
| `ICSA` | Initial unemployment claims (fresh layoffs, weekly) | Leading labor-market stress signal |
| `CCSA` | Continued unemployment claims | How long people stay unemployed once laid off |
| `UNRATE` | Unemployment rate | Lagging but confirms labor deterioration |
| `SAHMREALTIME` | The Sahm Rule recession indicator (already computed elsewhere in this system) | A well-known real-time recession trigger |
| `CPIAUCSL` | CPI — inflation level | High/volatile inflation constrains the Fed's ability to cut rates to rescue markets |
| `DCOILWTICO` | WTI crude oil price | Oil shocks are a recurring crash trigger (1990, 2008, 2022) |
| `DRCCLACBS` | Credit-card loan delinquency rate | Consumer credit stress |
| `DRTSCILM` | % of banks tightening lending standards | Credit availability drying up |
| `NFCI` | Chicago Fed National Financial Conditions Index | Broad, composite financial-stress index |
| `STLFSI4` | St. Louis Fed Financial Stress Index | A second, independently-constructed stress composite |
| `RECPROUSM156N` | Chauvet-Piger smoothed recession probability | A third-party recession-probability estimate (see Caveats — this one has a known issue) |
| `RSAFS` | Retail sales | Consumer demand — weakening spending often precedes a downturn |
| `SP500` / `SP500_ATH` | S&P 500 level and its running all-time high | Used to compute today's drawdown-from-peak and 20-day realized volatility |

Most of these are read twice more, as **deltas**: how much did VIX,
BAA10Y, NFCI, STLFSI4, DGS10, the curve slope, and the drawdown itself
move over the last *5 trading days* and the last *20 trading days*? A
market that fell 5% today after being flat for a month is a very
different signal from one that's been grinding down for a month already —
the deltas are what let the model tell those apart. That brings the total
feature count to 32.

## Step by Step: From 32 Numbers to One Probability

**1. Gather the 32 raw feature values.** `gatherHazardFeatures()` fetches
the latest row for each of the 16 series above from `data_points`, reuses
a few values `classify.ts` already pulled this run (VIX, 10yr yield, Sahm
Rule, today's drawdown — no need to re-query them), and computes the 2
derived values (yield-curve slope, 20-day realized volatility). It also
resolves exactly which calendar dates count as "5 trading days ago" and
"20 trading days ago" by counting back rows in the `SP500` series itself
(so weekends and holidays like Labor Day are correctly skipped, not
approximated as 7/28 calendar days), then computes all 14 delta features
against those two anchor dates.

**2. Standardize each value (z-score).** Every raw value is on a wildly
different scale — VIX sits around 15-30, `ICSA` sits around 300,000.
Before they can be combined, each one is rescaled with a value that was
fixed back when the model was trained:

```
standardized = (raw_value - scaler_mean) / scaler_scale
```

`scaler_mean` and `scaler_scale` are just the average and spread of that
feature across the model's training history — baked-in constants, not
something recomputed live. This is the same idea as a SQL
`(value - AVG(value)) / STDDEV(value)` window function, just precomputed
once rather than recalculated per row.

**3. Weighted sum ("the logit").** Multiply each of the 32 standardized
values by its own fixed coefficient (also baked in — see `FEATURES` in the
code), sum all 32 products, then add one more constant (the `INTERCEPT`,
-2.557). The result is a single number, the *logit*, which can be any real
number — very negative for low-risk-looking conditions, very positive for
high-risk-looking ones.

**4. Sigmoid — squash into a 0-1 probability.** The logit gets passed
through the sigmoid function:

```
raw_probability = 1 / (1 + e^(-logit))
```

This is the standard trick for turning "any real number" into "something
that behaves like a probability" — large negative logits collapse toward
0, large positive logits saturate toward 1, and 0 maps to exactly 0.5.
This `raw_probability` is what a plain logistic regression would report on
its own.

**5. Isotonic calibration — correct the raw number.** The raw sigmoid
output turned out not to match real-world frequencies well (see
Calibration below), so it's passed through one more lookup: an 18-point
table (`ISOTONIC_TABLE`) mapping raw scores to corrected ("calibrated")
probabilities, with straight-line interpolation between table points. This
calibrated number is the one that actually gets used.

**6. Band it.** The calibrated probability is converted to one of three
labels using fixed cutoffs: **LOW** below 35%, **TRANSITIONING** 35-90%,
**HIGH** 90%+.

**7. Persist.** `classify.ts` writes `hazard_10pct_raw_pct`,
`hazard_10pct_calibrated_pct`, and `hazard_10pct_band` into that day's
`crash_checks` row, right alongside the rest of the daily snapshot.

## "Logistic Regression" Demystified

If you've never touched ML, the name sounds intimidating. Strip away the
jargon and it's two familiar ideas stacked together:

**Idea 1 — it's a weighted sum, like a spreadsheet formula.** You already
know linear regression conceptually, even if you've never called it that:
`score = w1*x1 + w2*x2 + ... + w32*x32 + intercept`. That's exactly Step 3
above. Every feature gets a coefficient (a weight) that says "how much
does this input push the score up or down, and by how much." A positive
coefficient (like `BAA10Y` at +0.44) means "as this goes up, crash risk
goes up." A negative one (like `DGS10` at -0.17) means "as this goes up,
crash risk goes down" — that's it. There's no neural network, no
iteration, no black box happening at request time; it's one dot-product.

**Idea 2 — "logistic" just means the output gets forced into a 0-1
range.** A plain weighted sum can spit out any number: -14, 3.2, 400.
That's fine for predicting, say, a dollar amount, but useless for a
probability, which must land between 0 and 1. The *sigmoid* function (Step
4) is a fixed S-shaped curve that takes any real number and squashes it
into that range without changing its ranking — a higher logit always
produces a higher probability, the sigmoid just reshapes the number line.
"Logistic regression" = linear regression's weighted sum, piped through
that squashing curve.

**Where did the weights come from, and does the model ever change them?**
A data scientist fit them once, offline, back in August 2026, using a
technique (`scikit-learn`'s logistic regression) that finds the 32
coefficients + intercept that best separate "followed by a 10%+ drawdown
within 21 days" days from "didn't" days across market history since 1993,
including 5 real crises (dot-com, 2008, Dec 2018, COVID, 2022). That
fitting process is called *training*, and it does not happen in this
codebase — the trained numbers were exported to a JSON artifact and
hand-copied into `FEATURES`/`INTERCEPT` in `hazardModel.ts` as fixed
constants. Production only ever *replays* that frozen formula; it never
re-fits or adapts. If the weights are ever wrong or stale, the only fix is
redoing that offline research and pasting in new constants — there is no
"nightly retrain" job.

## Why Calibration, and Why a Band Instead of a Percentage

A raw logistic regression's sigmoid output is a *ranking*, not
automatically a trustworthy probability — a score of 0.7 doesn't
necessarily mean "this actually happens 70% of the time historically."
When the data scientist checked, this model's raw output *was*
miscalibrated. The fix (isotonic regression) is itself simple despite the
name: take the pooled out-of-sample predictions, sort them, and fit a
stairstep curve that's only allowed to go up (never down) as the raw score
increases, choosing step heights that match observed real-world frequency
as closely as possible. `ISOTONIC_TABLE` in the code is exactly that
stairstep, stored as 18 (raw, calibrated) points that Step 5 linearly
interpolates between.

The practical consequence: that stairstep is *steppy*, with two wide flat
plateaus — any raw score under ~15% calibrates to roughly 22-24%, and any
raw score from ~26% up to ~83% all calibrates to roughly 93%. Almost all
of the model's real discriminating power is packed into the narrow 15-26%
raw-score band between those two plateaus. Displaying "73.4%" would imply
a precision the model doesn't actually have — a raw score of 30% and a raw
score of 80% can calibrate to the *same* number. That's why the dashboard
shows **LOW / TRANSITIONING / HIGH** as the headline, with the exact raw
and calibrated numbers demoted to smaller print underneath for
transparency, rather than the reverse.

## Worked Example (Illustrative, Not a Real Historical Day)

Suppose on some hypothetical day: the S&P is 6% off its all-time high, VIX
is at 24, the Baa-Treasury credit spread has widened to 2.6, the NFCI
financial-conditions index has drifted up to 0.0 (from its usual -0.52),
and the 2s10s yield curve is mildly inverted at -0.3. Walking 5 of the 32
features through Steps 2-3 (the other 27 assumed near their historical
average, so each contributes roughly zero):

| Feature | Raw value | Standardized (z-score) | × coefficient | Contribution |
|---|---|---|---|---|
| `drawdown_pct` | -6.0 | -1.196 | × -0.795 | +0.951 |
| `VIXCLS` | 24 | +1.328 | × 0.064 | +0.085 |
| `BAA10Y` | 2.6 | +1.157 | × 0.439 | +0.508 |
| `NFCI` | 0.0 | +2.404 | × 0.203 | +0.487 |
| `curve_2s10s` | -0.3 | -1.385 | × -0.392 | +0.543 |

Sum of these 5 contributions: **2.574**. Add the other 27 (≈0) and the
intercept (-2.557): **logit ≈ 0.017**.

Sigmoid: `1 / (1 + e^-0.017)` ≈ **50.4% raw probability**.

Isotonic lookup: 50.4% falls inside the wide plateau between the table's
25.7% and 82.6% breakpoints — both map to the same calibrated value,
**92.7%**.

Band: 92.7% ≥ 90%, so the day is flagged **HIGH**.

This is exactly the calibration behavior described above in practice: a
raw score that looks like a coin flip (50%) still lands on the model's 93%
plateau, because that whole raw-score range historically preceded a 10%+
drawdown at roughly that same high rate.

## Known Limitations (Documented On Purpose)

- **The original validation cannot currently be independently verified.**
  Confirmed 2026-09-19: an external review plus a follow-up search of this
  repository and every reference doc found no training script/notebook,
  no label or fold definitions, no bootstrap output, and no artifact
  manifest behind `hazard_model_10pct_artifact.json` — only the frozen
  coefficients already ported into `hazardModel.ts`. Every claim elsewhere
  in this doc and in `crash-check-rules.md` about walk-forward validation,
  leave-one-crisis-out testing, or a bootstrap-confirmed edge describes
  what the original research *reported*, not something reproducible today.
  Reproducing it would mean a full rebuild from raw data — point-in-time
  FRED/SPY reconstruction, refitting, and a leakage-safe backtest against
  simple baselines — not a recovery of existing work. Treat this model's
  validation status as documented, not established, until that happens.
- **One feature has confirmed data leakage.** `RECPROUSM156N` (the
  third-party smoothed recession-probability series) gets revised after
  the fact using information that wasn't available at the time —
  confirmed against the producer's own FAQ. That means the coefficient
  fit for this feature (+0.306) was trained partly on hindsight. It can't
  be patched by simply deleting or zeroing that one line, because
  logistic-regression coefficients are fit jointly — removing one without
  refitting the whole model would just introduce a different,
  uncontrolled distortion. The real fix is retraining with that feature
  removed or replaced with point-in-time data, which is real research
  work, tracked in `BACKLOG.md`, not done in this codebase.
- **The credit-spread feature is a substitute, not the real thing.**
  `BAA10Y` stands in for the more standard high-yield credit spread
  series, because that series' history doesn't go back far enough to
  cover the crises this model was reportedly trained against. It's a
  reasonable substitute (both move together), but it's an
  investment-grade spread, not a junk-grade one — sound specifically
  because training and production both consistently use the `BAA10Y`
  version, though see the status note above on what "trained against"
  can currently be verified to mean.
- **A companion 20%-drawdown version was tried and shelved.** Only 4 real
  historical episodes ever reached a 20% drawdown, too few to
  statistically distinguish the model's edge from a lucky guess (the
  confidence interval spanned zero). It was never shipped in any form —
  this system only ever reports the 10% target.
- **It's advisory, not a gate.** This number is explicitly *not* one of
  the 6 inputs that authorize this system's staged deployment logic, and
  it's never combined with the system's other, LLM-judgment
  crash-probability number. A `null` reading means the computation failed
  for that day (e.g. one input series had a gap) — it should be read as
  "unavailable," never as "zero risk."

## Where You'd Actually See This

- **Cadence**: computed once per weekday, as part of the same
  `classify.ts` run that produces the 6-indicator panel (triggered by the
  `ingest-then-classify` GitHub Action).
- **Storage**: `crash_checks.hazard_10pct_raw_pct`,
  `hazard_10pct_calibrated_pct`, `hazard_10pct_band`,
  `hazard_10pct_as_of`.
- **Chat / Claude Desktop**: the `get_indicator_panel` MCP tool's
  `hazard_model_10pct` field.
- **Public dashboard**: its own "Statistical Hazard Model" card,
  deliberately placed away from the crash-probability meter so the two
  are never visually implied to agree or disagree.
