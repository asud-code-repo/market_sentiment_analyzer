// The deterministic half of fund-movement math: wave and crash-type
// dollar amounts are computed here, never improvised by an LLM reading the
// rules doc and doing arithmetic in its head.
//
// The percentages are personal policy, so they are NOT in this file: they
// load from local_state/policy.yaml (gitignored, local-only) on every call.
// local_state/policy.example.yaml documents the shape with illustrative
// numbers. A missing or malformed policy is an error, never a silent
// fallback to example values.
//
// Fund descriptions are generic categories, not your actual fund names
// (those live in local_state/deployment_instruments.yaml, keyed by `slot`).
// slot: null marks a hold/remainder line with nothing to buy.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

export type Wave = "WAVE_1" | "WAVE_2" | "WAVE_3";
export type CrashType = "A_STAGFLATION" | "B_RECESSION" | "C_CREDIT" | "D_AI_BUBBLE" | "E_HYBRID";

const SLOT_ID = z.string().regex(/^[a-z0-9_]+$/, "slot ids are lower_snake_case");
const PCT = z.number().gt(0).lte(100);

const WaveDefinitionSchema = z.object({
  pct_of_dry_powder: PCT,
  splits: z
    .array(z.object({ fund: z.string().min(1), pct_of_wave: PCT, slot: SLOT_ID }).strict())
    .min(1)
    .refine((s) => Math.abs(s.reduce((a, x) => a + x.pct_of_wave, 0) - 100) < 0.01, "splits must sum to 100 (pct_of_wave)"),
}).strict();

const CrashTypeLineSchema = z
  .object({
    fund: z.string().min(1),
    slot: SLOT_ID.nullable(),
    pct_of_dry_powder: PCT.nullable(),
    note: z.string().optional(),
  })
  .strict()
  .refine((p) => (p.slot === null) === (p.pct_of_dry_powder === null), "a line needs both a slot and a percentage, or neither (hold line)");

const FastPanicTrigger = z.object({ drawdown_pct_gte: z.number().gt(0).lt(100), vix_gt: z.number().gt(0) }).strict();
const SlowBearTrigger = z.object({ drawdown_pct_gte: z.number().gt(0).lt(100) }).strict();

const WaveTriggersSchema = z
  .object({
    // Same-day: drawdown from the all-time high AND VIX, checked deepest wave first.
    fast_panic: z.object({ WAVE_1: FastPanicTrigger, WAVE_2: FastPanicTrigger, WAVE_3: FastPanicTrigger }).strict(),
    // Drawdown AND a fresh 252-trading-day S&P low within the window,
    // confirmed over config/monitoring.yaml's confirmation_required_days.
    slow_bear: z
      .object({ freshness_window_trading_days: z.number().int().min(1), WAVE_2: SlowBearTrigger, WAVE_3: SlowBearTrigger })
      .strict(),
  })
  .strict()
  .refine(
    (t) =>
      t.fast_panic.WAVE_1.drawdown_pct_gte <= t.fast_panic.WAVE_2.drawdown_pct_gte &&
      t.fast_panic.WAVE_2.drawdown_pct_gte <= t.fast_panic.WAVE_3.drawdown_pct_gte,
    "fast_panic drawdown thresholds must not decrease from WAVE_1 to WAVE_3",
  );

const PolicySchema = z
  .object({
    schema_version: z.literal(1),
    // Behavioral guardrails returned with every deployment plan.
    hard_rules: z.array(z.string().min(1)).min(1),
    // Words/phrases that must never appear in text written to the PUBLIC
    // crash_checks row (account names, "watchlist", ...). Optional.
    private_terms: z.array(z.string().min(1)).default([]),
    wave_triggers: WaveTriggersSchema,
    waves: z.object({ WAVE_1: WaveDefinitionSchema, WAVE_2: WaveDefinitionSchema, WAVE_3: WaveDefinitionSchema }).strict(),
    crash_type_layers: z
      .object({
        A_STAGFLATION: z.array(CrashTypeLineSchema).min(1),
        B_RECESSION: z.array(CrashTypeLineSchema).min(1),
        C_CREDIT: z.array(CrashTypeLineSchema).min(1),
        D_AI_BUBBLE: z.array(CrashTypeLineSchema).min(1),
        E_HYBRID: z.array(CrashTypeLineSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

/** POLICY_PATH if set, otherwise policy.yaml next to PORTFOLIO_PATH (same convention as the other local_state files). */
export function policyPath(): string {
  const explicit = process.env.POLICY_PATH;
  if (explicit) return explicit;
  const portfolio = process.env.PORTFOLIO_PATH;
  if (!portfolio) throw new Error("Neither POLICY_PATH nor PORTFOLIO_PATH is set — see mcp_server/.env.example");
  return join(dirname(portfolio), "policy.yaml");
}

/** Parses + validates a policy document. Throws with every problem listed. */
export function parsePolicy(raw: unknown, source = "policy"): Policy {
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${source} is invalid — ${problems.join("; ")}`);
  }
  return result.data;
}

/** Reads the policy fresh on every call, so edits apply without restarting the MCP server. */
export function loadPolicy(path = policyPath()): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read the deployment policy at ${path} (${(err as Error).message}). ` +
        "Copy local_state/policy.example.yaml to policy.yaml and fill in your own values.",
    );
  }
  return parsePolicy(load(text), path);
}

/** Every registry slot the waves and crash-type layers deploy into. */
export function ruleSlots(policy: Policy = loadPolicy()): string[] {
  return [
    ...new Set([
      ...Object.values(policy.waves).flatMap((w) => w.splits.map((s) => s.slot)),
      ...Object.values(policy.crash_type_layers).flatMap((l) => l.flatMap((p) => (p.slot ? [p.slot] : []))),
    ]),
  ];
}

export interface DollarSplit {
  fund: string;
  slot: string | null;
  usd: number | null;
  note?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeWaveDeployment(
  wave: Wave,
  dryPowderUsd: number,
  policy: Policy = loadPolicy(),
): { pct_of_dry_powder: number; total_usd: number; splits: DollarSplit[] } {
  const def = policy.waves[wave];
  const waveUsd = (def.pct_of_dry_powder / 100) * dryPowderUsd;
  return {
    pct_of_dry_powder: def.pct_of_dry_powder,
    total_usd: round2(waveUsd),
    splits: def.splits.map((s) => ({
      fund: s.fund,
      slot: s.slot,
      usd: round2((s.pct_of_wave / 100) * waveUsd),
    })),
  };
}

export function computeCrashTypeLayer(
  crashType: CrashType,
  dryPowderUsd: number,
  policy: Policy = loadPolicy(),
): DollarSplit[] {
  return policy.crash_type_layers[crashType].map((p) => ({
    fund: p.fund,
    slot: p.slot,
    usd: p.pct_of_dry_powder === null ? null : round2((p.pct_of_dry_powder / 100) * dryPowderUsd),
    note: p.note,
  }));
}
