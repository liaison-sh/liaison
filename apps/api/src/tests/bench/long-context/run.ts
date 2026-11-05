// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The runner. Standalone by construction: a corpus is three files, search is
// in process, and the only calls that leave this machine are the answerer, the
// summarizer and the judge. Partial results are appended to `answers.jsonl` as
// they land, so a killed run resumes by skipping the keys it already has.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createGeminiAnswerer, createSdkAnswerer } from "./answerers"
import { briefPrompt } from "./brief"
import { loadCorpus, proofRowIds, rowsThroughWeek } from "./corpus"
import { createJudge, RUBRIC } from "./judge"
import { aggregate, type Cell, decide, renderReport } from "./report"
import {
  baseSystem,
  buildStrategies,
  composeUser,
  fedTokens,
  GENERIC_SUMMARY_PROMPT,
  NotRunError,
  SEARCH_CHARTER_LINE,
} from "./strategies"
import { estimateTokens } from "./tokens"
import type { Answerer, AnswerRecord, HistoryStrategy, Probe } from "./types"

export interface RunOptions {
  corpusDir: string
  outDir: string
  strategyIds: string[]
  answerer: "gemini" | "sdk"
  resumePoints: number[]
  modelId?: string
  concurrency?: number
  /** Tail budget overrides, for exercising the pipeline on a tiny fixture. */
  smallTailTokens?: number
  bigTailTokens?: number
  /** Run only the first N probes, for a smoke over the real corpus. */
  probeLimit?: number
  /**
   * Where the embedding vectors are cached. Defaults to the out dir, which
   * makes a run self contained; point several runs at one directory and the
   * corpus is embedded once for all of them (the file is keyed by the corpus
   * hash and the model id, so a different corpus never reads another's).
   */
  embeddingCacheDir?: string
  /** Read by tests to inject a stub instead of a live model. */
  answererOverride?: Answerer
  judgeOverride?: {
    modelId: string
    path: "sdk-login" | "provider" | "unavailable"
    fallbackReason: string
    score(req: {
      question: string
      expected: string
      answer: string
      kind: string
    }): Promise<number>
  }
}

/** Retry a model call twice, with a short backoff, then give up on that cell. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof NotRunError) throw err
      lastError = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i))
    }
  }
  throw lastError
}

/** Run `tasks` with at most `limit` in flight, results in input order. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= tasks.length) return
      out[index] = await (tasks[index] as () => Promise<T>)()
    }
  })
  await Promise.all(workers)
  return out
}

export function answerKey(strategyId: string, week: number, probeId: string): string {
  return `${strategyId}|${week}|${probeId}`
}

/** The keys already on disk, so a resumed run does not pay for them twice. */
export function loadExisting(path: string): Map<string, AnswerRecord> {
  const map = new Map<string, AnswerRecord>()
  if (!existsSync(path)) return map
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as AnswerRecord
      if (record.key) map.set(record.key, record)
    } catch {
      // A half written last line after a kill: ignore it and redo that cell.
    }
  }
  return map
}

export function expectedAnswer(probe: Probe, week: number): string {
  if (probe.kind === "distractor") return "never came up"
  return probe.answer_at_week[String(week)] ?? "unknown"
}

export async function runBench(options: RunOptions): Promise<{ reportPath: string }> {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const corpus = loadCorpus(options.corpusDir)
  mkdirSync(options.outDir, { recursive: true })
  const answersPath = join(options.outDir, "answers.jsonl")
  const existing = loadExisting(answersPath)

  const googleKey = process.env.GOOGLE_API_KEY?.trim() || null
  let answerer = options.answererOverride
  if (!answerer) {
    if (options.answerer === "gemini") {
      if (!googleKey) throw new Error("GOOGLE_API_KEY is empty: the gemini answerer cannot run")
      answerer = createGeminiAnswerer({ apiKey: googleKey, modelId: options.modelId })
    } else {
      answerer = createSdkAnswerer({ modelId: options.modelId })
    }
  }
  const judge = options.judgeOverride ?? (await createJudge({ geminiApiKey: googleKey }))

  const all = buildStrategies({
    embeddingApiKey: googleKey,
    smallTailTokens: options.smallTailTokens,
    bigTailTokens: options.bigTailTokens,
  })
  const strategies = options.strategyIds
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is HistoryStrategy => Boolean(s))

  const records: AnswerRecord[] = [...existing.values()]
  const notRun: { strategyId: string; reason: string }[] = []
  const dead = new Map<string, string>()
  const contextDir = join(options.outDir, "context")
  mkdirSync(contextDir, { recursive: true })
  const probes = options.probeLimit ? corpus.probes.slice(0, options.probeLimit) : corpus.probes
  const probeCount = Math.max(1, probes.length)

  // WEEK OUTER, STRATEGY INNER. The memo store lives per resume point rather
  // than per strategy, which is what makes the shared work shared: S3, S4 and
  // S5 read the brief S2 generated, S5 and S6 read the ranking S4 ran. A brief
  // is never generated twice in one run.
  for (const week of options.resumePoints) {
    const rows = rowsThroughWeek(corpus.rows, week)
    const memoStore = new Map<string, Promise<unknown>>()
    const persist = (label: string, text: string, tokens: number): void => {
      writeFileSync(
        join(contextDir, `${label}-week${week}.md`),
        `<!-- ${label}, week ${week}: ${tokens} model tokens to generate, ${estimateTokens(text)} tokens long -->\n\n${text}\n`,
      )
    }

    for (const strategy of strategies) {
      if (dead.has(strategy.id)) continue

      const tasks = probes.map((probe, probeIndex) => async () => {
        const key = answerKey(strategy.id, week, probe.id)
        if (existing.has(key) || dead.has(strategy.id)) return
        const ctx = {
          rows,
          resumeWeek: week,
          question: probe.question,
          summarize: (answerer as Answerer).summarize,
          memo: memoStore,
          outDir: options.embeddingCacheDir ?? options.outDir,
          corpusHash: corpus.hash,
          persist,
        }
        const expected = expectedAnswer(probe, week)
        const fail = (message: string): AnswerRecord => ({
          key,
          strategyId: strategy.id,
          resumeWeek: week,
          probeId: probe.id,
          probeKind: probe.kind,
          question: probe.question,
          expected,
          answer: "",
          fedTokensEstimated: 0,
          fedTokensProvider: null,
          amortizedGenerationTokens: 0,
          toolCalls: 0,
          latencyMs: 0,
          recallAt5: null,
          reciprocalRank: null,
          score: null,
          judgeModel: null,
          error: message.slice(0, 400),
        })
        let record: AnswerRecord
        try {
          const assembled = await withRetry(() => strategy.assemble(ctx))
          const system = [baseSystem(corpus.persona), assembled.systemExtra]
            .filter(Boolean)
            .join("\n")
          const user = composeUser(assembled, probe.question)
          if (probeIndex < 3) {
            // The exact history the model saw, for the first three probes of
            // every strategy, so a number in the table can be read back.
            writeFileSync(
              join(contextDir, `${strategy.id}-week${week}-probe-${probe.id}.txt`),
              `=== system ===\n${system}\n\n=== user ===\n${user}\n`,
            )
          }
          const result = await withRetry(() =>
            (answerer as Answerer).answer({
              system,
              user,
              tools: assembled.tools,
              maxToolCalls: assembled.maxToolCalls,
            }),
          )
          if (!result.text.trim()) {
            // An empty final answer is a harness failure, never a wrong
            // answer: it is recorded as an error cell and never judged.
            record = fail(
              `the answerer returned an empty final answer after ${result.toolCalls} tool calls`,
            )
          } else {
            const ledgerItem = probe.ledger_id
              ? corpus.ledger.find((l) => l.id === probe.ledger_id)
              : undefined
            const proofIds = ledgerItem ? new Set(proofRowIds(rows, ledgerItem.proof_hint)) : null
            let recallAt5: boolean | null = null
            let reciprocalRank: number | null = null
            if (proofIds && proofIds.size > 0) {
              const top = assembled.hits.slice(0, 5)
              const rank = top.findIndex((h) => h.rowIds.some((id) => proofIds.has(id)))
              recallAt5 = rank >= 0
              reciprocalRank = rank >= 0 ? 1 / (rank + 1) : 0
            }
            let score: number | null = null
            try {
              score = await withRetry(() =>
                judge.score({
                  question: probe.question,
                  expected,
                  answer: result.text,
                  kind: probe.kind,
                }),
              )
            } catch {
              // A judge that cannot grade leaves the cell unscored rather than
              // scoring it zero: an ungraded answer is not a wrong answer.
              score = null
            }
            record = {
              key,
              strategyId: strategy.id,
              resumeWeek: week,
              probeId: probe.id,
              probeKind: probe.kind,
              question: probe.question,
              expected,
              answer: result.text,
              fedTokensEstimated: fedTokens(assembled, result.toolPayloadChars),
              fedTokensProvider: result.providerInputTokens,
              amortizedGenerationTokens: assembled.generationTokens / probeCount,
              toolCalls: result.toolCalls,
              latencyMs: result.latencyMs,
              recallAt5,
              reciprocalRank,
              score,
              judgeModel: score === null ? null : judge.modelId,
            }
          }
        } catch (err) {
          if (err instanceof NotRunError) {
            dead.set(strategy.id, err.message)
            return
          }
          record = fail(String(err))
        }
        appendFileSync(answersPath, `${JSON.stringify(record)}\n`)
        existing.set(key, record)
        records.push(record)
      })

      await pool(tasks, options.concurrency ?? 4)
    }
  }
  for (const [strategyId, reason] of dead) notRun.push({ strategyId, reason })

  const cells: Cell[] = []
  for (const strategy of strategies) {
    for (const week of options.resumePoints) {
      const slice = records.filter((r) => r.strategyId === strategy.id && r.resumeWeek === week)
      if (slice.length === 0) continue
      cells.push(aggregate(slice, strategy.id, week))
    }
  }
  const overall = strategies
    .map((s) =>
      aggregate(
        records.filter((r) => r.strategyId === s.id),
        s.id,
        "all",
      ),
    )
    .filter((c) => c.answers > 0)
  const decision = decide(overall)

  const report = renderReport({
    answererModelId: (answerer as Answerer).modelId,
    answererPath:
      options.answerer === "gemini" ? "gemini provider (GOOGLE_API_KEY)" : "Claude Agent SDK login",
    judgeModelId: judge.modelId,
    judgePath: judge.path,
    judgeFallbackReason: judge.fallbackReason,
    corpusDir: options.corpusDir,
    corpusHash: corpus.hash,
    corpusRows: corpus.rows.length,
    probes: probes.length,
    probesDerived: corpus.probesDerived,
    resumePoints: options.resumePoints,
    notRun,
    cells,
    overall,
    decision,
    prompts: [
      { name: "Answerer system prompt (all strategies)", text: baseSystem(corpus.persona) },
      { name: "S5 and S6 search charter line", text: SEARCH_CHARTER_LINE },
      { name: "Generic summary prompt (S0, S1)", text: GENERIC_SUMMARY_PROMPT },
      { name: "Compaction brief prompt (S2 and up)", text: briefPrompt() },
      { name: "Judge rubric", text: RUBRIC },
    ],
    startedAt,
    durationMs: Date.now() - started,
  })
  const reportPath = join(options.outDir, "report.md")
  writeFileSync(reportPath, report)
  writeFileSync(
    join(options.outDir, "report.json"),
    `${JSON.stringify({ startedAt, cells, overall, decision, notRun, answerer: (answerer as Answerer).modelId, judge: judge.modelId, judgePath: judge.path, corpusHash: corpus.hash, probesDerived: corpus.probesDerived }, null, 2)}\n`,
  )
  return { reportPath }
}
