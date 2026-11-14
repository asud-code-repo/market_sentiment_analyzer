// Public monitoring thresholds from config/monitoring.yaml, the same file
// rule_engine reads (each package has its own small loader, per this repo's
// no-shared-package convention; the file itself is the single source).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { z } from "zod";

export const MONITORING_CONFIG_PATH = fileURLToPath(new URL("../../../config/monitoring.yaml", import.meta.url));

const Band = z
  .object({ amber_from: z.number(), red_above: z.number() })
  .strict()
  .refine((b) => b.amber_from < b.red_above, "amber_from must be below red_above");

const MonitoringSchema = z
  .object({
    schema_version: z.literal(1),
    panel_bands: z
      .object({ vix: Band, hy_spread: Band, sp_drawdown: Band, treasury_10y: Band, sahm_rule: Band })
      .strict(),
    confirmation_required_days: z.number().int().min(1),
    stress_gate_confirmed_reds: z.number().int().min(1).max(6),
    push_alert_confirmed_reds: z.number().int().min(1).max(6),
  })
  .strict();

export type MonitoringConfig = z.infer<typeof MonitoringSchema>;

export function loadMonitoringConfig(path = MONITORING_CONFIG_PATH): MonitoringConfig {
  const result = MonitoringSchema.safeParse(load(readFileSync(path, "utf-8")));
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${path} is invalid — ${problems.join("; ")}`);
  }
  return result.data;
}
