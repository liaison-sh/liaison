// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Transcription model bake-off for dictation (S4), and the clean-up score (S5).
 *
 * Every candidate (the OpenRouter models of `TRANSCRIPTION_MODELS`)
 * transcribes every clip of `src/modules/assist/__fixtures__/dictation/clips.json`
 * through the REAL service path: a throwaway org whose transcription setting
 * names the candidate, `transcribe()` from the assist module (model
 * resolution, key, spend gate, the OpenRouter request with its format map,
 * routing and timeout, metering). The word error rate (normalized: lowercase,
 * punctuation stripped, hesitation sounds ignored on both sides, Levenshtein
 * over words) is scored on the REAL clips only; latency is wall clock per
 * call, cost is the `usage.cost` OpenRouter reports (read off the usage row).
 *
 * The default rule (spec S4): lowest mean WER among the candidates whose p50
 * latency on the long clips (20 s and more, the 30 s proxy) is at most 3 s.
 *
 * Then S5: the winner's raw transcript of EVERY clip (real and synthetic) goes
 * through the real clean-up (`cleanDictation`, the wand's dictation mode, on
 * the org's Auto model, an OpenRouter chat model added as an OpenRouter-only
 * admin would) and is scored: no annotated filler left, every must-keep term
 * the raw transcript had still there, and the language kept.
 *
 * Writes `bakeoff-<date>.json` and `bakeoff-<date>.md` into `--out`
 * (default `apps/api/scripts/dictation-bakeoff-results`). Exits non-zero when
 * fewer than 20 real clips were scored, any candidate errored, or S5 failed.
 *
 * It needs the database (a throwaway org, removed at the end), so it runs in
 * this checkout's test namespace (from the repo root):
 *   set -a; source .env.test; set +a
 *   bun run scripts/with-test-lock.ts -- bun run apps/api/scripts/dictation-bakeoff.ts
 *   ... --models qwen/qwen3-asr-1.7b,qwen/qwen3-asr-0.6b --cleanup-model google/gemini-3.1-flash-lite
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { sql } from "~/db"
import { getOpenRouterCatalogue } from "~/modules/agent/credits/openrouter-catalogue"
import {
  type DictationClip,
  dictationManifestSchema,
  dominantLanguage,
  HESITATION_TOKENS,
  percentile,
  scoreCleanup,
  wordErrorRate,
} from "~/modules/assist/dictation-scorer"
import { cleanDictation } from "~/modules/assist/proofread-service"
import {
  defaultTranscribeDeps,
  type TranscribeDeps,
  TranscribeError,
  transcribe,
} from "~/modules/assist/transcribe-service"
import { TRANSCRIPTION_MODELS } from "~/modules/assist/transcription-models"
import { openRouterEntry } from "~/modules/settings/ai-models-routes"

const FIXTURES = path.join(import.meta.dir, "../src/modules/assist/__fixtures__/dictation")
const DEFAULT_OUT = path.join(import.meta.dir, "dictation-bakeoff-results")
/** The candidates: every OpenRouter transcription model the product offers. */
const CANDIDATES = TRANSCRIPTION_MODELS.filter((m) => m.provider === "openrouter").map(
  (m) => m.upstreamId,
)
/** The chat model the throwaway org adds from OpenRouter and makes its Auto (the clean-up's model). */
const DEFAULT_CLEANUP_MODEL = "google/gemini-3.1-flash-lite"
const MIN_REAL_CLIPS = 20
const LONG_CLIP_SECONDS = 20
const P50_BUDGET_MS = 3_000

interface Transcription {
  text: string
  latencyMs: number
  costUsd: number | null
}

/** The throwaway org the service runs as: OpenRouter only, an added chat model as Auto. */
interface BakeoffOrg {
  orgId: string
  userId: string
}

async function createOrg(cleanupUpstreamId: string): Promise<BakeoffOrg> {
  const catalogue = await getOpenRouterCatalogue()
  const cat = catalogue.find((m) => m.upstreamId === cleanupUpstreamId)
  if (!cat) throw new Error(`OpenRouter does not list ${cleanupUpstreamId}`)
  const entry = openRouterEntry(cat, new Date().toISOString())
  const orgId = randomUUID()
  const userId = randomUUID()
  const settings = { ai: { models: { added: [entry], autoModelKey: entry.key } } }
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${orgId}, 'Dictation bake-off', ${`dictation-bakeoff-${orgId.slice(0, 8)}`}, ${JSON.stringify(settings)}::jsonb)`
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${userId}, ${orgId}, ${`bakeoff-${orgId.slice(0, 8)}@example.com`}, 'Bake-off')`
  return { orgId, userId }
}

async function dropOrg(org: BakeoffOrg): Promise<void> {
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${org.orgId}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${org.orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${org.orgId}`
}

/** Point the org's transcription setting at one candidate. */
async function chooseModel(org: BakeoffOrg, upstreamId: string): Promise<void> {
  const key = `openrouter/${upstreamId}`
  await sql`UPDATE kernel.organizations
    SET settings = jsonb_set(settings, '{ai,transcription}', ${JSON.stringify({ modelKey: key })}::jsonb, true)
    WHERE id = ${org.orgId}`
}

/** One clip through the real transcribe service, as the route calls it (clean=false). */
async function transcribeClip(
  org: BakeoffOrg,
  upstreamId: string,
  audio: Uint8Array,
  language: string,
): Promise<Transcription> {
  // The real deps, the provider call only observed: what OpenRouter billed.
  let costUsd: number | null = null
  const deps: TranscribeDeps = {
    ...defaultTranscribeDeps,
    callProvider: async (call) => {
      const transcript = await defaultTranscribeDeps.callProvider(call)
      costUsd = transcript.costUsd ?? null
      return transcript
    },
  }
  const started = performance.now()
  try {
    const result = await transcribe(
      {
        orgId: org.orgId,
        userId: org.userId,
        audio,
        contentType: "audio/webm",
        language,
        clean: false,
        signal: AbortSignal.timeout(120_000),
      },
      deps,
    )
    const latencyMs = Math.round(performance.now() - started)
    if (result.model !== `openrouter/${upstreamId}`) {
      throw new Error(`the service ran ${result.model}, not the candidate`)
    }
    return { text: result.raw, latencyMs, costUsd }
  } catch (err) {
    if (err instanceof TranscribeError) throw new Error(`${err.code}: ${err.message}`)
    throw err
  }
}

interface ClipRun {
  clipId: string
  lang: DictationClip["lang"]
  synthetic: boolean
  durationSeconds: number
  raw: string | null
  latencyMs: number | null
  costUsd: number | null
  wer: number | null
  error: string | null
}

interface ModelSummary {
  model: string
  realClipsScored: number
  errors: number
  meanWer: number | null
  pooledWer: number | null
  meanWerEn: number | null
  meanWerFr: number | null
  p50Ms: number | null
  p95Ms: number | null
  p50LongMs: number | null
  costUsd: number
  usdPerMinute: number | null
  eligible: boolean
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length

function summarize(
  model: string,
  runs: readonly ClipRun[],
  clips: readonly DictationClip[],
): ModelSummary {
  const scored = runs.filter((run) => !run.synthetic && run.wer !== null)
  const werOf = (lang: DictationClip["lang"]) =>
    mean(scored.filter((run) => run.lang === lang).map((run) => run.wer ?? 0))
  let errors = 0
  let referenceWords = 0
  for (const run of scored) {
    const clip = clips.find((c) => c.id === run.clipId)
    if (!clip || run.raw === null) continue
    const result = wordErrorRate(clip.reference, run.raw, { ignore: HESITATION_TOKENS })
    errors += result.errors
    referenceWords += result.referenceWords
  }
  const ok = runs.filter((run) => run.latencyMs !== null)
  const latencies = ok.map((run) => run.latencyMs ?? 0)
  const long = ok
    .filter((run) => run.durationSeconds >= LONG_CLIP_SECONDS)
    .map((run) => run.latencyMs ?? 0)
  const costUsd = ok.reduce((sum, run) => sum + (run.costUsd ?? 0), 0)
  const minutes = ok.reduce((sum, run) => sum + run.durationSeconds, 0) / 60
  const failed = runs.filter((run) => run.error !== null).length
  const p50LongMs = percentile(long, 50)
  return {
    model,
    realClipsScored: scored.length,
    errors: failed,
    meanWer: mean(scored.map((run) => run.wer ?? 0)),
    pooledWer: referenceWords === 0 ? null : errors / referenceWords,
    meanWerEn: werOf("en"),
    meanWerFr: werOf("fr"),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p50LongMs,
    costUsd,
    usdPerMinute:
      minutes === 0 || ok.every((run) => run.costUsd === null) ? null : costUsd / minutes,
    eligible: failed === 0 && p50LongMs !== null && p50LongMs <= P50_BUDGET_MS,
  }
}

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`
const ms = (value: number | null): string => (value === null ? "n/a" : `${value}`)
const usd = (value: number | null): string => (value === null ? "n/a" : `$${value.toFixed(4)}`)

function markdown(date: string, summaries: readonly ModelSummary[], winner: string | null): string {
  const lines = [
    `# Dictation transcription bake-off, ${date}`,
    "",
    "WER on real clips only (AMI en, VoxPopuli fr), hesitations ignored. Latency is wall clock per",
    `request; "p50 long" is over clips of ${LONG_CLIP_SECONDS} s and more (the 30 s proxy, budget ${P50_BUDGET_MS} ms).`,
    "",
    "| Model | Mean WER | Pooled WER | WER en | WER fr | p50 ms | p95 ms | p50 long ms | $/min | Errors | Eligible |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map(
      (s) =>
        `| ${s.model} | ${pct(s.meanWer)} | ${pct(s.pooledWer)} | ${pct(s.meanWerEn)} | ${pct(s.meanWerFr)} | ${ms(s.p50Ms)} | ${ms(s.p95Ms)} | ${ms(s.p50LongMs)} | ${usd(s.usdPerMinute)} | ${s.errors} | ${s.eligible ? "yes" : "no"} |`,
    ),
    "",
    winner
      ? `Default by the S4 rule: **${winner}**.`
      : "No candidate meets the S4 latency budget: no default.",
    "",
  ]
  return lines.join("\n")
}

interface CleanupRun {
  clipId: string
  lang: DictationClip["lang"]
  synthetic: boolean
  raw: string
  cleaned: string | null
  cleanModel: string | null
  fillersInRaw: string[]
  fillersRemaining: string[]
  /** Must-keep terms the raw transcript had and the clean-up lost. */
  mustKeepDroppedByCleanup: string[]
  /** Must-keep terms the transcription itself missed (counted in the WER, not here). */
  mustKeepMissingInRaw: string[]
  languageOut: "en" | "fr" | null
  languageKept: boolean
  latencyMs: number | null
  error: string | null
  pass: boolean
}

/** S5 on one clip: the winner's raw through the real clean-up, then the scorer. */
async function cleanClip(org: BakeoffOrg, clip: DictationClip, raw: string): Promise<CleanupRun> {
  const rawScore = scoreCleanup({
    raw,
    cleaned: raw,
    fillers: clip.fillers,
    mustKeep: clip.mustKeep,
  })
  const base = {
    clipId: clip.id,
    lang: clip.lang,
    synthetic: clip.synthetic,
    raw,
    fillersInRaw: rawScore.fillersRemaining,
    mustKeepMissingInRaw: rawScore.mustKeepMissing,
  }
  const started = performance.now()
  const out = await cleanDictation({
    orgId: org.orgId,
    userId: org.userId,
    text: raw,
    language: clip.lang,
  })
  const latencyMs = Math.round(performance.now() - started)
  if (out.cleanError || out.cleanModel === null) {
    return {
      ...base,
      cleaned: null,
      cleanModel: null,
      fillersRemaining: [],
      mustKeepDroppedByCleanup: [],
      languageOut: null,
      languageKept: false,
      latencyMs,
      error: "the clean-up failed (cleanError): see the service's warn log",
      pass: false,
    }
  }
  const score = scoreCleanup({
    raw,
    cleaned: out.cleaned,
    fillers: clip.fillers,
    mustKeep: clip.mustKeep,
  })
  const languageOut = dominantLanguage(out.cleaned)
  // A text with no marker either way (a list of names) cannot have changed language.
  const languageKept = languageOut === null || languageOut === clip.lang
  return {
    ...base,
    cleaned: out.cleaned,
    cleanModel: out.cleanModel,
    fillersRemaining: score.fillersRemaining,
    mustKeepDroppedByCleanup: score.mustKeepDroppedByCleanup,
    languageOut,
    languageKept,
    latencyMs,
    error: null,
    pass: score.pass && languageKept,
  }
}

function cleanupMarkdown(winner: string, cleanups: readonly CleanupRun[]): string {
  const passed = cleanups.filter((c) => c.pass).length
  const list = (items: readonly string[]) => (items.length === 0 ? "" : items.join(", "))
  return [
    `## Clean-up (S5) on ${winner}'s raw transcripts, every clip`,
    "",
    `${passed}/${cleanups.length} clips pass (no annotated filler left, no must-keep term the raw had lost, language kept).`,
    "",
    "| Clip | Lang | Synthetic | Fillers in raw | Fillers left | Must-keep lost by clean-up | Missed by transcription | Language out | Pass |",
    "|---|---|---|---|---|---|---|---|---|",
    ...cleanups.map(
      (c) =>
        `| ${c.clipId} | ${c.lang} | ${c.synthetic ? "yes" : "no"} | ${list(c.fillersInRaw)} | ${list(c.fillersRemaining)} | ${list(c.mustKeepDroppedByCleanup)} | ${list(c.mustKeepMissingInRaw)} | ${c.languageOut ?? "n/a"} | ${c.pass ? "yes" : c.error ? "ERROR" : "no"} |`,
    ),
    "",
  ].join("\n")
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      out: { type: "string" },
      "cleanup-model": { type: "string" },
    },
  })
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set (source .env.test)")
  }
  const models = values.models ? values.models.split(",").map((m) => m.trim()) : [...CANDIDATES]
  const unknown = models.filter((m) => !CANDIDATES.includes(m))
  if (unknown.length > 0) {
    throw new Error(`not a transcription model the product offers: ${unknown.join(", ")}`)
  }
  const outDir = values.out ?? DEFAULT_OUT
  const manifest = dictationManifestSchema.parse(
    JSON.parse(readFileSync(path.join(FIXTURES, "clips.json"), "utf8")),
  )
  const clips = manifest.clips
  const audio = new Map(
    clips.map((clip) => [clip.id, readFileSync(path.join(FIXTURES, clip.file))]),
  )

  const org = await createOrg(values["cleanup-model"] ?? DEFAULT_CLEANUP_MODEL)
  try {
    return await bakeoff(org, models, clips, audio, outDir)
  } finally {
    await dropOrg(org)
  }
}

async function bakeoff(
  org: BakeoffOrg,
  models: readonly string[],
  clips: readonly DictationClip[],
  audio: ReadonlyMap<string, Uint8Array>,
  outDir: string,
): Promise<number> {
  const runs: Record<string, ClipRun[]> = {}
  for (const model of models) {
    await chooseModel(org, model)
    const modelRuns: ClipRun[] = []
    for (const clip of clips) {
      const run: ClipRun = {
        clipId: clip.id,
        lang: clip.lang,
        synthetic: clip.synthetic,
        durationSeconds: clip.durationSeconds,
        raw: null,
        latencyMs: null,
        costUsd: null,
        wer: null,
        error: null,
      }
      const bytes = audio.get(clip.id)
      try {
        if (!bytes) throw new Error("audio file not loaded")
        const result = await transcribeClip(org, model, bytes, clip.lang)
        run.raw = result.text
        run.latencyMs = result.latencyMs
        run.costUsd = result.costUsd
        if (!clip.synthetic) {
          run.wer = wordErrorRate(clip.reference, result.text, { ignore: HESITATION_TOKENS }).wer
        }
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error)
      }
      modelRuns.push(run)
      const status = run.error ? `ERROR ${run.error}` : `${run.latencyMs} ms wer ${pct(run.wer)}`
      console.log(`${model} ${clip.id}: ${status}`)
    }
    runs[model] = modelRuns
  }

  const summaries = models.map((model) => summarize(model, runs[model] ?? [], clips))
  const eligible = summaries
    .filter((s) => s.eligible && s.meanWer !== null)
    .sort((a, b) => (a.meanWer ?? 1) - (b.meanWer ?? 1))
  const winner = eligible[0]?.model ?? null

  // S5: the winner's raw transcript of every clip through the real clean-up.
  const cleanups: CleanupRun[] = []
  if (winner) {
    for (const run of runs[winner] ?? []) {
      const clip = clips.find((c) => c.id === run.clipId)
      if (!clip || run.raw === null) continue
      const cleanup = await cleanClip(org, clip, run.raw)
      cleanups.push(cleanup)
      console.log(
        `clean-up ${clip.id}: ${cleanup.pass ? "pass" : `FAIL ${JSON.stringify({ left: cleanup.fillersRemaining, lost: cleanup.mustKeepDroppedByCleanup, lang: cleanup.languageOut, error: cleanup.error })}`}`,
      )
    }
  }
  const s5Pass = cleanups.length > 0 && cleanups.every((c) => c.pass)

  const date = new Date().toISOString().slice(0, 10)
  mkdirSync(outDir, { recursive: true })
  const report = {
    date,
    rule: `lowest mean WER (real clips) with p50 latency <= ${P50_BUDGET_MS} ms on clips >= ${LONG_CLIP_SECONDS} s`,
    winner,
    summaries,
    cleanup: {
      model: cleanups.find((c) => c.cleanModel)?.cleanModel ?? null,
      passed: cleanups.filter((c) => c.pass).length,
      clips: cleanups.length,
      pass: s5Pass,
      runs: cleanups,
    },
    runs,
  }
  writeFileSync(path.join(outDir, `bakeoff-${date}.json`), `${JSON.stringify(report, null, 2)}\n`)
  const table = [
    markdown(date, summaries, winner),
    ...(winner ? [cleanupMarkdown(winner, cleanups)] : []),
  ].join("\n")
  writeFileSync(path.join(outDir, `bakeoff-${date}.md`), table)
  console.log(`\n${table}`)

  const realClips = clips.filter((clip) => !clip.synthetic).length
  const short = summaries.filter((s) => s.realClipsScored < MIN_REAL_CLIPS)
  const errored = summaries.filter((s) => s.errors > 0)
  if (realClips < MIN_REAL_CLIPS || short.length > 0) {
    console.error(
      `FAIL: fewer than ${MIN_REAL_CLIPS} real clips scored for ${short.map((s) => s.model).join(", ") || "the set"}`,
    )
    return 1
  }
  if (errored.length > 0) {
    console.error(
      `FAIL: candidates errored: ${errored.map((s) => `${s.model} (${s.errors})`).join(", ")}`,
    )
    return 1
  }
  if (!s5Pass) {
    console.error("FAIL: S5, the clean-up left a filler, lost a must-keep term or changed language")
    return 1
  }
  return 0
}

process.exit(await main())
