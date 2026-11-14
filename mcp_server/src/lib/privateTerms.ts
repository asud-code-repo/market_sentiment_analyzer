// Guardrail for text written to the PUBLIC crash_checks row (notes,
// delta_log, trigger notes, conditional scenarios). Complements the
// dollar-figure check in portfolio.ts: that one stops amounts, this one
// stops account and watchlist details (e.g. "Watchlist: all WAIT except
// ...", a brokerage-window product name). The terms come from
// local_state/policy.yaml `private_terms`, so the list itself stays private.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Terms from `terms` found in `text` as whole words/phrases, case-insensitive. */
export function findPrivateTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}($|[^A-Za-z0-9])`, "i").test(text));
}
