// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scale bench (spec-context-bench.md, "Phase 3: the scale bench").
//
// Phase 1 and 2 ask how well a strategy answers. This asks what happens at six
// months: the same corpus grown to 100k, 1M and 10M tokens by the generator
// next door, then measured on index cost, search latency, fed tokens, cold
// resume cost, needle at depth and memory. No model authors anything at scale:
// the generator is pure, the summarizer used for the flatness measurements is
// a counting stub, and a live answerer runs only when one is asked for.
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type BenchDoc, Bm25Index, buildDocs, tokenize } from "./bm25"
import { BRIEF_TOKEN_CAP, buildIncrementalBrief } from "./brief"
import { loadCorpus, parseMessagesJsonl } from "./corpus"
import { buildEmbeddingLeg, type EmbeddingLeg } from "./embeddings"
import { fuse } from "./rrf"
import { runBench } from "./run"
import { generateScaledThread } from "./scale-generator"
import { buildStrategies, fedTokens } from "./strategies"
import { estimateTokens } from "./tokens"
import type { Corpus, CorpusRow, HistoryStrategy, Hit, Probe, StrategyCtx } from "./types"

/** Queries timed per size: the probe questions plus random transcript windows. */
export const TOTAL_QUERIES = 200
export const RANDOM_QUERIES = 160
/** Rows one simulated checkpoint advance adds. */
export const ADVANCE_ROWS = 40
export const ADVANCE_COUNT = 5
/** How flat "flat" is, per the spec's scale properties. */
export const FLAT_TOLERANCE_PCT = 5

/** `100k`, `1m`, `10m` and plain digits, in chars/4 tokens. */
export function parseSize(label: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(label.trim())
  if (!match) throw new Error(`unreadable size: ${label}`)
  const value = Number(match[1])
  const suffix = (match[2] ?? "").toLowerCase()
  return Math.round(value * (suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1))
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

export interface Flatness {
  min: number
  max: number
  spreadPct: number
  flat: boolean
}

/**
 * The spec's flatness test: a series is flat when max minus min is under
 * FLAT_TOLERANCE_PCT of the max. An empty or single point series is flat by
 * definition and says so through `min === max`.
 */
export function flatness(values: number[], tolerancePct = FLAT_TOLERANCE_PCT): Flatness {
  if (values.length === 0) return { min: 0, max: 0, spreadPct: 0, flat: true }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spreadPct = max > 0 ? ((max - min) / max) * 100 : 0
  return { min, max, spreadPct, flat: spreadPct <= tolerancePct }
}

/** Read a generated thread back from disk, one line at a time. */
export function readThread(path: string): CorpusRow[] {
  return parseMessagesJsonl(readFileSync(path, "utf8"))
}

/**
 * The BM25 postings, written to disk so "index size" is a measured file and
 * not an estimate. It is written in batches: a 10M token thread's postings
 * do not fit comfortably in one JSON string.
 */
export function writePostings(docs: BenchDoc[], path: string): number {
  const postings = new Map<string, number[]>()
  docs.forEach((doc, index) => {
    const counts = new Map<string, number>()
    for (const term of tokenize(doc.text)) counts.set(term, (counts.get(term) ?? 0) + 1)
    for (const [term, tf] of counts) {
      let list = postings.get(term)
      if (!list) {
        list = []
        postings.set(term, list)
      }
      list.push(index, tf)
    }
  })
  // Written in large batches with appendFileSync rather than through a write
  // stream: a stream needs a drain listener per write, and a 10M token thread
  // has millions of them.
  rmSync(path, { force: true })
  const FLUSH_BYTES = 4 * 1024 * 1024
  let buffer = `{"docs":${docs.length},"terms":${postings.size},"postings":{`
  let first = true
  for (const [term, list] of postings) {
    buffer += `${first ? "" : ","}${JSON.stringify(term)}:[${list.join(",")}]`
    first = false
    if (buffer.length >= FLUSH_BYTES) {
      appendFileSync(path, buffer)
      buffer = ""
    }
  }
  appendFileSync(path, `${buffer}}}\n`)
  return statSync(path).size
}

/** A deterministic set of query windows drawn from the transcript. */
export function randomWindowQueries(rows: CorpusRow[], count: number, seed: number): string[] {
  const queries: string[] = []
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  for (let i = 0; i < count; i++) {
    const start = Math.floor(next() * Math.max(1, rows.length - 3))
    const window = rows
      .slice(start, start + 3)
      .map((r) => r.content)
      .join(" ")
    const words = window.split(/\s+/).filter(Boolean)
    const from = Math.floor(next() * Math.max(1, words.length - 8))
    queries.push(words.slice(from, from + 8).join(" ") || "shipment status")
  }
  return queries
}

/** A five section brief of a fixed size, so the stub never grows a measurement. */
const STUB_BRIEF = [
  "### Current decisions",
  "- the decision stands [m00001]",
  "### Open loops",
  "- one loop is open [m00002]",
  "### Identifiers and entities",
  "- one identifier [m00003]",
  "### Standing procedures",
  "- one procedure [m00004]",
  "### Unresolved contradictions",
  "- none",
].join("\n")

export interface SummarySink {
  calls: number
  /** Input tokens per call, in call order. */
  perCall: number[]
}

/** The summarizer the flatness measurements use: it counts, it calls nothing. */
export function countingSummarizer(sink: SummarySink) {
  return async (prompt: string, text: string): Promise<{ text: string; tokens: number }> => {
    const tokens = estimateTokens(prompt) + estimateTokens(text)
    sink.calls++
    sink.perCall.push(tokens)
    return { text: STUB_BRIEF, tokens }
  }
}

/** Counts every indexed read of the row array, so a history scan cannot hide. */
export function countingRows(rows: CorpusRow[], counter: { reads: number }): CorpusRow[] {
  return new Proxy(rows, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) counter.reads++
      return Reflect.get(target, prop, receiver)
    },
  }) as CorpusRow[]
}

/** Peak resident set size over the life of a size's measurement. */
export class RssSampler {
  private peak = process.memoryUsage().rss
  private readonly timer: ReturnType<typeof setInterval>
  constructor(intervalMs = 250) {
    this.timer = setInterval(() => {
      this.peak = Math.max(this.peak, process.memoryUsage().rss)
    }, intervalMs)
    this.timer.unref?.()
  }
  stop(): number {
    clearInterval(this.timer)
    this.peak = Math.max(this.peak, process.memoryUsage().rss)
    return this.peak
  }
}

export interface LegLatency {
  p50Ms: number
  p95Ms: number
  queries: number
}

export interface NeedleScore {
  probes: number
  recallAt5: number
  mrr: number
}

export interface SizeRow {
  label: string
  targetTokens: number
  rows: number
  tokens: number
  copies: number
  decoyCopies: number
  droppedPerCopy: number
  finalWeek: number
  bm25BuildMs: number
  bm25IndexBytes: number
  bm25Docs: number
  embeddingBuildMs: number | null
  embeddingVectors: number | null
  embeddingBytes: number | null
  embeddingSkipped: string | null
  latency: { bm25: LegLatency; embedding: LegLatency | null; fused: LegLatency | null }
  meanFedTokens: number
  fedTokenSamples: number
  /** Rows the assembler read at resume time, tail and recall aside. */
  resumeRowReads: number
  /** Rows the strategy actually fed: the tail plus the recall hits. */
  fedRows: number
  advanceTokens: number[]
  meanAdvanceTokens: number
  needle: { bm25: NeedleScore; embedding: NeedleScore | null; fused: NeedleScore | null }
  rssPeakBytes: number
  generateMs: number
  accuracyPct: number | null
  accuracyReportPath: string | null
  strategyNote: string | null
}

export interface ScaleOptions {
  corpusDir: string
  outDir: string
  /** Size labels, in the order they are measured. */
  sizes: string[]
  strategyId: string
  /** null runs no live model at all. */
  answerer: "gemini" | "sdk" | null
  probeLimit?: number
  seed?: number
  decoyRatio?: number
  /** Make the probed facts unique in the thread: see the generator. */
  dropNeedles?: boolean
  noEmbeddings?: boolean
  embeddingCacheDir?: string
  modelId?: string
  concurrency?: number
  /** Keep the generated threads and postings on disk after the run. */
  keepArtifacts?: boolean
}

/** The proof row ids of one probe, from the corpus's proof map. */
export function proofIdsFromMap(
  proofMap: Record<string, { messageId?: string }>,
  probe: Probe,
): string[] {
  if (!probe.ledger_id) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(proofMap)) {
    if (key.startsWith(`${probe.ledger_id}:`) && value?.messageId) out.push(value.messageId)
  }
  return out
}

function scoreNeedle(hitsByProbe: { hits: Hit[]; proofIds: Set<string> }[]): NeedleScore {
  if (hitsByProbe.length === 0) return { probes: 0, recallAt5: 0, mrr: 0 }
  let recalled = 0
  let rankSum = 0
  for (const entry of hitsByProbe) {
    const top = entry.hits.slice(0, 5)
    const rank = top.findIndex((h) => h.rowIds.some((id) => entry.proofIds.has(id)))
    if (rank >= 0) {
      recalled++
      rankSum += 1 / (rank + 1)
    }
  }
  return {
    probes: hitsByProbe.length,
    recallAt5: recalled / hitsByProbe.length,
    mrr: rankSum / hitsByProbe.length,
  }
}

/**
 * The strategy whose fed shape is measured. `--no-embeddings` cannot run a
 * hybrid strategy, so it measures the keyword twin instead and the report says
 * which: S3 feeds the same brief, the same recall cap and the same tail as S4,
 * and the leg that ranked does not change a fed token count.
 */
export function resolveStrategy(params: { strategyId: string; embeddingApiKey: string | null }): {
  strategy: HistoryStrategy
  note: string | null
} {
  const all = buildStrategies({ embeddingApiKey: params.embeddingApiKey })
  const wanted = all.find((s) => s.id === params.strategyId)
  if (!wanted) throw new Error(`unknown strategy: ${params.strategyId}`)
  if (params.embeddingApiKey) return { strategy: wanted, note: null }
  const hybrid = ["S4", "S5", "S6", "S7", "S8", "S9", "S10"].includes(params.strategyId)
  if (!hybrid) return { strategy: wanted, note: null }
  const twin = all.find((s) => s.id === "S3") as HistoryStrategy
  return {
    strategy: twin,
    note: `${params.strategyId} needs the embedding leg; the fed shape was measured through S3, its keyword twin (same brief cap, same recall cap, same tail)`,
  }
}

async function measureFedTokens(params: {
  strategy: HistoryStrategy
  rows: CorpusRow[]
  probes: Probe[]
  resumeWeek: number
  outDir: string
  corpusHash: string
}): Promise<{ meanFedTokens: number; samples: number; resumeRowReads: number; fedRows: number }> {
  const sink: SummarySink = { calls: 0, perCall: [] }
  const memo = new Map<string, Promise<unknown>>()
  const base = {
    resumeWeek: params.resumeWeek,
    summarize: countingSummarizer(sink),
    memo,
    outDir: params.outDir,
    corpusHash: params.corpusHash,
  }
  const totals: number[] = []
  let fedRows = 0
  for (const probe of params.probes) {
    const ctx: StrategyCtx = { ...base, rows: params.rows, question: probe.question }
    const assembled = await params.strategy.assemble(ctx)
    totals.push(fedTokens(assembled, 0))
    const tailRows = assembled.tail ? assembled.tail.split("\n").length : 0
    const recallRows = new Set(assembled.hits.slice(0, 5).flatMap((h) => h.rowIds)).size
    fedRows = Math.max(fedRows, tailRows + recallRows)
  }
  // The brief and the index are checkpoint artifacts, built once and memoized
  // above. This second pass is the COLD RESUME itself: with them in hand, how
  // many transcript rows does the assembler still have to read?
  const counter = { reads: 0 }
  const firstProbe = params.probes[0] as Probe
  await params.strategy.assemble({
    ...base,
    rows: countingRows(params.rows, counter),
    question: firstProbe.question,
  })
  return {
    meanFedTokens: totals.reduce((a, b) => a + b, 0) / Math.max(1, totals.length),
    samples: totals.length,
    resumeRowReads: counter.reads,
    fedRows,
  }
}

/**
 * Five checkpoint advances at the very end of the thread, through the real
 * incremental brief path with the counting stub in place of a model. What is
 * measured is the input the summarizer is handed per advance: it must be a
 * function of the new rows and the carried brief, never of the thread.
 */
export async function measureAdvances(rows: CorpusRow[]): Promise<number[]> {
  const window = rows.slice(-ADVANCE_ROWS * ADVANCE_COUNT)
  if (window.length === 0) return []
  // The window is re weeked into ADVANCE_COUNT synthetic weeks so the
  // incremental path treats each chunk as one checkpoint and carries the
  // brief from one to the next exactly as a live conversation would.
  const chunkSize = Math.max(1, Math.ceil(window.length / ADVANCE_COUNT))
  const reweeked = window.map((row, index) => ({
    ...row,
    week: Math.floor(index / chunkSize) + 1,
  }))
  const sink: SummarySink = { calls: 0, perCall: [] }
  await buildIncrementalBrief({
    rows: reweeked,
    throughWeek: ADVANCE_COUNT,
    summarize: countingSummarizer(sink),
    cap: BRIEF_TOKEN_CAP,
  })
  return sink.perCall
}

export interface ScaleResult {
  reportPath: string
  jsonPath: string
  rows: SizeRow[]
  verdicts: Verdict[]
}

export interface Verdict {
  property: string
  pass: boolean
  detail: string
}

async function measureSize(params: {
  options: ScaleOptions
  label: string
  original: Corpus
  proofMap: Record<string, { messageId?: string }>
  googleKey: string | null
}): Promise<SizeRow> {
  const { options, label } = params
  const targetTokens = parseSize(label)
  const sampler = new RssSampler()
  const sizeDir = join(options.outDir, `size-${label}`)
  mkdirSync(sizeDir, { recursive: true })
  const threadPath = join(options.outDir, `thread-${label}.jsonl`)

  const genStarted = Date.now()
  const generated = generateScaledThread({
    corpusDir: options.corpusDir,
    targetTokens,
    seed: options.seed,
    decoyRatio: options.decoyRatio,
    dropNeedles: options.dropNeedles,
    threadPath,
    corpusOutDir: join(sizeDir, "corpus"),
  })
  const generateMs = Date.now() - genStarted

  const rows = readThread(threadPath)
  // The embedding cache is keyed by the CONTENT of the generated thread, not
  // by its row count: two modes of the generator can produce the same number
  // of rows with different wording, and a count keyed cache would hand the
  // second run the first run's vectors.
  const threadHash = createHash("sha256")
    .update(readFileSync(threadPath))
    .digest("hex")
    .slice(0, 16)
  const corpusHash = `scale-${label}-${threadHash}`
  const docs = buildDocs(rows)
  const bm25Started = Date.now()
  const bm25 = new Bm25Index(docs)
  const bm25BuildMs = Date.now() - bm25Started
  const postingsPath = join(sizeDir, "bm25-postings.json")
  const bm25IndexBytes = writePostings(docs, postingsPath)
  if (!options.keepArtifacts) rmSync(postingsPath, { force: true })

  let leg: EmbeddingLeg | null = null
  let embeddingBuildMs: number | null = null
  let embeddingVectors: number | null = null
  let embeddingBytes: number | null = null
  let embeddingSkipped: string | null = null
  if (options.noEmbeddings) {
    embeddingSkipped = "--no-embeddings"
  } else if (!params.googleKey) {
    embeddingSkipped = "no GOOGLE_API_KEY"
  } else {
    const cacheDir = options.embeddingCacheDir ?? options.outDir
    const started = Date.now()
    try {
      leg = await buildEmbeddingLeg({
        docs,
        outDir: cacheDir,
        corpusHash,
        apiKey: params.googleKey,
      })
      embeddingBuildMs = Date.now() - started
      const cachePath = join(cacheDir, "embedding-cache", `${corpusHash}-${leg.modelId}.json`)
      embeddingBytes = statSync(cachePath).size
      embeddingVectors = docs.length
    } catch (err) {
      embeddingSkipped = `the embedding leg failed: ${String(err).slice(0, 160)}`
      leg = null
    }
  }

  const probeQuestions = params.original.probes
    .slice(0, TOTAL_QUERIES - RANDOM_QUERIES)
    .map((p) => p.question)
  const queries = [
    ...probeQuestions,
    ...randomWindowQueries(rows, TOTAL_QUERIES - probeQuestions.length, options.seed ?? 20260915),
  ]
  const bm25Ms: number[] = []
  const embMs: number[] = []
  const fusedMs: number[] = []
  for (const query of queries) {
    const t0 = performance.now()
    const keyword = bm25.search(query, 20)
    const t1 = performance.now()
    bm25Ms.push(t1 - t0)
    if (!leg) continue
    const vector = await leg.search(query, 20)
    const t2 = performance.now()
    embMs.push(t2 - t1)
    fuse([keyword, vector]).slice(0, 5)
    fusedMs.push(performance.now() - t0)
  }
  const latencyOf = (values: number[]): LegLatency => ({
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    queries: values.length,
  })

  const needleProbes = params.original.probes
    .map((probe) => ({ probe, proofIds: new Set(proofIdsFromMap(params.proofMap, probe)) }))
    .filter((entry) => entry.proofIds.size > 0)
  const bm25Needle: { hits: Hit[]; proofIds: Set<string> }[] = []
  const embNeedle: { hits: Hit[]; proofIds: Set<string> }[] = []
  const fusedNeedle: { hits: Hit[]; proofIds: Set<string> }[] = []
  for (const entry of needleProbes) {
    const keyword = bm25.search(entry.probe.question, 20)
    bm25Needle.push({ hits: keyword, proofIds: entry.proofIds })
    if (!leg) continue
    const vector = await leg.search(entry.probe.question, 20)
    embNeedle.push({ hits: vector, proofIds: entry.proofIds })
    fusedNeedle.push({ hits: fuse([keyword, vector]), proofIds: entry.proofIds })
  }

  const resolved = resolveStrategy({
    strategyId: options.strategyId,
    embeddingApiKey: leg ? params.googleKey : null,
  })
  const probeLimit = options.probeLimit ?? 40
  const fed = await measureFedTokens({
    strategy: resolved.strategy,
    rows,
    probes: params.original.probes.slice(0, probeLimit),
    resumeWeek: generated.finalWeek,
    outDir: options.embeddingCacheDir ?? options.outDir,
    corpusHash,
  })
  const advanceTokens = await measureAdvances(rows)

  let accuracyPct: number | null = null
  let accuracyReportPath: string | null = null
  if (options.answerer) {
    const accDir = join(sizeDir, "accuracy")
    await runBench({
      corpusDir: generated.corpusDir as string,
      outDir: accDir,
      strategyIds: [options.strategyId],
      answerer: options.answerer,
      resumePoints: [generated.finalWeek],
      modelId: options.modelId,
      concurrency: options.concurrency,
      probeLimit,
      embeddingCacheDir: options.embeddingCacheDir,
    })
    accuracyReportPath = join(accDir, "report.md")
    try {
      const parsed = JSON.parse(readFileSync(join(accDir, "report.json"), "utf8")) as {
        overall: { strategyId: string; accuracyPct: number }[]
      }
      accuracyPct =
        parsed.overall.find((c) => c.strategyId === options.strategyId)?.accuracyPct ?? null
    } catch {
      accuracyPct = null
    }
  }

  if (!options.keepArtifacts) rmSync(threadPath, { force: true })
  const rssPeakBytes = sampler.stop()

  return {
    label,
    targetTokens,
    rows: generated.rows,
    tokens: generated.tokens,
    copies: generated.copies,
    decoyCopies: generated.decoyCopies,
    droppedPerCopy: generated.droppedPerCopy,
    finalWeek: generated.finalWeek,
    bm25BuildMs,
    bm25IndexBytes,
    bm25Docs: docs.length,
    embeddingBuildMs,
    embeddingVectors,
    embeddingBytes,
    embeddingSkipped,
    latency: {
      bm25: latencyOf(bm25Ms),
      embedding: leg ? latencyOf(embMs) : null,
      fused: leg ? latencyOf(fusedMs) : null,
    },
    meanFedTokens: fed.meanFedTokens,
    fedTokenSamples: fed.samples,
    resumeRowReads: fed.resumeRowReads,
    fedRows: fed.fedRows,
    advanceTokens,
    meanAdvanceTokens:
      advanceTokens.length > 0
        ? advanceTokens.reduce((a, b) => a + b, 0) / advanceTokens.length
        : 0,
    needle: {
      bm25: scoreNeedle(bm25Needle),
      embedding: leg ? scoreNeedle(embNeedle) : null,
      fused: leg ? scoreNeedle(fusedNeedle) : null,
    },
    rssPeakBytes,
    generateMs,
    accuracyPct,
    accuracyReportPath,
    strategyNote: resolved.note,
  }
}

/** The spec's three scale properties, reduced to pass or fail. */
export function judgeScale(rows: SizeRow[]): Verdict[] {
  const fedFlat = flatness(rows.map((r) => r.meanFedTokens))
  const advanceFlat = flatness(rows.map((r) => r.meanAdvanceTokens))
  const proportional = rows.filter((r) => r.resumeRowReads > r.fedRows)
  return [
    {
      property: "fed tokens per turn are flat across sizes",
      pass: fedFlat.flat,
      detail: `min ${Math.round(fedFlat.min)}, max ${Math.round(fedFlat.max)}, spread ${fedFlat.spreadPct.toFixed(2)} percent (tolerance ${FLAT_TOLERANCE_PCT} percent)`,
    },
    {
      property: "tokens summarized per checkpoint advance are flat across sizes",
      pass: advanceFlat.flat,
      detail: `min ${Math.round(advanceFlat.min)}, max ${Math.round(advanceFlat.max)}, spread ${advanceFlat.spreadPct.toFixed(2)} percent (tolerance ${FLAT_TOLERANCE_PCT} percent)`,
    },
    {
      property: "no history load proportional to thread size",
      pass: proportional.length === 0,
      detail:
        proportional.length === 0
          ? rows
              .map((r) => `${r.label}: ${r.resumeRowReads} rows read at resume, ${r.fedRows} fed`)
              .join("; ")
          : `${proportional.map((r) => r.label).join(", ")} read more rows than they fed`,
    },
  ]
}

function mib(bytes: number | null): string {
  if (bytes === null) return "n/a"
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`
}

export function renderScaleReport(params: {
  options: ScaleOptions
  rows: SizeRow[]
  verdicts: Verdict[]
  corpusHash: string
  startedAt: string
  durationMs: number
}): string {
  const { rows, verdicts } = params
  const lines: string[] = []
  lines.push("# The long context scale bench")
  lines.push("")
  lines.push(`Started ${params.startedAt}, ran ${(params.durationMs / 1000).toFixed(1)} seconds.`)
  lines.push("")
  lines.push(`- Corpus: \`${params.options.corpusDir}\` (hash ${params.corpusHash})`)
  lines.push(`- Strategy: ${params.options.strategyId}`)
  lines.push(`- Decoy ratio: ${params.options.decoyRatio ?? 1}`)
  lines.push(
    params.options.dropNeedles
      ? `- Needles: unique to the original copy (--drop-needles, ${rows[0]?.droppedPerCopy ?? 0} rows dropped per mutated copy)`
      : "- Needles: every copy repeats the fact shapes with its own identifiers",
  )
  lines.push(`- Seed: ${params.options.seed ?? 20260915}`)
  lines.push(
    `- Answerer: ${params.options.answerer ?? "none (no model call, retrieval and assembly only)"}`,
  )
  const note = rows.find((r) => r.strategyNote)?.strategyNote
  if (note) lines.push(`- Note: ${note}`)
  lines.push("")
  lines.push("## Thread and index")
  lines.push("")
  lines.push(
    "| size | rows | tokens | copies | decoys | BM25 docs | index build s | index bytes | embed vectors | embed bytes | RSS peak |",
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${r.rows} | ${r.tokens} | ${r.copies} | ${r.decoyCopies} | ${r.bm25Docs} | ${(r.bm25BuildMs / 1000).toFixed(2)} | ${mib(r.bm25IndexBytes)} | ${r.embeddingVectors ?? "n/a"} | ${mib(r.embeddingBytes)} | ${mib(r.rssPeakBytes)} |`,
    )
  }
  lines.push("")
  lines.push("## Search latency over 200 queries")
  lines.push("")
  lines.push(
    "| size | BM25 p50 ms | BM25 p95 ms | embedding p50 ms | embedding p95 ms | fused p50 ms | fused p95 ms |",
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- |")
  for (const r of rows) {
    const e = r.latency.embedding
    const f = r.latency.fused
    lines.push(
      `| ${r.label} | ${r.latency.bm25.p50Ms.toFixed(1)} | ${r.latency.bm25.p95Ms.toFixed(1)} | ${e ? e.p50Ms.toFixed(1) : "n/a"} | ${e ? e.p95Ms.toFixed(1) : "n/a"} | ${f ? f.p50Ms.toFixed(1) : "n/a"} | ${f ? f.p95Ms.toFixed(1) : "n/a"} |`,
    )
  }
  for (const r of rows) {
    if (r.embeddingSkipped)
      lines.push(`- ${r.label}: embedding leg not run (${r.embeddingSkipped})`)
  }
  lines.push("")
  lines.push("## Fed tokens, cold resume and history reads")
  lines.push("")
  lines.push(
    "| size | mean fed tokens | probes | rows read at resume | rows fed | mean tokens per advance | advances |",
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- |")
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${Math.round(r.meanFedTokens)} | ${r.fedTokenSamples} | ${r.resumeRowReads} | ${r.fedRows} | ${Math.round(r.meanAdvanceTokens)} | ${r.advanceTokens.length} |`,
    )
  }
  lines.push("")
  lines.push("## Needle at depth (the original corpus's probes, at the deepest point)")
  lines.push("")
  lines.push(
    "| size | BM25 recall@5 | BM25 MRR | embedding recall@5 | embedding MRR | fused recall@5 | fused MRR | probes |",
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const r of rows) {
    const e = r.needle.embedding
    const f = r.needle.fused
    lines.push(
      `| ${r.label} | ${pct(r.needle.bm25.recallAt5)} | ${r.needle.bm25.mrr.toFixed(3)} | ${e ? pct(e.recallAt5) : "n/a"} | ${e ? e.mrr.toFixed(3) : "n/a"} | ${f ? pct(f.recallAt5) : "n/a"} | ${f ? f.mrr.toFixed(3) : "n/a"} | ${r.needle.bm25.probes} |`,
    )
  }
  if (rows.some((r) => r.accuracyPct !== null)) {
    lines.push("")
    lines.push("## Accuracy")
    lines.push("")
    lines.push("| size | accuracy | report |")
    lines.push("| --- | --- | --- |")
    for (const r of rows) {
      lines.push(
        `| ${r.label} | ${r.accuracyPct === null ? "n/a" : `${r.accuracyPct.toFixed(1)}%`} | ${r.accuracyReportPath ?? "n/a"} |`,
      )
    }
  }
  lines.push("")
  lines.push("## The three scale properties")
  lines.push("")
  for (const v of verdicts) lines.push(`- ${v.pass ? "PASS" : "FAIL"}: ${v.property}. ${v.detail}`)
  lines.push("")
  lines.push("## How to read this")
  lines.push("")
  lines.push(
    "Rows read at resume counts every indexed read of the transcript array during a cold resume with the brief and the index already checkpointed. It is the falsifiable form of the spec's third property: a strategy that re reads history to answer shows up here as a number that grows with the thread.",
  )
  lines.push("")
  lines.push(
    `Tokens per advance is what the incremental brief path hands its summarizer for one checkpoint of ${ADVANCE_ROWS} new rows, measured with a counting stub in place of a model. The first advance carries an empty brief and the rest carry the capped one, so the series is read for growth across SIZES, not across advances.`,
  )
  lines.push("")
  return `${lines.join("\n")}\n`
}

export async function runScaleBench(options: ScaleOptions): Promise<ScaleResult> {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  mkdirSync(options.outDir, { recursive: true })
  const original = loadCorpus(options.corpusDir)
  let proofMap: Record<string, { messageId?: string }> = {}
  try {
    proofMap = JSON.parse(
      readFileSync(join(options.corpusDir, "proof-map.json"), "utf8"),
    ) as Record<string, { messageId?: string }>
  } catch {
    proofMap = {}
  }
  const googleKey = process.env.GOOGLE_API_KEY?.trim() || null

  const rows: SizeRow[] = []
  for (const label of options.sizes) {
    const row = await measureSize({ options, label, original, proofMap, googleKey })
    rows.push(row)
    // The report is rewritten after every size, so a killed 10M run still
    // leaves the sizes it finished on disk.
    const partial = judgeScale(rows)
    writeFileSync(
      join(options.outDir, "scale-report.md"),
      renderScaleReport({
        options,
        rows,
        verdicts: partial,
        corpusHash: original.hash,
        startedAt,
        durationMs: Date.now() - started,
      }),
    )
    writeFileSync(
      join(options.outDir, "scale-report.json"),
      `${JSON.stringify({ startedAt, corpusHash: original.hash, options: { ...options }, rows, verdicts: partial }, null, 2)}\n`,
    )
  }
  const verdicts = judgeScale(rows)
  const reportPath = join(options.outDir, "scale-report.md")
  const jsonPath = join(options.outDir, "scale-report.json")
  writeFileSync(
    reportPath,
    renderScaleReport({
      options,
      rows,
      verdicts,
      corpusHash: original.hash,
      startedAt,
      durationMs: Date.now() - started,
    }),
  )
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ startedAt, corpusHash: original.hash, options: { ...options }, rows, verdicts }, null, 2)}\n`,
  )
  return { reportPath, jsonPath, rows, verdicts }
}
