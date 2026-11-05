// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Re-score a finished long context bench run WITHOUT re-running the answerer.
// Used when the Claude Code login judge hit its session limit mid run and left
// cells unscored, or when a run was scored by the Gemini fallback judge and the
// table must be comparable with opus judged runs.
//
//   bun scripts/bench/long-context-rejudge.ts --out <dir> [--all] [--concurrency 3]
//
// Reads <dir>/answers.jsonl, scores every answered cell whose score is null
// (or every cell with --all) through the SDK login ladder ONLY: no Gemini key is
// passed, so a refused login stops the script instead of spending on the
// provider. Writes answers.jsonl back in place and <dir>/report-rejudged.md.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createJudge } from "../../apps/api/src/tests/bench/long-context/judge"
import {
  accuracyByKind,
  aggregate,
  decide,
  kindTable,
} from "../../apps/api/src/tests/bench/long-context/report"
import { loadExisting, pool, withRetry } from "../../apps/api/src/tests/bench/long-context/run"
import type { AnswerRecord } from "../../apps/api/src/tests/bench/long-context/types"

function arg(name: string, fallback?: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  return fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

async function main(): Promise<void> {
  const outDir = arg("out")
  if (!outDir) throw new Error("usage: --out <dir> [--all] [--concurrency 3]")
  const all = flag("all")
  const concurrency = Number(arg("concurrency", "3"))
  const answersPath = join(outDir, "answers.jsonl")
  const existing = loadExisting(answersPath)
  const records = [...existing.values()]

  const judge = await createJudge({ geminiApiKey: null })
  if (judge.path !== "sdk-login") {
    throw new Error(`no SDK login judge available: ${judge.fallbackReason}`)
  }
  const targets = records.filter(
    (r) => !r.error && r.answer.trim().length > 0 && (all || r.score === null),
  )
  console.log(`rejudge: ${targets.length} of ${records.length} cells with ${judge.modelId}`)

  let done = 0
  const flush = (): void => {
    writeFileSync(answersPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  }
  await pool(
    targets.map((record) => async () => {
      try {
        const score = await withRetry(() =>
          judge.score({
            question: record.question,
            expected: record.expected,
            answer: record.answer,
            kind: record.probeKind,
          }),
        )
        record.score = score
        record.judgeModel = judge.modelId
      } catch (error) {
        console.log(`unscored ${record.key}: ${(error as Error).message.slice(0, 120)}`)
      }
      done += 1
      if (done % 25 === 0) {
        flush()
        console.log(`rejudge: ${done}/${targets.length}`)
      }
    }),
    concurrency,
  )
  flush()

  const strategyIds = [...new Set(records.map((r) => r.strategyId))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  )
  const weeks = [...new Set(records.map((r) => r.resumeWeek))].sort((a, b) => a - b)
  const cells = strategyIds.flatMap((id) =>
    weeks
      .map((week) => records.filter((r) => r.strategyId === id && r.resumeWeek === week))
      .filter((slice) => slice.length > 0)
      .map((slice) => aggregate(slice, id, slice[0]!.resumeWeek)),
  )
  const overall = strategyIds.map((id) =>
    aggregate(
      records.filter((r) => r.strategyId === id),
      id,
      "all",
    ),
  )
  for (const cell of overall) {
    cell.byKind = accuracyByKind(
      records.filter((r) => r.strategyId === cell.strategyId && r.score !== null),
    )
  }
  const decision = decide(overall)
  const unscored = records.filter((r) => !r.error && r.score === null).length
  const judged = [...new Set(records.map((r) => r.judgeModel).filter(Boolean))].join(", ")
  const fmt = (v: number | null, d = 1): string => (v === null ? "n/a" : v.toFixed(d))
  const table = (rows: typeof cells): string =>
    [
      "| Strategy | Resume | Answers | Errors | Accuracy % | Distractor % | Mean fed tokens | Provider input tokens | Accuracy per 1k | Recall at 5 | MRR | Mean latency ms |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map(
        (c) =>
          `| ${c.strategyId} | ${c.resumeWeek} | ${c.answers} | ${c.errors} | ${fmt(c.accuracyPct)} | ${fmt(c.distractorAccuracyPct)} | ${fmt(c.meanFedTokens, 0)} | ${fmt(c.meanProviderTokens, 0)} | ${fmt(c.accuracyPer1k, 2)} | ${fmt(c.recallAt5 === null ? null : c.recallAt5 * 100)} | ${fmt(c.mrr, 3)} | ${fmt(c.meanLatencyMs, 0)} |`,
      ),
    ].join("\n")
  const report = [
    "# Long context bench, re-judged",
    "",
    `- Judge models on file: ${judged}`,
    `- Re-judged now: ${targets.length} cells with ${judge.modelId}; still unscored: ${unscored}`,
    `- Source: ${answersPath}`,
    "",
    "## Per strategy and resume point",
    table(cells),
    "",
    "## Overall, per strategy",
    table(overall),
    "",
    "## Accuracy per probe kind, per strategy",
    kindTable(overall),
    "",
    "## Decision",
    "```json",
    JSON.stringify(decision, null, 2),
    "```",
    "",
  ].join("\n")
  writeFileSync(join(outDir, "report-rejudged.md"), report)
  console.log(readFileSync(join(outDir, "report-rejudged.md"), "utf8"))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
