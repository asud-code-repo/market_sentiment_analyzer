<div align="center">

# Macro Market Stress Monitor

**The LLM writes the story. The code makes the call.**

A daily market-stress and crash-risk monitor built on public data. A
deterministic TypeScript rule engine scores six crash indicators
RED / AMBER / GREEN. Claude, connected over MCP, does the research and writes
the narrative, and never re-derives a number.

[![Daily ingest](https://img.shields.io/github/actions/workflow/status/asud-code-repo/market_sentiment_analyzer/ingest.yml?branch=main&style=flat-square&label=daily%20ingest)](https://github.com/asud-code-repo/market_sentiment_analyzer/actions/workflows/ingest.yml)
[![Live site](https://img.shields.io/website?url=https%3A%2F%2Fmarketstress.org&style=flat-square&label=marketstress.org&up_message=live&down_message=down)](https://marketstress.org/)
[![Last commit](https://img.shields.io/github/last-commit/asud-code-repo/market_sentiment_analyzer?style=flat-square)](https://github.com/asud-code-repo/market_sentiment_analyzer/commits/main)
<br>
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare%20Pages-F38020?style=flat-square&logo=cloudflarepages&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF?style=flat-square&logo=githubactions&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-server-111111?style=flat-square&logo=modelcontextprotocol&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=claude&logoColor=white)

**[Live dashboard →](https://marketstress.org/)** · free, no sign-up, updated daily<br>
[How it works](#how-it-works) · [Evidence](#evidence-over-vibes) · [Rules](reference_docs/rules/crash-check-rules.md) · [Run it yourself](#run-it-yourself) · [Known gaps](BACKLOG.md)

<a href="https://marketstress.org/">
  <img src="docs/screenshots/stress.png" alt="The Stress tab of marketstress.org: 1 of 6 indicators red, the six-indicator gate panel with 60-day sparklines, distance to red, the drawdown risk band and upcoming catalysts" width="900">
</a>

</div>

> [!WARNING]
> **Not investment advice.** This is a personal, educational project. The
> dashboard's bands, stress gate and crash probability apply the author's own
> rules to public data. They are not recommendations to buy or sell anything,
> and the data can be delayed, revised or wrong. The code is shared as-is,
> with no warranty.

## Contents

- [Why this exists](#why-this-exists)
- [The dashboard](#the-dashboard)
- [How it works](#how-it-works)
- [What's deterministic and what's judgment](#whats-deterministic-and-whats-judgment)
- [Evidence over vibes](#evidence-over-vibes)
- [The indicators](#the-indicators)
- [AI workflows over MCP](#ai-workflows-over-mcp)
- [Security model: public engine, private policy](#security-model-public-engine-private-policy)
- [Tech stack](#tech-stack)
- [Run it yourself](#run-it-yourself)
- [Project structure](#project-structure)
- [Contributing, security and status](#contributing-security-and-status)

## Why this exists

It started as a giant static prompt: numbers hand-pasted into an LLM chat on
every run. That gave confident, unrepeatable answers. It became a small
pipeline built on three rules:

- **Numeric classification is never an LLM's job.** Every threshold, band and
  RED/AMBER/GREEN colour is computed by plain code from real market data. The
  LLM reads news, judges Fed communication and writes the narrative, and it
  always reports what the code already decided.
- **Every signal has to earn its place.** New flags are backtested for a base
  rate and a forward edge before they ship. Ideas that fail stay documented
  with their evidence, and features that turn out to be noise get deleted.
- **Personal data never leaves the machine.** The engine and the dashboard
  are public; the deployment policy and every dollar figure stay in local,
  gitignored files, with guardrails in code that refuse to publish them.

## The dashboard

[marketstress.org](https://marketstress.org/) has four read-only tabs, each
with its own URL:

| | |
|---|---|
| **[Stress](https://marketstress.org/)**: the six-indicator panel, the stress gate, distance to RED, the drawdown risk band, a 3-month scenario view, upcoming catalysts, divergence flags and indicator history charts with their bands. | **[Smart Money](https://marketstress.org/smart-money)**: futures positioning (CFTC), options put/call and margin debt as historical percentiles, sector capital rotation, and institutional 13F net buying by sector. |
| <img src="docs/screenshots/stress.png" alt="Stress tab" width="440"> | <img src="docs/screenshots/smart-money.png" alt="Smart Money tab: positioning measures shown as percentiles of their own history" width="440"> |
| **[Macro & Fiscal](https://marketstress.org/macro)**: a fiscal dominance checklist, contextual indicators, the yield curve and rates decomposition, and a short AI-written summary that is only rewritten when the data underneath changes. | **[Notable Views](https://marketstress.org/views)**: what well-known macro voices are saying, set against today's data. Short attributed paraphrases with links and dates, reviewed by hand before publishing. |
| <img src="docs/screenshots/macro.png" alt="Macro & Fiscal tab: fiscal dominance checklist and yield curve" width="440"> | <img src="docs/screenshots/views.png" alt="Notable Views tab: macro commentators' views checked against live data" width="440"> |

You can browse past reports with a calendar picker, check each source's
freshness, and install the dashboard as a home-screen app (PWA).

<details>
<summary>Animated tour (recorded 2026-11-15)</summary>
<br>
<img src="docs/demo.gif" alt="Animated tour of the four dashboard tabs" width="880">
</details>

## How it works

```mermaid
flowchart LR
    SRC["Public data<br/>FRED · Treasury · Yahoo · EIA · CBOE<br/>CFTC · FINRA · SEC EDGAR · State Street<br/>GPR index · Polymarket · Massive"]
    ING["ingestion/<br/>fetch · normalise ·<br/>plausibility guard"]
    DB[("Supabase<br/>public: market data, rule output<br/>private: report snapshots<br/>no dollar figures")]
    RE["rule_engine/<br/>panel · stress gate ·<br/>risk band"]
    DASH["dashboard_site/<br/>public · marketstress.org"]
    FULL["full_report_site/<br/>private · Cloudflare Access"]
    MCP["mcp_server/<br/>21 MCP tools · runs locally"]
    LOCAL[["local_state/<br/>personal policy and balances<br/>never leave the machine"]]
    LLM["Claude<br/>research and narrative only"]

    SRC -->|"GitHub Actions<br/>10am + 6pm ET"| ING --> DB
    DB <--> RE
    DB --> DASH
    DB --> FULL
    DB <--> MCP
    LOCAL --> MCP
    MCP <--> LLM
```

| Component | What it does |
|---|---|
| [`ingestion/`](ingestion/) | Pulls each source into Supabase. A plausibility guard quarantines implausible values before they're written, and a backfill script loads each series' full history. No LLM and no classification logic. |
| [`rule_engine/`](rule_engine/) | Pure functions: the six-indicator panel, confirmation windows, the stress gate, cross-indicator divergence flags and the drawdown risk band. Writes `crash_checks`, and sends an ntfy.sh push when the confirmed-RED count rises to 2 or more. Vitest suite. |
| [`mcp_server/`](mcp_server/) | Local stdio [Model Context Protocol](https://modelcontextprotocol.io/) server. 21 tools: workflow instructions, market state, context indicators, rules lookup, portfolio drift, watchlist, wave evaluation, deployment planning and fire drill, fund-filing watch, and write/persist tools. Runs locally because it's the only component that reads personal data. `node:test` suite. |
| [`dashboard_site/`](dashboard_site/) | Public static site on Cloudflare Pages, no build step. Reads only public market data with the anon key. A small worker server-renders the latest reading for crawlers and AI tools. |
| [`full_report_site/`](full_report_site/) | Private page behind Cloudflare Access: wave status, personal triggers, the watchlist with insider activity, crash-type diagnosis and the portfolio review. Rendered server-side, so no credential reaches the browser. |
| [`config/`](config/) | `monitoring.yaml`: the public panel bands, confirmation days, stress gate and push-alert count, read by both `rule_engine` and `mcp_server`. |
| [`supabase/migrations/`](supabase/migrations/) | Schema and row-level-security history. |

## What's deterministic and what's judgment

This is a stress-monitoring and discretionary deployment dashboard, **not a
calibrated crash-probability model**. Both reporting pages say so.

| Output | How it's produced | Validated? |
|---|---|---|
| Six-indicator panel, bands, confirmation windows, stress gate | Code (`rule_engine/`), thresholds in `config/monitoring.yaml` | Deterministic and reproducible |
| Deployment waves | Code (`mcp_server/`), triggers in a private local policy file | Deterministic. The pathways were replayed against every ≥20% S&P drawdown since 1993, but the thresholds are a personal choice, not an optimised fit |
| Drawdown risk band: could the S&P end up 10% below its peak within ~21 trading days? | Code: S&P drawdown % + VIX / 5, three bands | Yes, modestly. See [the results below](#results-the-drawdown-risk-band) |
| Scenario split and crash probability | A frozen historical bull/base/bear/crash split for the current risk band, which the LLM may tilt by one 5-point step | Partly: the split is history (a handful of crises); the tilt has no track record yet |
| Crash-type diagnosis, Fed classification | LLM judgment informed by the panel and web research | No |

The full write-up is in
[`crash-check-rules.md`](reference_docs/rules/crash-check-rules.md)
("What this system actually is").

## Evidence over vibes

How changes get made, and what's been thrown out along the way:

- **New signals are backtested before they ship.** A flag needs a base rate
  and a forward edge. Rejected so far, with the evidence kept: a MOVE-vs-VIX
  divergence flag, a BDC-ETF private-credit proxy, high-frequency positioning
  signals and a CTA trend-exposure estimate. See "Investigated and rejected"
  in the rules doc,
  [`BUILD_SPEC_crash_check_enhancements.md`](reference_docs/BUILD_SPEC_crash_check_enhancements.md)
  and the
  [hazard-model rebuild brief](reference_docs/hazard-model-rebuild-brief.md).
- **A model that couldn't beat a simple rule was retired.** A 32-input
  logistic hazard model looked strong in-sample. Refit honestly out of sample,
  it scored an AUC of 0.545 (a coin flip is 0.5) against 0.818 for a
  two-input drawdown + VIX rule, and three rebuilt variants also failed. The
  rule replaced it, and the model is still scored daily, side by side, so the
  record stays honest
  ([`hazard-model-rebuild-brief.md`](reference_docs/hazard-model-rebuild-brief.md)).
- **Rules that hurt in backtests are relaxed, in public.** Requiring the
  3-of-6 stress gate before deploying blocked six deployments since 1990 that
  were all up a year later, and never blocked one that lost (two
  pre-registered backtests on 1962–2026 data, reproduced by an independent
  reviewer). Since 2026-11-19 the gate is shown as information, not required.
- **Low-signal features get cut.** A discretionary "Risk Radar" score was
  retired, and later deleted, after its readings swung run to run on
  unchanged data.
- **Refactors are checked for identical behaviour.** Moving thresholds into
  config files and wave evaluation onto the local machine was verified by
  diffing old and new code over every input combination and the full real
  history before switching over.
- **External reviews are written down with their outcomes**
  ([`architecture-summary-for-external-review.md`](reference_docs/architecture-summary-for-external-review.md)).

### Results: the drawdown risk band

Score = S&P drawdown from its all-time high (%) + VIX / 5. The cutoffs were
fixed before any live scoring and are never retuned from live results.

| Band | Score | Share of days, 1994–2026 | S&P closed 10%+ below its peak within the next ~21 trading days |
|---|---|---|---|
| Low | below 8.5 | ~77% | 4.6% |
| Elevated | 8.5 to 10 | ~8% | 16.8% |
| High | 10 and above | ~15% | 44.4% |
| *All days* | | | *~12% base rate* |

Ranking skill (AUC): 0.834 in the 1994–2026 replay, 0.818 out of sample. The
live scorecard keeps recording each day's band against what actually
happened.

## The indicators

### The six-indicator panel and the stress gate

The panel tracks **VIX, HY credit spreads, S&P drawdown from its all-time
high, the 10-year Treasury yield, the Sahm Rule and a Fed-pivot signal**. A
RED reading only counts once it holds across two or more distinct ingestion
dates, so a single noisy print can't trigger anything. The **stress gate** is
met when 3 or more of the 6 are confirmed RED: a read on how broad the stress
is. All of these thresholds live in
[`config/monitoring.yaml`](config/monitoring.yaml).

### Deployment waves

A staged, three-tranche plan for deploying a cash reserve. A wave becomes
deployable when **its own trigger** holds: S&P drawdown from the all-time high
plus a VIX level (same day), or a separate "slow-bear" pathway (deep drawdown
plus a fresh one-year low, confirmed on two dates) for grinding,
low-volatility bears like 2000–02 and 2022, which the drawdown + VIX pathway
missed in backtesting. The stress gate is reported alongside; setting
`stress_gate_required: true` in the config makes it a requirement again.

Trigger levels and the percentage split of each wave are personal policy, so
they live in a gitignored local file, not in this repo. Waves are evaluated
on the local machine from public inputs the rule engine publishes (drawdown,
VIX, days since a one-year low). Deployment is cumulative and
execution-aware: a fast crash that skips straight to Wave 3 returns every
not-yet-executed wave, and executed waves are tracked locally so they're
never proposed twice.

### Context only (never gates)

- **Contextual indicators:** financial-conditions and stress indices (incl.
  the OFR FSI), breakevens, jobless claims, IG spreads, the yield curve and
  the NY Fed's recession-probability model, the SOFR−IORB repo-stress spread,
  MOVE bond volatility, Treasury auction quality, copper, recent-grad
  unemployment and more.
- **Distance to RED:** how far each panel indicator is from its RED band.
- **Divergence detection:** pairs that normally move together, flagged when
  they decouple: IG vs HY spreads, initial vs continuing claims, VIX vs HY,
  gold vs silver, and foreign official Treasury holdings vs the 10-year
  yield.
- **Positioning and flows:** CFTC Commitments of Traders, CBOE put/call and
  FINRA margin debt as historical percentiles; sector rotation; 13F
  institutional net buying by sector.
- **Fiscal dominance checklist:** Taylor-rule gap, primary balance, net
  interest as a share of GDP and of receipts, the average rate on marketable
  debt, and the gold/real-yield relationship.
- **Event-conditional scenarios** for scheduled events such as FOMC
  meetings, scored after the event.

## AI workflows over MCP

The MCP server works with any MCP client. Two workflows run on it:

- **"Run crash check"** runs every weekday evening as a headless Claude Code
  job, after the 6pm ingest. It confirms ingestion actually ran, pulls the
  panel and context, and commits to a scenario view **before** it can see the
  previous report's number. That anti-anchoring rule is enforced by tool
  order: no tool used in the first six steps exposes a prior probability. It
  then does the qualitative research, persists the result (`write_snapshot`
  for the public row, `write_full_report` for the private page) and ends with
  a plain-text summary. Steps:
  [`project-instructions.md`](reference_docs/rules/project-instructions.md).
- **"Run portfolio review"** runs weekly. It covers portfolio drift against
  targets, watchlist status, a deployment fire drill, fund-filing checks and
  a re-underwrite of each watchlist thesis. It's rendered from
  [`portfolio-review-template.html`](reference_docs/rules/portfolio-review-template.html)
  and merged into the private Full Report page. It only proposes changes;
  applying them is a manual step.

The instructions, the review template and the rules doc are served by the
MCP server itself (`get_instructions`, `get_rules`) straight from this
working tree, so a change takes effect on the next run without re-uploading
anything.

## Security model: public engine, private policy

Personal financial data never reaches a cloud service, and personal policy
never reaches the public repo or the public tables.

- **Three kinds of configuration.**
  - Public monitoring thresholds: [`config/monitoring.yaml`](config/monitoring.yaml).
  - Personal policy, local and gitignored: `local_state/policy.yaml` (wave
    triggers, wave and crash-type splits, hard rules, private terms) and
    `local_state/personal-rules.md` (the personal sections of the rules doc,
    merged in by the `get_rules` tool).
  - Dollar data, local and gitignored: balances, cash reserve, position
    sizing, executed waves, the exchange log.

  The repo tracks only `*.example.yaml` templates with illustrative numbers.
- **Two access tiers in Supabase.** `crash_checks` and `data_points` are
  readable with the public anon key, which is how the dashboard works; they
  hold market data, rule output and market-event triggers only. Everything
  personal, including the private report snapshots, watchlist ticker prices
  (`private_data_points`), the watchlist and its insider activity, is
  readable only with the server-side key that the local MCP server and the
  Access-gated Pages Function hold.
- **Guardrails in code, not just instructions.** Every write path that
  persists free text checks it against the real local portfolio and throws
  on any dollar figure. `write_snapshot` also refuses public text containing
  any of the policy's private terms (account names, "watchlist") and keeps
  only market-event triggers on the public row.
- **Dollar amounts are computed at read time.** The policy stores wave
  splits as percentages of the cash reserve; the MCP server applies them to
  the local balance, and the result stays in the chat.

Found a problem with any of this? See [`SECURITY.md`](SECURITY.md).

## Tech stack

| Layer | What's used |
|---|---|
| Language and runtime | TypeScript, Node.js 22+ (three independent packages, no root workspace) |
| Scheduling | GitHub Actions cron (10am ET Mon–Sat, 6pm ET Mon–Fri; SEC 13F manual, quarterly) |
| Storage | Supabase Postgres with row-level security, two access tiers |
| Public site | Static HTML/JS on Cloudflare Pages, plus a small worker for server-rendered metadata |
| Private site | Cloudflare Pages Function behind Cloudflare Access |
| AI layer | Model Context Protocol server (stdio), Claude for research and narrative |
| Alerts | ntfy.sh push notifications when a wave trigger fires (run locally) |
| Tests | Vitest (`rule_engine`), `node:test` (`mcp_server`), `tsc --noEmit` everywhere |

## Run it yourself

> **At your own risk.** This is one person's working setup, not a packaged
> product. If you only want the signals, use the
> [live dashboard](https://marketstress.org/).

### Quick look: no keys, no accounts

The rule logic is pure functions with tests, so you can read and run it
without any credentials:

```bash
git clone https://github.com/asud-code-repo/market_sentiment_analyzer.git
cd market_sentiment_analyzer/rule_engine
npm ci
npm test          # Vitest: bands, confirmation, stress gate, risk band, scorecards
cd ../mcp_server
npm ci
npm test          # node:test: deployment instruments, trading limits, filings, scenario tilt
```

Tests use `local_state/policy.example.yaml`, never a real policy.

### Full setup

You'll need your own Supabase project, Cloudflare Pages, GitHub Actions,
several free API keys and an MCP client such as Claude Desktop or Claude
Code. Requires Node 22+. Each of `ingestion/`, `rule_engine/` and
`mcp_server/` is an independent package (`npm ci` inside each) with a
`.env.example` to copy to `.env`:

| Variable | Needed | What it's for |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes | Your Supabase project |
| `FRED_API_KEY` | Yes | Free, [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) |
| `EIA_API_KEY` | Yes | Free, [eia.gov/opendata](https://www.eia.gov/opendata/) |
| `MASSIVE_API_KEY` | For watchlist prices | Free tier at massive.com |
| `SEC_EDGAR_CONTACT_EMAIL` | For SEC data | SEC requires a contact address in automated requests |
| `POLYMARKET_SLUGS` | Optional | Polymarket markets to track |
| `NTFY_TOPIC` | Optional | A random, unguessable ntfy.sh topic for the local wave-trigger alert (`mcp_server`, not GitHub Actions) |

Then:

1. Copy each `local_state/*.example.yaml` to the same name without
   `.example` and fill in your own values, starting with `policy.yaml`
   (your wave triggers and splits) and `portfolio.yaml`. Optionally add a
   `local_state/personal-rules.md` with your own versions of the rules
   doc's personal sections, under the same headings.
2. Tune [`config/monitoring.yaml`](config/monitoring.yaml) if you want
   different bands or a different stress gate.
3. Apply `supabase/migrations/` in order (SQL editor or Supabase CLI).
4. Add the same values as GitHub Actions secrets for
   `.github/workflows/ingest.yml`. Run `backfill.yml` once to load history.
5. MCP client: merge
   [`mcp_server/claude_desktop_config.example.json`](mcp_server/claude_desktop_config.example.json)
   into your config (the MCP server needs `PORTFOLIO_PATH` and
   `WAVE_DEPLOYMENT_STATE_PATH`; the other local files default to sitting
   next to `PORTFOLIO_PATH`). In Claude Desktop, create a project and set its
   instructions to one line: *"Before anything else, call the crash-check
   `get_instructions` tool and follow what it returns."* Attach nothing as
   project knowledge.
6. `dashboard_site/`: a Cloudflare Pages project with no build step. Swap
   in your own Supabase URL and anon key.
7. `full_report_site/`: a second Pages project behind Cloudflare Access.
   See [`full_report_site/README.md`](full_report_site/README.md).

`npm run typecheck` works in all three packages.

## Project structure

```
ingestion/            data sources → Supabase, plausibility-guarded
rule_engine/          deterministic panel, stress gate, risk band
mcp_server/           local MCP tools (21), wave evaluation, wave-trigger alert
dashboard_site/       public dashboard (static, Cloudflare Pages)
full_report_site/     private Full Report page (Cloudflare Pages Function)
config/               public monitoring thresholds
reference_docs/rules/ rules doc, workflow instructions, review template
reference_docs/       hazard-model explainer and rebuild brief, external-review summary, specs
supabase/migrations/  schema + row-level security
local_state/          *.example.yaml templates; real files are gitignored
docs/                 screenshots and demo
.github/workflows/    daily ingest + classify, backfill, SEC 13F
```

## Contributing, security and status

- **Contributing:** questions, data issues and ideas are welcome. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md) for what helps most and how new
  signals are judged.
- **Security:** please don't open a public issue for a vulnerability. See
  [`SECURITY.md`](SECURITY.md).
- **Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- **Known gaps:** [`BACKLOG.md`](BACKLOG.md) lists open items, deliberately
  deferred rather than forgotten.
- **Data sources:** each source (FRED and the series' original providers,
  Treasury, EIA, CBOE, CFTC, FINRA, SEC EDGAR, State Street, Polymarket,
  Yahoo Finance, Massive) keeps its own terms, and you're responsible for
  complying with them when you run the code with your own keys.
- **Status:** a personal project with a single maintainer, shared as-is. It
  runs daily and is actively used, but there's no support commitment, and
  responses aren't guaranteed.

## License

No open-source license has been chosen yet, so all rights are reserved for
now.
