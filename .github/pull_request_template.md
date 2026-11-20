## What and why

<!-- What does this change, and which issue does it address? -->

## Checklist

- [ ] Discussed in an issue first (link it above)
- [ ] `npm run typecheck` passes in each package touched
- [ ] `npm test` passes in `rule_engine/` and `mcp_server/` (if touched)
- [ ] Thresholds changed only in `config/monitoring.yaml`, and `dashboard_site/` hardcoded bands checked if a band moved
- [ ] No personal or dollar data, keys or tokens in the diff
- [ ] Docs updated if behaviour changed (`README.md`, `reference_docs/rules/crash-check-rules.md`)
