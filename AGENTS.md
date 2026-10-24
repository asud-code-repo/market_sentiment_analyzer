# AGENTS.md

Dev-tooling guide for coding agents (Claude Code, GitHub Copilot, etc.)
working in this repo. This is **not** the runtime behavior spec — for
rule thresholds, bands, and wave logic, see
`reference_docs/rules/crash-check-rules.md`. For the Claude Desktop
chat workflow itself, see `reference_docs/rules/project-instructions.md`.
Neither of those files should be restated here; only pointed to.

## What this repo is

A market-crash-monitoring pipeline: scheduled data ingestion → a
deterministic rule engine → a local MCP server (Claude Desktop) → two
static reporting sites. See `README.md` for the full architecture
diagram. Four independent Node packages, each with its own
`package.json`/lockfile — there is no root-level workspace tooling.

## Package responsibilities

| Package | Role | Run from |
|---|---|---|
| `ingestion/` | Pulls FRED/EIA/CBOE/Massive/Polymarket/SEC data into Supabase `data_points`. No LLM, no classification logic. | `ingestion/` |
| `rule_engine/` | Deterministic RED/AMBER/GREEN classification, wave-authorization gate, hazard model. Reads `data_points`, writes `crash_checks`. | `rule_engine/` |
| `mcp_server/` | Local stdio MCP server for Claude Desktop. Merges Supabase state with `local_state/portfolio.yaml` at read-time only — never writes portfolio data anywhere. Run via `npx tsx src/server.ts` from this working tree (not published/installed). | `mcp_server/` |
| `dashboard_site/` + `full_report_site/` | Static Cloudflare Pages sites (no build step, no `package.json`). `full_report_site` has a Pages Function (`functions/index.ts`) behind Cloudflare Access. | n/a |
| `supabase/migrations/` | SQL migrations, applied via the Supabase dashboard/CLI. Not run by CI. | n/a |

## Build / typecheck commands

Each of the three Node packages is independent — install and typecheck
from inside that package's directory, not the repo root:

```bash
cd ingestion && npm ci && npm run typecheck
cd rule_engine && npm ci && npm run typecheck
cd mcp_server && npm ci && npm run typecheck
```

There is no test suite today (`tsc --noEmit` plus manual verification is
the current practice — see `BACKLOG.md` for the known gap). Don't add a
test runner, CI step, or linter as part of an unrelated change.

All three packages require Node >=22 (`engines.node` in each
`package.json`) — matches what `.github/workflows/*.yml` installs via
`actions/setup-node@v4`.

## Working-directory convention

GitHub Actions workflows (`.github/workflows/ingest.yml`,
`backfill.yml`, `sec13f.yml`) each set `defaults.run.working-directory`
to the one package they invoke, then `npm ci` + a single `npm run
<script>`. Match this convention for any new workflow or local script:
operate from inside one package's directory, never add root-level
install/build steps.

## Making a rule change safely

1. The authoritative thresholds/bands/wave-trigger logic live in
   `reference_docs/rules/crash-check-rules.md` (prose spec) and are
   implemented independently in `rule_engine/src/classify.ts` and
   `mcp_server/src/lib/supabase.ts` — **the wave-authorization gating
   formula is duplicated between these two files with no shared
   package enforcing agreement.** If you change the gate, update both
   and re-run `npm run typecheck` in both packages.
2. `rule_engine/src/lib/seriesDelta.ts` and
   `mcp_server/src/lib/seriesDelta.ts` are separate copies that have
   already diverged — read both before changing either; don't assume
   they're identical.
3. Never edit `reference_docs/rules/crash-check-rules.md`'s thresholds
   without also checking `dashboard_site/` for hardcoded chart bands
   (VIX 20/35, HY spread 350/500bp, 10yr yield 4.3/5.0, Sahm 0.3/0.5) —
   these are not read from the rules doc at render time.
4. Never write real portfolio/dollar data outside `local_state/*.yaml`
   (gitignored) — only the `*.example.yaml` templates are tracked.

## Do not

- Don't add a CI linter, pre-commit hook, or test framework — single
  maintainer, zero ongoing-maintenance budget.
- Don't rename or move `reference_docs/rules/crash-check-rules.md` or
  `reference_docs/rules/project-instructions.md` — both are read as
  project knowledge from GitHub `main` by a separate tool (Claude
  Desktop project knowledge), and by path from this repo's own code.
- Don't restate rule thresholds or architecture here — link to them.
