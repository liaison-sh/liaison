// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The long context bench (spec-context-bench.md): the shared vocabulary.
//
// This tree is a BENCH, not a suite. It touches no database, no Meili and no
// thread service: a corpus is three files on disk, search is in process, and
// the only network calls are the answerer, the summarizer and the judge. It is
// wired into no CI lane on purpose.
import type { z } from "zod"

/** One transcript row of the corpus, in conversation order. */
export interface CorpusRow {
  id: string
  week: number
  ts: string
  authorType: "user" | "agent" | "system"
  author: string
  kind: "message" | "tool_result"
  content: string
}

export type LedgerKind = "fact" | "decision" | "open_loop" | "procedure" | "temporal" | "throwaway"

/** One ground truth item the corpus generator planted. */
export interface LedgerItem {
  id: string
  kind: LedgerKind
  plant_week: number
  supersede_week: number | null
  plant_text: string
  supersede_text: string | null
  question: string
  answer: string
  answer_at_week: Record<string, string>
  proof_hint: string
}

export type ProbeKind = LedgerKind | "distractor"

/** One question asked at every resume point. */
export interface Probe {
  id: string
  kind: ProbeKind
  question: string
  answer_at_week: Record<string, string>
  ledger_id: string | null
}

export interface Corpus {
  /** The persona line of the answerer system prompt (corpus.ts DEFAULT_PERSONA or persona.md). */
  persona: string
  rows: CorpusRow[]
  ledger: LedgerItem[]
  probes: Probe[]
  /** True when probes.json was absent and probes were derived from the ledger. */
  probesDerived: boolean
  /** Stable hash of the transcript, the embedding cache key. */
  hash: string
}

/** One ranked search hit over the transcript. */
export interface Hit {
  /** The row id for a message document, `win:<anchor id>` for a window one. */
  docId: string
  /** Every row id the document covers, so proof matching is exact. */
  rowIds: string[]
  score: number
  snippet: string
  ts: string
  author: string
}

/** A tool the answering model may call. */
export interface BenchTool {
  name: string
  description: string
  /** The argument shape, as the `ai` package and the JSON tool loop both need. */
  inputSchema: z.ZodObject<any>
  /** Called with the model's arguments, returns the payload the model sees. */
  run(args: Record<string, unknown>): Promise<string>
}

/** What a strategy hands the answerer for one probe at one resume point. */
export interface Assembled {
  /** Extra system prompt lines this strategy adds. */
  systemExtra: string
  /** The generic summary, the brief, or the core plus episode titles. */
  brief: string
  /** The `<recalled-memory>` block, empty when the strategy does no recall. */
  recall: string
  /** The verbatim tail. */
  tail: string
  /** The top hits this strategy ranked for the question, for recall at 5. */
  hits: Hit[]
  /** Tools offered for this answer. */
  tools: BenchTool[]
  /** Maximum tool calls allowed. */
  maxToolCalls: number
  /**
   * Tokens the summary or brief generation cost at this resume point, TOTAL.
   * The runner amortizes it over the probes served at that resume point.
   */
  generationTokens: number
}

/** The model hook a strategy uses for summaries: the SAME model that answers. */
export type SummarizeHook = (
  prompt: string,
  text: string,
) => Promise<{ text: string; tokens: number }>

export interface StrategyCtx {
  /** Every row up to and including the resume point. */
  rows: CorpusRow[]
  resumeWeek: number
  question: string
  summarize: SummarizeHook
  /** Cross probe memo so a brief is built once per resume point. */
  memo: Map<string, Promise<unknown>>
  /** Where the embedding cache lives (the out dir unless one is shared). */
  outDir: string
  corpusHash: string
  /**
   * Called once for every summary or brief a strategy generates, so a run
   * leaves the actual context it fed on disk instead of only its token count.
   */
  persist?: (label: string, text: string, tokens: number) => void
}

export interface HistoryStrategy {
  id: string
  name: string
  assemble(ctx: StrategyCtx): Promise<Assembled>
  rank?(query: string, ctx: StrategyCtx): Promise<Hit[]>
}

export interface AnswerRequest {
  system: string
  user: string
  tools: BenchTool[]
  maxToolCalls: number
}

export interface AnswerResult {
  text: string
  toolCalls: number
  /** Characters of every tool payload the model was fed. */
  toolPayloadChars: number
  /** The provider's own input token count, null when it reports none. */
  providerInputTokens: number | null
  latencyMs: number
}

export interface Answerer {
  /** The model id actually used, printed in the report header. */
  modelId: string
  answer(req: AnswerRequest): Promise<AnswerResult>
  summarize: SummarizeHook
}

/** One measured (strategy, resume point, probe) cell. */
export interface AnswerRecord {
  key: string
  strategyId: string
  resumeWeek: number
  probeId: string
  probeKind: ProbeKind
  question: string
  expected: string
  answer: string
  /** chars/4 estimate of brief + tail + recall + tool payloads. */
  fedTokensEstimated: number
  /** The provider's reported input tokens, null when unavailable. */
  fedTokensProvider: number | null
  amortizedGenerationTokens: number
  toolCalls: number
  latencyMs: number
  recallAt5: boolean | null
  reciprocalRank: number | null
  score: number | null
  judgeModel: string | null
  error?: string
}
