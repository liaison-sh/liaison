// SPDX-License-Identifier: FSL-1.1-ALv2
//
// metrics_list / metrics_run — the kpi-grammar analogues for the native
// metrics registry (§2.1). metrics_list mirrors kpi_list_metrics (registry
// id/version/title/inputs/caveats/provisional); metrics_run mirrors kpi_run
// (computes a result for a period, value as a fixed-format string +
// formulaId + formulaVersion + lineage + caveats). Both pure reads (manifest
// readOnly): computation is deterministic handler code over the in-code
// registry, and nothing is written. They used to seed the metric_formulas
// table on every call, which nothing read; that write made them parse as
// writes, so every scheduled review parked them for approval.

import { METRIC_FORMULAS, getFormula } from "./registry"
import { gatherAllInputs, type MetricsInputCtx, type Period } from "./inputs"

// ─── metrics_list ────────────────────────────────────────────────────────────

export async function metrics_list(_params: unknown, _ctx: MetricsInputCtx): Promise<unknown> {
  return {
    formulas: METRIC_FORMULAS.map((f) => ({
      id: f.id,
      version: f.version,
      title: f.title,
      inputs: f.inputs,
      caveats: f.caveats,
      provisional: Boolean(f.provisional),
    })),
    count: METRIC_FORMULAS.length,
  }
}

// ─── metrics_run ─────────────────────────────────────────────────────────────

interface MetricsRunParams {
  formula_id: string
  period_start: string
  period_end: string
}

export async function metrics_run(params: unknown, ctx: MetricsInputCtx): Promise<unknown> {
  const p = params as MetricsRunParams & Record<string, unknown>
  const formulaId = String(p.formula_id ?? "")
  const formula = getFormula(formulaId)
  if (!formula) {
    throw new Error(
      `metrics_run: unknown formula_id "${formulaId}". Call metrics_list for the registry of available formulas`,
    )
  }

  const periodStart = String(p.period_start ?? "")
  const periodEnd = String(p.period_end ?? "")
  if (!periodStart || !periodEnd) {
    throw new Error("metrics_run: period_start and period_end are required (YYYY-MM-DD)")
  }
  const period: Period = { start: periodStart, end: periodEnd }

  const inputs = await gatherAllInputs(ctx, period)
  const result = formula.compute(inputs, period)

  return result
}
