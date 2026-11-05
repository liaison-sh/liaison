// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VOICE DICTATION, THE SERVER HALF (S2, S3, S8, S10).
//
// One recording (or one client-cut segment of one, at most 45 s) arrives as its
// raw bytes. It is transcribed in memory by the org's transcription model and,
// when asked, cleaned up by the wand's dictation mode. The audio is never
// written anywhere: not to object storage, not to a log line (the logger only
// ever sees the org, the model and the error), not to the usage row.
//
// The order is the money order. Model and key first (a visitor org on a demo
// box without a key of its own gets 503 with nothing sent upstream), then the
// spend gate `preCheck` applies to every paid call (demo ceiling, breaker,
// balance), then, for the reserved demo org, its ledger entry BEFORE the call,
// then the call, then the meter, then the clean-up. A call that reached the
// provider is metered even when its result is refused (too long, empty).
import type {
  DictationErrorCode,
  ShippedLocale,
  TranscribeAudioType,
  TranscribeResponse,
} from "@liaison/shared"
import { DICTATION_SEGMENT_SECONDS, dictationErrorCodeSchema } from "@liaison/shared"
import { generateText } from "ai"
import { rootLogger } from "~/lib/logger"
import { finalizeUsage, resolveKey, spendGate } from "~/modules/agent/credits/credit-meter"
import {
  BoxKeyRequestRefusedError,
  openRouterFetch,
  registerBoxKeyModel,
} from "~/modules/agent/providers/openrouter"
import { resolveSideCallModel } from "~/modules/agent/providers/side-call-model"
import {
  type DemoReservation,
  releaseReservation,
  reserveVisitorStep,
  settleStep,
  visitorSpendIdentity,
} from "~/modules/demo/demo-budget"
import {
  DEMO_SPEND_CODES,
  DemoKeyRequiredError,
  type DemoSpendCode,
  DemoSpendRefusedError,
  demoPlatformKeyAllowed,
  demoSpendMessage,
  isVisitorDemoOrg,
  recordReservedDemoSideSpend,
  releaseDemoTurnReservation,
} from "~/modules/demo/demo-spend"
import {
  microEurOfUsd,
  VISITOR_TRANSCRIPTION_MICRO_EUR_PER_SECOND,
} from "~/modules/demo/demo-spend-ceiling"
import { type ServerTParams, serverT } from "~/modules/i18n/server-i18n"
import { containerDurationSeconds, maximumSecondsOf, minimumSecondsOf } from "./audio-duration"
import {
  cleanDictation,
  DICTATION_CLEAN_TIMEOUT_MS,
  type DictationCleanup,
} from "./proofread-service"
import {
  resolveTranscriptionPlan,
  TRANSCRIPTION_MODELS,
  TRANSCRIPTION_TOKEN_EQUIVALENT,
  type TranscriptionModel,
  type TranscriptionPlan,
} from "./transcription-models"

const UPSTREAM_TIMEOUT_MS = 60_000

/**
 * How long the measured default's transcript is waited for, from its start,
 * before the hedge's (started at the same time) is taken instead (S6: stop to
 * insert p95 at most 10 s). The bake-off's p50 was 759 ms, so a 1.7B call
 * still unanswered at 3 s is in its provider's slow tail; the 0.6B (p50 under
 * 1 s on a healthy pool) is normally done by then.
 */
export const PRIMARY_GRACE_MS = 3_000

/**
 * The longest ONE request may be, in seconds: the client cuts every take into
 * segments of DICTATION_SEGMENT_SECONDS (plus a second of overlap), so this is
 * one segment and its slack. Checked on the container before the call is paid.
 */
export const DICTATION_REQUEST_MAX_SECONDS = DICTATION_SEGMENT_SECONDS + 15

/**
 * The most seconds a demo visitor's recording may be reserved at on the box
 * key. A visitor's call is reserved at the most audio its BYTES can hold
 * (`maximumSecondsOf`, the codec's lowest bitrate), never at what its header
 * claims, and a recording whose bytes could hold more than this is refused
 * before anything is sent. 2,400 s at 7 µEUR is 16,800 µEUR, under one agent
 * step's reservation (20,349 µEUR), so a transcription is bounded like a step.
 * A 60 s take at 128 kbit/s (about 960 KB of Opus, bounded at 1,280 s) fits.
 */
export const VISITOR_TRANSCRIPTION_MAX_RESERVED_SECONDS = 2_400

/** What the clean-up leaves of the request budget for the response itself. */
const CLEAN_DEADLINE_MARGIN_MS = 2_000

/** OpenRouter's `input_audio.format` for each accepted media type. */
export const OPENROUTER_AUDIO_FORMAT: Record<TranscribeAudioType, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
}

const STATUS: Record<DictationErrorCode, 402 | 403 | 413 | 415 | 422 | 429 | 502 | 503> = {
  too_large: 413,
  unsupported_format: 415,
  empty_audio: 422,
  rate_limited: 429,
  no_transcription_model: 503,
  insufficient_credits: 402,
  demo_key_required: 503,
  upstream_failed: 502,
  demo_verification_required: 403,
  demo_budget_exhausted: 402,
  demo_network_exhausted: 402,
  demo_box_exhausted: 402,
  demo_rate_limited: 429,
  demo_busy: 429,
  demo_unavailable: 503,
}

/** The i18n key (`kernel.dictationErrors.*`) of each error's user-facing message. */
const MESSAGE_KEY: Record<DictationErrorCode, string> = {
  too_large: "kernel.dictationErrors.tooLong",
  unsupported_format: "kernel.dictationErrors.unsupportedFormat",
  empty_audio: "kernel.dictationErrors.empty",
  rate_limited: "kernel.dictationErrors.rateLimited",
  no_transcription_model: "kernel.dictationErrors.noModel",
  insufficient_credits: "kernel.dictationErrors.insufficientCredits",
  demo_key_required: "kernel.dictationErrors.demoKeyRequired",
  upstream_failed: "kernel.dictationErrors.upstreamFailed",
  demo_verification_required: "kernel.demo.refusal.demo_verification_required",
  demo_budget_exhausted: "kernel.demo.refusal.demo_budget_exhausted",
  demo_network_exhausted: "kernel.demo.refusal.demo_network_exhausted",
  demo_box_exhausted: "kernel.demo.refusal.demo_box_exhausted",
  demo_rate_limited: "kernel.demo.refusal.demo_rate_limited",
  demo_busy: "kernel.demo.refusal.demo_busy",
  demo_unavailable: "kernel.demo.refusal.demo_unavailable",
}

/** The dictation codes that are a demo visitor's spend refusals. */
const DEMO_SPEND_DICTATION_CODES = new Set<DictationErrorCode>([
  "demo_verification_required",
  "demo_budget_exhausted",
  "demo_network_exhausted",
  "demo_box_exhausted",
  "demo_rate_limited",
  "demo_busy",
  "demo_unavailable",
])

function asDemoSpendCode(code: DictationErrorCode): DemoSpendCode | null {
  return DEMO_SPEND_DICTATION_CODES.has(code)
    ? (DEMO_SPEND_CODES.find((c) => c === code) ?? null)
    : null
}

/**
 * A refused or failed dictation. `message` is the English text (for logs);
 * `localized(locale)` is what the person reads, in their language.
 */
export class TranscribeError extends Error {
  readonly status: 402 | 403 | 413 | 415 | 422 | 429 | 502 | 503
  readonly key: string
  constructor(
    readonly code: DictationErrorCode,
    readonly params: ServerTParams = {},
    key?: string,
  ) {
    const k = key ?? MESSAGE_KEY[code]
    const demoCode = asDemoSpendCode(code)
    super(demoCode ? demoSpendMessage(demoCode, "en") : serverT("en", k, params))
    this.name = "TranscribeError"
    this.status = STATUS[code]
    this.key = k
  }

  localized(locale: ShippedLocale): string {
    const demoCode = asDemoSpendCode(this.code)
    if (demoCode) return demoSpendMessage(demoCode, locale)
    return serverT(locale, this.key, this.params)
  }
}

/** A demo visitor's spend refusal as a dictation error (same code). */
function demoTranscribeError(err: DemoSpendRefusedError): TranscribeError {
  const code = dictationErrorCodeSchema.safeParse(err.code)
  return new TranscribeError(code.success ? code.data : "demo_unavailable")
}

/** What a provider call returned: the text, and what it says about duration and cost. */
interface ProviderTranscript {
  text: string
  seconds: number | null
  /** What the provider billed, USD, when it reported it (OpenRouter). */
  costUsd: number | undefined
  /** The cost computed from the provider's own usage numbers, USD (Gemini's tokens). */
  estimatedCostUsd?: number
}

/** Gemini audio: 32 tokens per second of audio (Google's documented rate). */
const GEMINI_AUDIO_TOKENS_PER_SECOND = 32
/** Gemini Flash-Lite text output, USD per 1M tokens (Google's list price). */
const GEMINI_FLASH_LITE_OUTPUT_USD_PER_M = 0.4

interface ProviderCall {
  model: TranscriptionModel
  apiKey: string
  audio: Uint8Array
  contentType: TranscribeAudioType
  language?: string
  signal: AbortSignal
}

/** The spend path of a transcription call (credit-meter, demo-spend), injectable for tests. */
export interface TranscribeSpend {
  resolveKey: typeof resolveKey
  spendGate: typeof spendGate
  finalizeUsage: typeof finalizeUsage
  recordReservedDemoSideSpend: typeof recordReservedDemoSideSpend
  releaseDemoTurnReservation: typeof releaseDemoTurnReservation
  /** A demo visitor's box-key call: its reservation, settle and release (demo-budget). */
  reserveVisitorStep?: typeof reserveVisitorStep
  settleStep?: typeof settleStep
  releaseReservation?: typeof releaseReservation
}

// On a demo box a verified visitor may dictate on the box's OpenRouter key:
// the request guard admits the transcription models (not chat: no max price).
for (const m of TRANSCRIPTION_MODELS) {
  if (m.provider === "openrouter") registerBoxKeyModel(m.upstreamId, null)
}

export interface TranscribeDeps {
  resolvePlan: (orgId: string) => Promise<TranscriptionPlan | null>
  callProvider: (call: ProviderCall) => Promise<ProviderTranscript>
  clean: (input: {
    orgId: string
    userId: string
    text: string
    language?: string
    /** What is left of the request budget for the clean-up (it caps itself at 20 s). */
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<DictationCleanup>
  log: Pick<typeof rootLogger, "warn" | "error">
  spend: TranscribeSpend
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** A provider answered with an error: its status and message, for the log line. */
export class UpstreamError extends Error {
  constructor(
    readonly httpStatus: number,
    detail: string,
  ) {
    super(`HTTP ${httpStatus}${detail ? `: ${detail}` : ""}`)
    this.name = "UpstreamError"
  }
}

/**
 * The connection to OpenRouter ended before it answered at all (no status, no
 * body: the socket was closed or reset), and neither the caller nor the upstream
 * timeout cut it. OpenRouter bills a generation it answered; with no answer
 * there is no generation id to look up and nothing it reports as billed.
 */
export class UpstreamNoAnswerError extends Error {
  constructor(cause: unknown) {
    super(
      `the connection to OpenRouter ended before it answered: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    this.name = "UpstreamNoAnswerError"
  }
}

/**
 * A failed call that provably cost nothing: the box key guard refused it
 * before it was sent, OpenRouter answered 4xx (it rejected the request), or
 * the connection ended before OpenRouter answered anything (live demo,
 * 2026-10-27: a dictation whose connection was closed after 48 s was settled
 * at its reserved max with no transcription behind it).
 */
function notServed(err: unknown): boolean {
  if (err instanceof BoxKeyRequestRefusedError) return true
  if (err instanceof UpstreamNoAnswerError) return true
  return err instanceof UpstreamError && err.httpStatus >= 400 && err.httpStatus < 500
}

/** OpenRouter speech to text: base64 audio in JSON, no-retention routing. */
async function callOpenRouter(call: ProviderCall): Promise<ProviderTranscript> {
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
  let res: Response
  try {
    res = await openRouterFetch("/audio/transcriptions", {
      apiKey: call.apiKey,
      body: {
        model: call.model.upstreamId,
        input_audio: {
          data: Buffer.from(call.audio).toString("base64"),
          format: OPENROUTER_AUDIO_FORMAT[call.contentType],
        },
        ...(call.language ? { language: call.language } : {}),
        // Speech to text takes no parameters to require: only the retention rule.
        provider: { data_collection: "deny" },
      },
      signal,
    })
  } catch (err) {
    // Cut by us (the caller went away, the hedge's winner, the upstream
    // timeout): OpenRouter had the audio and may still decode it, so the
    // error stays as it is (billed at the hold's max). Otherwise nothing
    // answered at all.
    if (signal.aborted || err instanceof BoxKeyRequestRefusedError) throw err
    throw new UpstreamNoAnswerError(err)
  }
  const body = (await res.json().catch(() => null)) as {
    text?: unknown
    usage?: { seconds?: unknown; cost?: unknown }
    error?: { message?: unknown }
  } | null
  if (!res.ok) {
    throw new UpstreamError(
      res.status,
      typeof body?.error?.message === "string" ? body.error.message : "",
    )
  }
  return {
    text: typeof body?.text === "string" ? body.text : "",
    seconds: finiteNumber(body?.usage?.seconds) ?? null,
    costUsd: finiteNumber(body?.usage?.cost),
  }
}

/** Gemini audio input (the Google-only fallback): the recording as a file part. */
async function callGemini(call: ProviderCall): Promise<ProviderTranscript> {
  const model = await resolveSideCallModel({
    model: { provider: "google", modelId: call.model.upstreamId },
    providerKey: call.apiKey,
  })
  const result = await generateText({
    model,
    temperature: 0,
    abortSignal: AbortSignal.any([call.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcribe this recording verbatim, in the language spoken. " +
              "Return only the transcript, nothing else.",
          },
          { type: "file", data: call.audio, mediaType: call.contentType },
        ],
      },
    ],
  })
  // Gemini reports tokens, not seconds: the prompt is the audio (32 tokens a
  // second) plus a one-line instruction, so the seconds it heard are read off
  // the input tokens for the meter (not reported as the clip's duration).
  const input = result.usage.inputTokens ?? 0
  const output = result.usage.outputTokens ?? 0
  return {
    text: result.text,
    seconds: null,
    costUsd: undefined,
    estimatedCostUsd:
      (input / GEMINI_AUDIO_TOKENS_PER_SECOND) * call.model.pricePerSecondUsd +
      (output * GEMINI_FLASH_LITE_OUTPUT_USD_PER_M) / 1_000_000,
  }
}

export const defaultTranscribeDeps: TranscribeDeps = {
  resolvePlan: (orgId) => resolveTranscriptionPlan(orgId),
  callProvider: (call) =>
    call.model.provider === "openrouter" ? callOpenRouter(call) : callGemini(call),
  clean: (input) => cleanDictation(input),
  log: rootLogger.child({ module: "assist-transcribe" }),
  spend: {
    resolveKey,
    spendGate,
    finalizeUsage,
    recordReservedDemoSideSpend,
    releaseDemoTurnReservation,
    reserveVisitorStep,
    settleStep,
    releaseReservation,
  },
}

/**
 * Is dictation available to this org (the mic control renders)? The same
 * resolution the transcription runs, so the control and the endpoint agree.
 */
export async function dictationAvailable(
  orgId: string,
  deps: Pick<TranscribeDeps, "resolvePlan"> = defaultTranscribeDeps,
): Promise<boolean> {
  return (await deps.resolvePlan(orgId)) !== null
}

/** One upstream call in flight: its model, its own abort, and how it settled. */
interface Attempt {
  model: TranscriptionModel
  abort: AbortController
  startedAt: number
  /** Still waiting on the provider (neither answered nor failed). */
  running: boolean
  settled: Promise<{ ok: true; transcript: ProviderTranscript } | { ok: false; err: unknown }>
}

type Chosen = { attempt: Attempt; transcript: ProviderTranscript }

/** The first of these calls to return a transcript, or null when every one failed. */
function firstTranscript(attempts: Attempt[]): Promise<Chosen | null> {
  return new Promise((resolve) => {
    let pending = attempts.length
    if (pending === 0) return resolve(null)
    for (const attempt of attempts) {
      void attempt.settled.then((r) => {
        if (r.ok) resolve({ attempt, transcript: r.transcript })
        else if (--pending === 0) resolve(null)
      })
    }
  })
}

/** Resolves after `ms`, or as soon as `stop` aborts; never rejects, leaves no timer behind. */
function graceDelay(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop.aborted) return resolve()
    const timer = setTimeout(done, ms)
    stop.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      stop.removeEventListener("abort", done)
      resolve()
    }
  })
}

export async function transcribe(
  input: {
    orgId: string
    userId: string
    audio: Uint8Array
    contentType: TranscribeAudioType
    language?: string
    clean: boolean
    signal: AbortSignal
    /** When the request's budget runs out (epoch ms); defaults to its full budget from now. */
    deadline?: number
  },
  deps: TranscribeDeps = defaultTranscribeDeps,
): Promise<TranscribeResponse> {
  const { orgId, userId } = input
  const deadline = input.deadline ?? Date.now() + TRANSCRIBE_REQUEST_TIMEOUT_MS

  // 0. The length, read off the container before anything is spent (SK4): one
  //    request is one client segment. A file whose container says nothing is
  //    bounded by its bytes at the highest plausible bitrate.
  const declared = containerDurationSeconds(input.audio, input.contentType)
  const atLeast = declared ?? minimumSecondsOf(input.audio.byteLength)
  if (atLeast > DICTATION_REQUEST_MAX_SECONDS) {
    throw new TranscribeError("too_large", { seconds: DICTATION_REQUEST_MAX_SECONDS })
  }
  /** The length to meter at when the provider reports neither seconds nor cost. */
  const boundedSeconds = declared ?? DICTATION_REQUEST_MAX_SECONDS

  // 1. Model and key. No model: say which (a demo visitor org needs its own key).
  const plan = await deps.resolvePlan(orgId)
  if (!plan) {
    // A demo visitor without a key of its own dictates on the box key once
    // verified: say what is missing (the email code, or spend is off).
    if (await isVisitorDemoOrg(orgId)) {
      try {
        await visitorSpendIdentity(orgId)
      } catch (err) {
        if (err instanceof DemoSpendRefusedError) throw demoTranscribeError(err)
        throw err
      }
    }
    if (!(await demoPlatformKeyAllowed(orgId))) throw new TranscribeError("demo_key_required")
    throw new TranscribeError("no_transcription_model")
  }
  const { spend } = deps
  let key: { key: string; source: "byok" | "liaison" }
  // A demo visitor on the box key: every call holds its own reservation
  // (seconds x the derivation block's worst price), taken in `start` below.
  let visitorBoxKey = false
  try {
    key = await spend.resolveKey(orgId, plan.model.provider)
  } catch (err) {
    if (err instanceof DemoSpendRefusedError && plan.model.provider === "openrouter") {
      visitorBoxKey = true
      key = { key: "", source: "liaison" }
    } else if (err instanceof DemoSpendRefusedError) {
      throw demoTranscribeError(err)
    } else if (err instanceof DemoKeyRequiredError) {
      throw new TranscribeError("demo_key_required")
    } else {
      throw new TranscribeError("no_transcription_model")
    }
  }
  // A visitor on the box key is reserved at what the bytes can hold; the
  // header's claim only ever raises it (SK4 still refuses a long claim).
  const visitorSeconds = Math.max(
    declared ?? 0,
    maximumSecondsOf(input.audio.byteLength, input.contentType),
  )
  if (visitorBoxKey && visitorSeconds > VISITOR_TRANSCRIPTION_MAX_RESERVED_SECONDS) {
    throw new TranscribeError("too_large", { seconds: DICTATION_REQUEST_MAX_SECONDS })
  }
  const reservations = new Map<TranscriptionModel, DemoReservation>()
  const reserveStep = spend.reserveVisitorStep ?? reserveVisitorStep
  const settleHold = spend.settleStep ?? settleStep
  const releaseHold = spend.releaseReservation ?? releaseReservation
  let visitorRefusal: TranscribeError | null = null

  // 2-4, per upstream call: the spend gate every paid call passes (credit-meter
  //    `spendGate`: demo ceiling, breaker, balance; it takes the reservation the
  //    call's meter or release gives back), the reserved demo org's ledger entry
  //    at its worst case, then the call. The bytes stay in this frame: nothing
  //    below logs them.
  const attempts: Attempt[] = []
  const start = async (model: TranscriptionModel): Promise<boolean> => {
    let apiKey = key.key
    if (visitorBoxKey) {
      try {
        const reservation = await reserveStep(
          orgId,
          model.upstreamId,
          Math.ceil(visitorSeconds) * VISITOR_TRANSCRIPTION_MICRO_EUR_PER_SECOND,
        )
        reservations.set(model, reservation)
        apiKey = (
          await spend.resolveKey(
            orgId,
            { provider: "openrouter", upstreamId: model.upstreamId },
            { reservation },
          )
        ).key
      } catch (err) {
        if (err instanceof DemoSpendRefusedError) {
          visitorRefusal = demoTranscribeError(err)
          return false
        }
        throw err
      }
    }
    const block = await spend.spendGate(orgId, key.source, model.key)
    if (block) {
      deps.log.warn(
        { orgId, model: model.key, reason: block.reason },
        "transcription refused by the spend gate",
      )
      const held = reservations.get(model)
      if (held) {
        reservations.delete(model)
        await releaseHold(held)
      }
      return false
    }
    if (key.source === "liaison" && !visitorBoxKey) {
      await spend.recordReservedDemoSideSpend(orgId, {
        label: "dictation-transcription",
        tokens: TRANSCRIPTION_TOKEN_EQUIVALENT,
      })
    }
    const abort = new AbortController()
    const attempt: Attempt = {
      model,
      abort,
      startedAt: Date.now(),
      running: true,
      settled: Promise.resolve({ ok: false, err: null }),
    }
    attempt.settled = deps
      .callProvider({
        model,
        apiKey,
        audio: input.audio,
        contentType: input.contentType,
        ...(input.language ? { language: input.language } : {}),
        signal: AbortSignal.any([input.signal, abort.signal]),
      })
      .then(
        (transcript) => ({ ok: true as const, transcript }),
        (err: unknown) => ({ ok: false as const, err }),
      )
      .finally(() => {
        attempt.running = false
      })
    attempts.push(attempt)
    return true
  }
  // A demo visitor on the box key gets one call, not the hedged pair (it would
  // double their spend): the hedge's model alone, whose provider pool answers
  // in about a second, rather than the measured default's, whose provider
  // stalls for up to the upstream timeout (a 48 s "Transcribing..." that then
  // failed). An explicit admin choice (no hedge) is kept as it is.
  const firstModel = visitorBoxKey && plan.hedge ? plan.hedge : plan.model
  if (!(await start(firstModel))) {
    throw visitorRefusal ?? new TranscribeError("insufficient_credits")
  }
  const primary = attempts[0] as Attempt

  // The hedge (S6): the measured default on an org that chose no model asks the
  // 0.6B at the same time (a spend gate refusing the second call leaves the
  // first alone). The 1.7B's transcript is used when it lands within
  // PRIMARY_GRACE_MS of its start; past that, or once it failed (whatever the
  // failure), the first transcript there is, normally the 0.6B's, already done.
  // Not for a demo visitor on the box key: the hedge would double its spend.
  if (plan.hedge && !visitorBoxKey && !input.signal.aborted) await start(plan.hedge)

  let winner: Chosen | null = null
  if (attempts.length > 1) {
    const primaryDone = new AbortController()
    let early: Chosen | null = null
    void primary.settled.then((r) => {
      if (r.ok) early = { attempt: primary, transcript: r.transcript }
      primaryDone.abort()
    })
    await graceDelay(
      PRIMARY_GRACE_MS - (Date.now() - primary.startedAt),
      AbortSignal.any([primaryDone.signal, input.signal]),
    )
    winner = early
  }
  winner ??= await firstTranscript(attempts)
  // A call still running once a transcript is chosen is cut off. OpenRouter had
  // its audio and was decoding it, so it was most likely billed: it is metered
  // below at an estimate (SK5). With no transcript at all, every call has
  // already failed and nothing is cut off.
  const billedLosers = new Set<Attempt>()
  for (const attempt of attempts) {
    if (attempt === winner?.attempt) continue
    if (winner && attempt.running) billedLosers.add(attempt)
    attempt.abort.abort()
  }
  const outcomes = await Promise.all(attempts.map((a) => a.settled))
  const heard = winner?.transcript.seconds ?? boundedSeconds

  // 5. Meter what each provider did, whatever happens to the answer next: every
  //    call that returned a transcript (both, when both did), at what its
  //    provider billed, or, when it said nothing, at the bounded length times
  //    its price. A call cut off once a transcript was chosen is metered at the
  //    seconds the winner heard times its price. A call that failed returned
  //    no usage: its reservation is given back.
  for (const [i, attempt] of attempts.entries()) {
    const outcome = outcomes[i]
    // A demo visitor's hold: settled at what OpenRouter reported, else at the
    // seconds heard times the worst price, else at its reserved max. A call
    // that failed is billed at its max unless it provably was never served
    // (refused before it was sent, or a 4xx answer from OpenRouter): the
    // audio left, and an abort or a 5xx says nothing about what was billed.
    const reservation = reservations.get(attempt.model)
    if (reservation) {
      if (!outcome?.ok) {
        if (outcome && notServed(outcome.err)) await releaseHold(reservation)
        else await settleHold(reservation, reservation.maxMicroEur)
      } else {
        const t = outcome.transcript
        await settleHold(
          reservation,
          t.costUsd !== undefined
            ? microEurOfUsd(t.costUsd)
            : t.seconds !== null
              ? Math.ceil(t.seconds) * VISITOR_TRANSCRIPTION_MICRO_EUR_PER_SECOND
              : reservation.maxMicroEur,
        )
      }
    }
    if (!outcome?.ok) {
      if (!billedLosers.has(attempt)) {
        await spend.releaseDemoTurnReservation(orgId)
        continue
      }
      await spend
        .finalizeUsage(orgId, {
          model: {
            provider: attempt.model.provider,
            modelId: attempt.model.key,
            inputCostPerM: "0",
            outputCostPerM: "0",
          },
          inputTokens: 0,
          outputTokens: 0,
          fixedCostUsd: heard * attempt.model.pricePerSecondUsd,
          metadata: { kind: "transcription", seconds: heard, estimated: true, hedgeLoser: true },
          description: `transcription (cut off), about ${Math.round(heard)} s`,
          keySource: key.source,
          userId,
        })
        .catch((err) =>
          deps.log.error(
            { err, orgId, model: attempt.model.key },
            "failed to meter a transcription",
          ),
        )
      continue
    }
    const seconds = outcome.transcript.seconds
    const reported =
      seconds !== null ||
      outcome.transcript.costUsd !== undefined ||
      outcome.transcript.estimatedCostUsd !== undefined
    await spend
      .finalizeUsage(orgId, {
        model: {
          provider: attempt.model.provider,
          modelId: attempt.model.key,
          inputCostPerM: "0",
          outputCostPerM: "0",
        },
        inputTokens: 0,
        outputTokens: 0,
        ...(outcome.transcript.costUsd !== undefined
          ? { providerCostUsd: outcome.transcript.costUsd }
          : {}),
        ...(seconds !== null
          ? { fixedCostUsd: seconds * attempt.model.pricePerSecondUsd }
          : outcome.transcript.estimatedCostUsd !== undefined
            ? { fixedCostUsd: outcome.transcript.estimatedCostUsd }
            : { fixedCostUsd: boundedSeconds * attempt.model.pricePerSecondUsd }),
        metadata: { kind: "transcription", seconds, ...(reported ? {} : { estimated: true }) },
        description: seconds !== null ? `transcription, ${seconds} s` : "transcription",
        keySource: key.source,
        userId,
      })
      .catch((err) =>
        deps.log.error({ err, orgId, model: attempt.model.key }, "failed to meter a transcription"),
      )
  }

  if (!winner) {
    const failure = outcomes[0]
    const err = failure && !failure.ok ? failure.err : undefined
    for (const [i, attempt] of attempts.entries()) {
      const o = outcomes[i]
      const message = o && !o.ok ? (o.err instanceof Error ? o.err.message : String(o.err)) : ""
      deps.log.error({ err: message, orgId, model: attempt.model.key }, "transcription failed")
    }
    throw new TranscribeError("upstream_failed", {
      status: err instanceof UpstreamError ? err.httpStatus : 0,
    })
  }
  const model = winner.attempt.model
  const transcript = winner.transcript
  const seconds = transcript.seconds

  if (seconds !== null && seconds > DICTATION_REQUEST_MAX_SECONDS) {
    throw new TranscribeError("too_large", { seconds: DICTATION_REQUEST_MAX_SECONDS })
  }
  const raw = transcript.text.trim()
  if (raw === "") throw new TranscribeError("empty_audio")

  // 6. Clean-up, which never loses the transcript (cleanDictation's contract).
  if (!input.clean) {
    return { raw, cleaned: raw, model: model.key, cleanModel: null, durationSeconds: seconds }
  }
  // Bounded by what is left of the request (never a 504 over a transcript in
  // hand): at most 20 s, and never past the deadline less a margin to answer.
  const cleaned = await deps.clean({
    orgId,
    userId,
    text: raw,
    ...(input.language ? { language: input.language } : {}),
    timeoutMs: Math.min(
      DICTATION_CLEAN_TIMEOUT_MS,
      deadline - Date.now() - CLEAN_DEADLINE_MARGIN_MS,
    ),
    signal: input.signal,
  })
  return {
    raw,
    cleaned: cleaned.cleaned,
    model: model.key,
    cleanModel: cleaned.cleanModel,
    durationSeconds: seconds,
    ...(cleaned.cleanError ? { cleanError: true as const } : {}),
  }
}

/** The request budget of POST /api/assist/transcribe (app.ts), above the provider's own 60 s. */
export const TRANSCRIBE_REQUEST_TIMEOUT_MS = 120_000
