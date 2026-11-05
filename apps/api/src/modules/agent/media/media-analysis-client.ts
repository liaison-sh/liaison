// SPDX-License-Identifier: FSL-1.1-ALv2
import { GoogleGenAI, ThinkingLevel } from "@google/genai"
import { filesLogger as log } from "~/lib/logger"
import {
  MAX_OUTPUT_TOKENS,
  MEDIA_ANALYSIS_MODEL_ID,
  MODEL_CALL_BACKOFF_BASE_MS,
  MODEL_CALL_MAX_ATTEMPTS,
} from "~/modules/agent/media/media-analysis-constants"

/**
 * Thin wrapper around `@google/genai`. Owns: client construction from the
 * resolved provider key, the `generateContent` config, the
 * `usageMetadata → { inputTokens, outputTokens }` mapping, and secret redaction
 * on errors. Does NOT call preCheck/finalizeUsage — the caller (tool/job) owns
 * the credit contract so the cost-assertion call counts stay clean.
 */

/** The shape the SDK exposes on a `generateContent` response's usageMetadata. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface MappedTokens {
  inputTokens: number
  outputTokens: number
}

/** ModelInfo as carried by `preCheck` — only the pricing fields matter here. */
export interface MediaModelInfo {
  provider: string
  modelId: string
  inputCostPerM: string
  outputCostPerM: string
  source?: string
  updatedAt?: Date | string
}

/** Typed, key-safe error surfaced to the tool/job (and onward to the agent). */
interface MediaAnalysisClientError {
  error: {
    code: string
    message: string
    status?: number
    retryable: false
  }
}

/**
 * Map the model's usageMetadata to billable token counts.
 * - inputTokens = promptTokenCount ?? 0
 * - outputTokens = max(0, candidatesTokenCount ?? (total - prompt) ?? 0) + thoughts
 *   The `Math.max(0, …)` clamp is mandatory: a malformed response with
 *   totalTokenCount < promptTokenCount would otherwise yield a NEGATIVE
 *   outputTokens that flows into finalizeUsage's rawCost.
 * Any missing field is treated as 0 and logged (never thrown).
 */
export function mapUsageToTokens(usage: GeminiUsageMetadata | undefined): MappedTokens {
  if (!usage) {
    log.warn({ media: "usage" }, "media-analysis: missing usageMetadata, defaulting tokens to 0")
    return { inputTokens: 0, outputTokens: 0 }
  }
  const inputTokens = usage.promptTokenCount ?? 0
  if (usage.promptTokenCount === undefined) {
    log.warn({ media: "usage" }, "media-analysis: missing promptTokenCount")
  }

  let base: number
  if (usage.candidatesTokenCount !== undefined) {
    base = usage.candidatesTokenCount
  } else {
    log.warn({ media: "usage" }, "media-analysis: missing candidatesTokenCount, using total-prompt")
    const total = usage.totalTokenCount ?? 0
    if (usage.totalTokenCount === undefined) {
      log.warn({ media: "usage" }, "media-analysis: missing totalTokenCount")
    }
    base = total - inputTokens
  }
  const thoughts = usage.thoughtsTokenCount ?? 0
  // Clamp the candidate/fallback base at 0 BEFORE adding thoughts so a
  // total < prompt response can never produce a negative billable count.
  const outputTokens = Math.max(0, base) + thoughts
  return { inputTokens, outputTokens }
}

/**
 * Strip secrets from a message/URL/body before it can survive into a returned
 * error or an unredacted log. The `@google/genai` SDK embeds the API key in
 * request URLs and error messages, so this is a hard security requirement.
 */
export function redactSecrets(input: string): string {
  if (!input) return input
  return (
    input
      // ?key=... / &key=... query params
      .replace(/([?&]key=)[^&\s"']+/gi, "$1REDACTED")
      // Bearer tokens
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer REDACTED")
      // x-goog-api-key: <value> header form
      .replace(/(x-goog-api-key:\s*)[^\s"']+/gi, "$1REDACTED")
      // Bare Google API-key-looking tokens (AIza...)
      .replace(/AIza[0-9A-Za-z._-]{10,}/g, "REDACTED")
  )
}

/** Build a key-safe typed error from any thrown SDK/network error. */
function toClientError(err: unknown, code: string): MediaAnalysisClientError {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const status = extractStatusCode(err)
  return {
    error: {
      code,
      message: redactSecrets(rawMessage),
      ...(status !== undefined ? { status } : {}),
      retryable: false,
    },
  }
}

/** HTTP status codes Google's own guidance marks retryable for generateContent. */
const RETRYABLE_STATUS = new Set([429, 500, 503])

/**
 * Best-effort extraction of an HTTP status from a thrown `@google/genai` error.
 * The SDK sometimes sets a numeric `.status`, but for media 5xx it commonly
 * throws an `Error` whose message is the raw JSON body
 * (`{"error":{"code":500,...,"status":"INTERNAL"}}`) with no `.status` field —
 * so we also parse the embedded `"code":<n>` as a fallback.
 */
function extractStatusCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  const match = message.match(/"code"\s*:\s*(\d{3})/)
  return match ? Number(match[1]) : undefined
}

/** Transient (retryable) iff the resolved status is one Google retries on. */
function isTransient(err: unknown): boolean {
  const status = extractStatusCode(err)
  return status !== undefined && RETRYABLE_STATUS.has(status)
}

/** A single content part as accepted by `generateContent` contents. */
export type MediaPart = Record<string, unknown>

export interface AnalyzeWithGeminiArgs {
  providerKey: string
  model: MediaModelInfo
  parts: MediaPart[]
  systemInstruction: string
  signal: AbortSignal
}

/**
 * The minimal `generateContent` surface this module drives. The real
 * `GoogleGenAI` implements a strict superset (richer param + response types), so
 * a single `as unknown as` adapter bridges the two — `as never` (the banned
 * type-silencing form) is not used.
 */
export interface GenaiGenerateClient {
  models: { generateContent: (args: unknown) => Promise<unknown> }
}

export interface AnalyzeWithGeminiDeps {
  /** Test seam — defaults to the real `new GoogleGenAI({ apiKey })`. */
  genaiClientFactory?: (apiKey: string) => GenaiGenerateClient
}

const defaultGenaiClientFactory: NonNullable<AnalyzeWithGeminiDeps["genaiClientFactory"]> = (
  apiKey,
) => new GoogleGenAI({ apiKey }) as unknown as GenaiGenerateClient

/**
 * Run a single `generateContent` media call. Wires the abort signal into the
 * SDK so an external abort cancels the network work. Redacts secrets on any
 * error before throwing a typed, key-safe error object.
 */
export async function analyzeWithGemini(
  args: AnalyzeWithGeminiArgs,
  deps: AnalyzeWithGeminiDeps = {},
): Promise<{ summary: string; usage: MappedTokens }> {
  const factory = deps.genaiClientFactory ?? defaultGenaiClientFactory
  const client = factory(args.providerKey)
  let response: { text?: string; usageMetadata?: GeminiUsageMetadata } | undefined
  // Bounded retry over the model call: a transient upstream error (429/500/503)
  // is retried with exponential backoff; an abort or a non-transient error
  // surfaces immediately. The loop preserves the single-call happy path (it
  // returns on the first success) and the immediate `timeout` mapping on abort.
  for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      response = (await client.models.generateContent({
        model: MEDIA_ANALYSIS_MODEL_ID,
        contents: args.parts,
        config: {
          systemInstruction: args.systemInstruction,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // The model id is the `*-latest` alias (resolves to the Gemini 3.x
          // family). `thinkingLevel` is the 3.x lever (`thinkingBudget` is the
          // deprecated 2.5 lever — sending a bare `thinkingBudget` to a -latest
          // alias risks a future 500, and `thinkingBudget:0` no longer fully
          // disables thinking on 3.x). MINIMAL is the closest-to-zero 3.x setting.
          // Billing stays correct: mapUsageToTokens folds thoughtsTokenCount in.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          abortSignal: args.signal,
        },
      })) as { text?: string; usageMetadata?: GeminiUsageMetadata }
      break
    } catch (err) {
      // Abort always wins — never retry a timed-out / cancelled call.
      const aborted = args.signal.aborted
      const retryable = !aborted && attempt < MODEL_CALL_MAX_ATTEMPTS && isTransient(err)
      if (!retryable) {
        const clientErr = toClientError(err, aborted ? "timeout" : "model_error")
        log.error({ media: "generateContent", code: clientErr.error.code }, clientErr.error.message)
        throw clientErr
      }
      const backoffMs = MODEL_CALL_BACKOFF_BASE_MS * 2 ** (attempt - 1)
      log.warn(
        { media: "generateContent", attempt, maxAttempts: MODEL_CALL_MAX_ATTEMPTS, backoffMs },
        "media-analysis: transient model error, retrying after backoff",
      )
      await sleepWithAbort(backoffMs, args.signal)
    }
  }
  // Unreachable in practice: the loop either `break`s with a response or throws.
  if (!response) {
    throw toClientError(new Error("media-analysis: no response after retries"), "model_error")
  }
  const summary = (response.text ?? "").trim()
  const usage = mapUsageToTokens(response.usageMetadata)
  return { summary, usage }
}

/**
 * Sleep `ms`, resolving early if the abort signal fires (so a deadline abort
 * during backoff doesn't waste the remaining budget). Never rejects — the
 * caller re-checks `signal.aborted` on the next loop turn.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
