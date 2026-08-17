/**
 * Computes the NY Fed's published Estrella & Mishkin (1998) yield-curve
 * recession-probability model locally, since the NY Fed distributes this
 * only via their own site (no FRED series exists for it — verified before
 * building this, not assumed) while the two inputs it needs (10yr and
 * 3-month Treasury yields) are already on FRED as DGS10/DGS3MO. This is a
 * peer-reviewed, published formula being evaluated exactly as published —
 * not a hand-tuned threshold, and not this project inventing its own
 * probability model.
 *
 * Formula: P(recession in 12mo) = Φ(-0.5333 - 0.6629 × spread), where
 * spread = DGS10 - DGS3MO (percentage points) and Φ is the standard normal
 * CDF. Source: Estrella, A. and Mishkin, F.S. (1998), "Predicting U.S.
 * Recessions: Financial Variables as Leading Indicators," Review of
 * Economics and Statistics — coefficients as published, not refit.
 */

/**
 * Abramowitz & Stegun (1964) formula 7.1.26 — a standard, widely-used
 * approximation of the error function, max absolute error ~1.5e-7. No
 * built-in erf exists in JS; this is the conventional way to get one
 * without a dependency for a single formula.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** spread10y3mo = DGS10 - DGS3MO, in percentage points. Returns a 0-100 percent. */
export function estrellaMishkinRecessionProbability(spread10y3mo: number): number {
  return standardNormalCdf(-0.5333 - 0.6629 * spread10y3mo) * 100;
}
