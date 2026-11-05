// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Aggregation, the decision rule and the two report files. The rule is the
// spec's, written once here so the table and the verdict cannot disagree:
// eligible means a distractor accuracy of at least 90 percent (no invention),
// the winner is the eligible strategy with the best accuracy per 1000 tokens
// among those within 5 points of the best absolute accuracy, and a tie goes to
// the lower id (the simpler strategy).
import type { AnswerRecord } from "./types"

export interface Cell {
  strategyId: string
  resumeWeek: number | "all"
  answers: number
  accuracyPct: number
  distractorAccuracyPct: number | null
  distractorCount: number
  meanFedTokens: number
  meanProviderTokens: number | null
  accuracyPer1k: number
  recallAt5: number | null
  mrr: number | null
  meanLatencyMs: number
  totalFedTokens: number
  errors: number
  /** Accuracy per probe kind, the column that showed open loops failing. */
  byKind?: Record<string, { answers: number; accuracyPct: number }>
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Accuracy per probe kind, over the cells a judge actually scored. */
export function accuracyByKind(
  scored: AnswerRecord[],
): Record<string, { answers: number; accuracyPct: number }> {
  const out: Record<string, { answers: number; accuracyPct: number }> = {}
  for (const record of scored) {
    const kind = String(record.probeKind)
    const cell = out[kind] ?? { answers: 0, accuracyPct: 0 }
    cell.answers += 1
    cell.accuracyPct += record.score ?? 0
    out[kind] = cell
  }
  for (const cell of Object.values(out)) {
    cell.accuracyPct = (cell.accuracyPct / (2 * cell.answers)) * 100
  }
  return out
}

export function aggregate(
  records: AnswerRecord[],
  strategyId: string,
  resumeWeek: number | "all",
): Cell {
  // An error cell (an empty final answer, a model call that never succeeded)
  // is counted and shown, but it never lands in an average: a zero token,
  // zero latency failure would otherwise flatter the very strategy it broke.
  const ok = records.filter((r) => !r.error)
  const scored = records.filter((r) => r.score !== null)
  const distractors = scored.filter((r) => r.probeKind === "distractor")
  const accuracyPct =
    scored.length > 0
      ? (scored.reduce((a, r) => a + (r.score ?? 0), 0) / (2 * scored.length)) * 100
      : 0
  const fed = ok.map((r) => r.fedTokensEstimated + r.amortizedGenerationTokens)
  const meanFedTokens = mean(fed)
  const providerValues = ok
    .map((r) => r.fedTokensProvider)
    .filter((v): v is number => typeof v === "number")
  const recalls = ok.map((r) => r.recallAt5).filter((v): v is boolean => v !== null)
  const ranks = ok.map((r) => r.reciprocalRank).filter((v): v is number => v !== null)
  return {
    strategyId,
    resumeWeek,
    answers: records.length,
    accuracyPct,
    distractorAccuracyPct:
      distractors.length > 0
        ? (distractors.reduce((a, r) => a + (r.score ?? 0), 0) / (2 * distractors.length)) * 100
        : null,
    distractorCount: distractors.length,
    meanFedTokens,
    meanProviderTokens: providerValues.length > 0 ? mean(providerValues) : null,
    accuracyPer1k: meanFedTokens > 0 ? accuracyPct / (meanFedTokens / 1000) : 0,
    recallAt5: recalls.length > 0 ? recalls.filter(Boolean).length / recalls.length : null,
    mrr: ranks.length > 0 ? mean(ranks) : null,
    meanLatencyMs: mean(ok.map((r) => r.latencyMs)),
    totalFedTokens: fed.reduce((a, b) => a + b, 0),
    errors: records.filter((r) => r.error).length,
    byKind: accuracyByKind(scored),
  }
}

export interface Decision {
  winner: string | null
  reason: string
  eligible: string[]
  ineligible: { id: string; reason: string }[]
}

export const DISTRACTOR_FLOOR_PCT = 90
export const ACCURACY_WINDOW_POINTS = 5

export function decide(overall: Cell[]): Decision {
  const eligible: Cell[] = []
  const ineligible: { id: string; reason: string }[] = []
  for (const cell of overall) {
    if (cell.answers === 0) {
      ineligible.push({ id: cell.strategyId, reason: "not run" })
      continue
    }
    if (cell.distractorAccuracyPct === null) {
      // No distractors in the probe set: the invention gate could not be
      // measured, so the strategy stays eligible and the report says so.
      eligible.push(cell)
      continue
    }
    if (cell.distractorAccuracyPct < DISTRACTOR_FLOOR_PCT) {
      ineligible.push({
        id: cell.strategyId,
        reason: `distractor accuracy ${cell.distractorAccuracyPct.toFixed(1)} percent is below the ${DISTRACTOR_FLOOR_PCT} percent floor`,
      })
      continue
    }
    eligible.push(cell)
  }
  if (eligible.length === 0) {
    return { winner: null, reason: "no strategy was eligible", eligible: [], ineligible }
  }
  const bestAbsolute = Math.max(...eligible.map((c) => c.accuracyPct))
  const candidates = eligible.filter((c) => c.accuracyPct >= bestAbsolute - ACCURACY_WINDOW_POINTS)
  const bestPer1k = Math.max(...candidates.map((c) => c.accuracyPer1k))
  const winner = candidates
    .filter((c) => c.accuracyPer1k === bestPer1k)
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId))[0] as Cell
  return {
    winner: winner.strategyId,
    reason: `best absolute accuracy ${bestAbsolute.toFixed(1)} percent; ${candidates.length} strategies within ${ACCURACY_WINDOW_POINTS} points; ${winner.strategyId} has the best accuracy per 1000 tokens (${winner.accuracyPer1k.toFixed(2)})`,
    eligible: eligible.map((c) => c.strategyId),
    ineligible,
  }
}

export interface ReportInput {
  answererModelId: string
  answererPath: string
  judgeModelId: string
  judgePath: string
  judgeFallbackReason: string
  corpusDir: string
  corpusHash: string
  corpusRows: number
  probes: number
  probesDerived: boolean
  resumePoints: number[]
  notRun: { strategyId: string; reason: string }[]
  cells: Cell[]
  overall: Cell[]
  decision: Decision
  prompts: { name: string; text: string }[]
  startedAt: string
  durationMs: number
}

function fmt(value: number | null, digits = 1): string {
  if (value === null) return "n/a"
  return value.toFixed(digits)
}

function table(cells: Cell[]): string {
  const header =
    "| Strategy | Resume | Answers | Errors | Accuracy % | Distractor % | Mean fed tokens | Provider input tokens | Accuracy per 1k | Recall at 5 | MRR | Mean latency ms |"
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|"
  const rows = cells.map(
    (c) =>
      `| ${c.strategyId} | ${c.resumeWeek} | ${c.answers} | ${c.errors} | ${fmt(c.accuracyPct)} | ${fmt(c.distractorAccuracyPct)} | ${fmt(c.meanFedTokens, 0)} | ${fmt(c.meanProviderTokens, 0)} | ${fmt(c.accuracyPer1k, 2)} | ${fmt(c.recallAt5 === null ? null : c.recallAt5 * 100)} | ${fmt(c.mrr, 3)} | ${fmt(c.meanLatencyMs, 0)} |`,
  )
  return [header, sep, ...rows].join("\n")
}

/** Strategies down the side, probe kinds across: where a strategy loses. */
export function kindTable(cells: Cell[]): string {
  const kinds = [...new Set(cells.flatMap((c) => Object.keys(c.byKind ?? {})))].sort()
  if (kinds.length === 0) return "no scored answers"
  const header = `| Strategy | ${kinds.map((k) => `${k} %`).join(" | ")} |`
  const sep = `|---|${kinds.map(() => "---").join("|")}|`
  const rows = cells.map((c) => {
    const cellsForKind = kinds.map((k) => {
      const entry = c.byKind?.[k]
      return entry ? `${entry.accuracyPct.toFixed(1)} (n=${entry.answers})` : "n/a"
    })
    return `| ${c.strategyId} | ${cellsForKind.join(" | ")} |`
  })
  return [header, sep, ...rows].join("\n")
}

export function renderReport(input: ReportInput): string {
  const totalTokens = input.cells.reduce((a, c) => a + c.totalFedTokens, 0)
  const lines: (string | null)[] = [
    "# Long context bench",
    "",
    `Run started ${input.startedAt}, took ${(input.durationMs / 1000).toFixed(1)} s.`,
    "",
    "## What ran",
    "",
    `- Answerer: \`${input.answererModelId}\` through the ${input.answererPath} path.`,
    `- Judge: \`${input.judgeModelId}\` through the ${input.judgePath} path.`,
    input.answererPath.includes("Claude Agent SDK")
      ? "- On the SDK path the provider input token column carries the Claude Code CLI's own prefix as well as the strategy's bytes, so the chars/4 column is the comparable one between strategies."
      : null,
    input.judgeFallbackReason ? `- Judge fallback reason: ${input.judgeFallbackReason}` : null,
    `- Corpus: \`${input.corpusDir}\` (hash ${input.corpusHash}), ${input.corpusRows} rows, ${input.probes} probes.`,
    input.probesDerived
      ? "- probes.json was absent: probes were derived from the ledger (all non throwaway items) and the run carries NO distractors, so the distractor gate could not be measured."
      : null,
    `- Resume points: weeks ${input.resumePoints.join(", ")}.`,
    `- Total fed tokens across the run (chars/4 estimate, amortized generation included): ${totalTokens}.`,
    "- Cost estimate: 0 (no price table is wired into this bench; the token totals above are the number that matters).",
    "",
  ]
  if (input.notRun.length > 0) {
    lines.push("## Not run", "")
    for (const n of input.notRun) lines.push(`- ${n.strategyId}: ${n.reason}`)
    lines.push("")
  }
  lines.push("## Per strategy and resume point", "", table(input.cells), "")
  lines.push("## Overall, per strategy", "", table(input.overall), "")
  lines.push("## Accuracy per probe kind, per strategy", "", kindTable(input.overall), "")
  lines.push(
    "## Decision",
    "",
    `Rule: eligible when distractor accuracy is at least ${DISTRACTOR_FLOOR_PCT} percent; the winner is the eligible strategy with the best accuracy per 1000 tokens among those within ${ACCURACY_WINDOW_POINTS} points of the best absolute accuracy; ties go to the lower id.`,
    "",
    `Winner: ${input.decision.winner ?? "none"}`,
    "",
    input.decision.reason,
    "",
  )
  if (input.decision.ineligible.length > 0) {
    lines.push("Ineligible:", "")
    for (const i of input.decision.ineligible) lines.push(`- ${i.id}: ${i.reason}`)
    lines.push("")
  }
  lines.push("## Prompts used, verbatim", "")
  for (const p of input.prompts) {
    lines.push(`### ${p.name}`, "", "```", p.text, "```", "")
  }
  return `${lines.filter((l): l is string => l !== null).join("\n")}\n`
}
