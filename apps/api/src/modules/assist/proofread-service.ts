// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ProofreadFormat } from "@liaison/shared"
import { generateText } from "ai"
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { userPreferences } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { finalizeUsage, preCheck } from "~/modules/agent/credits/credit-meter"
import { resolveSideCallModel, sideCallUsage } from "~/modules/agent/providers/side-call-model"
import { releaseDemoTurnReservation } from "~/modules/demo/demo-spend"
import { buildDictationCleanupPrompt, buildProofreadSystemPrompt } from "./proofread-prompt"

const log = rootLogger.child({ module: "assist-proofread" })

export class ProofreadError extends Error {
  constructor(
    message: string,
    // Narrow union: ProofreadError is only ever thrown from a PreCheckFailure,
    // whose `status` is exactly this union (a demo visitor's spend refusals add
    // 403, 429 and 503). Keeping the type narrow lets the route return it
    // without a loose cast.
    readonly status: 400 | 402 | 403 | 429 | 500 | 503,
    /** A demo spend refusal's code (`demo_*`). */
    readonly code?: string,
  ) {
    super(message)
  }
}

export interface ProofreadDeps {
  loadInstructions: (userId: string, orgId: string) => Promise<string | null>
  complete: (args: {
    system: string
    prompt: string
    orgId: string
    userId: string
    /** Aborts the model call (the caller's budget ran out, or it went away). */
    signal?: AbortSignal
    /** Retries of a failed call (the SDK's default when absent). */
    maxRetries?: number
  }) => Promise<{ text: string; modelId: string }>
}

export const defaultProofreadDeps: ProofreadDeps = {
  loadInstructions: async (userId, orgId) =>
    withPrivilegedDb(orgId, "proofread-load-instructions", async (tx) => {
      const [row] = await tx
        .select({ v: userPreferences.magicWandInstructions })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1)
      return row?.v ?? null
    }),
  complete: async ({ system, prompt, orgId, userId, signal, maxRetries }) => {
    const cc = await preCheck(orgId, null) // null → cheapest auto-eligible model
    if (!cc.allowed) throw new ProofreadError(cc.reason, cc.status, cc.code ?? cc.billingCode)
    let result: Awaited<ReturnType<typeof generateText>>
    try {
      const model = await resolveSideCallModel(cc)
      result = await generateText({
        model,
        system,
        messages: [{ role: "user", content: prompt }],
        ...(signal ? { abortSignal: signal } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
      })
    } catch (err) {
      // No usage to meter: give back the reservation preCheck took (a no-op
      // outside the demo orgs).
      await releaseDemoTurnReservation(orgId)
      await cc.demo?.finish()
      throw err
    }
    // Mirror the canonical metering call at agent-service.ts:401-407: pass the
    // WHOLE cc.model (full ModelInfo with provider/modelId/in+out cost) so cost
    // math isn't NaN, the required userId, and token counts coalesced to 0
    // (ai v6 LanguageModelUsage fields are number | undefined).
    await finalizeUsage(orgId, {
      model: cc.model,
      ...sideCallUsage(result.usage, result.providerMetadata),
      keySource: cc.keySource,
      userId,
      ...(cc.demo ? { demo: cc.demo } : {}),
    })
    return { text: result.text.trim(), modelId: cc.model.modelId }
  },
}

export async function proofread(
  input: { orgId: string; userId: string; text: string; format: ProofreadFormat },
  deps: ProofreadDeps = defaultProofreadDeps,
): Promise<{ text: string }> {
  if (input.text.trim() === "") return { text: input.text }
  const instructions = await deps.loadInstructions(input.userId, input.orgId)
  const system = buildProofreadSystemPrompt({ format: input.format, instructions })
  const corrected = await deps.complete({
    system,
    prompt: input.text,
    orgId: input.orgId,
    userId: input.userId,
  })
  return { text: corrected.text || input.text }
}

/** The longest a dictation clean-up may take before the raw transcript is used. */
export const DICTATION_CLEAN_TIMEOUT_MS = 20_000

/**
 * One retry of a failed clean-up call, not the SDK's two: the person is
 * waiting on the text, and the raw transcript is a fine answer.
 */
const DICTATION_CLEAN_MAX_RETRIES = 1

/** Settles with `work`, or rejects as soon as `signal` aborts (whatever `work` does). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error("aborted"))
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener("abort", stop)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop)
        reject(err)
      },
    )
  })
}

export interface DictationCleanup {
  cleaned: string
  /** The clean-up model key, null when no model ran. */
  cleanModel: string | null
  /** Set when the clean-up failed: `cleaned` is then the input, untouched. */
  cleanError?: true
}

/**
 * The magic wand in its dictation mode (S5): a dictated transcript rewritten
 * without fillers, stutters and false starts, in the speaker's language, with
 * the user's wand instructions applied, metered like the wand. It never loses
 * the speaker's words: any failure (no model, no credit, provider error, no
 * answer within `timeoutMs`, capped at DICTATION_CLEAN_TIMEOUT_MS) returns the
 * transcript as it was, flagged `cleanError`. The model call is aborted then.
 */
export async function cleanDictation(
  input: {
    orgId: string
    userId: string
    text: string
    language?: string
    /** The caller's remaining budget; never more than DICTATION_CLEAN_TIMEOUT_MS is used. */
    timeoutMs?: number
    signal?: AbortSignal
  },
  deps: ProofreadDeps = defaultProofreadDeps,
): Promise<DictationCleanup> {
  if (input.text.trim() === "") return { cleaned: input.text, cleanModel: null }
  const budget = Math.min(input.timeoutMs ?? DICTATION_CLEAN_TIMEOUT_MS, DICTATION_CLEAN_TIMEOUT_MS)
  if (budget <= 0) {
    log.warn({ orgId: input.orgId }, "no time left for the dictation clean-up; raw transcript")
    return { cleaned: input.text, cleanModel: null, cleanError: true }
  }
  const expiry = new AbortController()
  const timer = setTimeout(
    () => expiry.abort(new Error(`clean-up timed out after ${budget} ms`)),
    budget,
  )
  const signal = input.signal ? AbortSignal.any([input.signal, expiry.signal]) : expiry.signal
  try {
    const instructions = await deps.loadInstructions(input.userId, input.orgId)
    const system = buildDictationCleanupPrompt({
      instructions,
      ...(input.language ? { language: input.language } : {}),
    })
    const out = await untilAborted(
      deps.complete({
        system,
        prompt: input.text,
        orgId: input.orgId,
        userId: input.userId,
        signal,
        maxRetries: DICTATION_CLEAN_MAX_RETRIES,
      }),
      signal,
    )
    if (!out.text) return { cleaned: input.text, cleanModel: null, cleanError: true }
    return { cleaned: out.text, cleanModel: out.modelId }
  } catch (err) {
    // The transcript itself never reaches the log: only why the clean-up failed.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: input.orgId },
      "dictation clean-up failed; returning the raw transcript",
    )
    return { cleaned: input.text, cleanModel: null, cleanError: true }
  } finally {
    clearTimeout(timer)
  }
}
