# Contributing

Thanks for taking a look. This is a single-maintainer project that runs
every day, so the most useful contributions are small and well evidenced.
Responses aren't guaranteed, but every issue gets read.

## What helps most

- **A number looks wrong on the dashboard.** Open a
  [data issue](../../issues/new?template=data_issue.yml) with the tab, the
  indicator, the value shown, what you expected and your source. Data
  problems (a stale series, a revised print, a unit mix-up) are the bugs that
  matter most here.
- **Something is broken.** Open a
  [bug report](../../issues/new?template=bug_report.yml): what you did, what
  happened, and your browser or Node version.
- **An idea for a signal or feature.** Open an
  [idea](../../issues/new?template=idea.yml). Read "How new signals are
  judged" below first.

For a security problem, don't open a public issue: see
[`SECURITY.md`](SECURITY.md).

## How new signals are judged

Every signal has to earn its place. Before a new indicator or flag ships, it
needs:

1. **A decision it informs.** "Interesting to track" isn't enough; say which
   existing reading or decision it would change.
2. **A base rate and a forward edge,** measured on real history, ideally out
   of sample. A flag that fires as often before rallies as before selloffs
   doesn't help.
3. **A check that it isn't already covered.** Several ideas have been tested
   and rejected, with the evidence kept so they aren't re-proposed. Look in
   "Investigated and rejected" in
   [`crash-check-rules.md`](reference_docs/rules/crash-check-rules.md) and in
   [`hazard-model-rebuild-brief.md`](reference_docs/hazard-model-rebuild-brief.md).

An idea that fails these tests is still a useful contribution: it gets
written down as rejected, with the reason.

## Pull requests

Please open an issue first so we can agree on the change before you spend
time on it. Then:

- Work inside one package (`ingestion/`, `rule_engine/` or `mcp_server/`);
  each has its own `package.json` and there's no root workspace.
- Run `npm run typecheck` in each package you touched, and `npm test` in
  `rule_engine/` and `mcp_server/`.
- Threshold values live in [`config/monitoring.yaml`](config/monitoring.yaml),
  not in code. If you change a band, check `dashboard_site/` too: its chart
  bands are hardcoded.
- The drawdown risk band cutoffs and the scenario prior are frozen. They
  aren't retuned from live results.
- Never commit personal or dollar data. Only the `local_state/*.example.yaml`
  templates are tracked; the real files are gitignored.

[`AGENTS.md`](AGENTS.md) has the full list of cross-file rules (it's written
for coding agents, but it's the most complete checklist for people too).

## Conduct

Be kind and assume good faith. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
