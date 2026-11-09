// SPDX-License-Identifier: FSL-1.1-ALv2
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { and, asc, sql as drizzleSql, eq, inArray, notInArray, notLike } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { modelPricing } from "~/db/schema/kernel"
import { isLoadOrg } from "~/lib/load-harness"
import type { IdleCompactionTurn } from "~/modules/agent/context/warm-compaction"
import { CHAT_MODEL_PROVIDERS } from "~/modules/agent/credits/model-keys"
import { loadScriptKey } from "~/modules/agent/providers/load-scripts"
import { createModelServerModel } from "~/modules/agent/providers/model-server"
import { createOpenRouterModel } from "~/modules/agent/providers/openrouter"
import {
  createScriptedModel,
  scriptedModelEnabled,
  scriptKeyFor,
} from "~/modules/agent/providers/scripted-model-provider"

interface ResolveModelParams {
  provider: string
  /** The id the PROVIDER knows (an added model's upstream id, never its key). */
  modelId: string
  apiKey: string
  /** A custom server's address, from org settings (never from a request). */
  baseURL?: string
  /** The conversation the call belongs to. OpenRouter keeps a conversation's
   *  requests on one upstream (its prompt cache, openrouter.ts, ONE UPSTREAM PER
   *  CONVERSATION); the e2e scripted provider picks that thread's script. */
  threadId?: string | null
  /** The thread a call made OUTSIDE the thread's own turn belongs to (its
   *  sub-runs, compaction, briefs): OpenRouter keeps it on the thread's upstream
   *  host like the turn's own steps. Read by OpenRouter only, never by the
   *  scripted or load providers, so a side call never replays the thread's
   *  script. Defaults to `threadId`. */
  providerThreadId?: string | null
  /**
   * A TURN of an agent in a conversation (never a side call): its OpenRouter
   * requests are kept for the idle compaction, which summarizes the thread
   * just before the provider's prompt cache runs out (context/warm-compaction.ts).
   */
  idleCompaction?: IdleCompactionTurn | null
  /** The message the turn answers; only the e2e scripted provider reads it, to
   *  tell apart two turns of one thread whose prompts are the same. */
  scriptTurnId?: string | null
  /** The routine whose run this turn is; only the e2e scripted provider reads
   *  it, to replay a routine-keyed script (`setScriptedRoutine`). */
  routineId?: string | null
  /** OpenRouter only: hears each streamed generation that ended before its usage
   *  (openrouter.ts, A STREAM THAT ENDS BEFORE ITS USAGE). */
  onUnreportedGeneration?: (generationId: string) => void
  /** OpenRouter only: the org the call runs for, whose blocked hosts apply
   *  (openrouter-blocked-hosts.ts). Absent: the instance default. */
  orgId?: string | null
}

// Prompt-cache diagnostic (env-gated, off by default). Gemini implicit caching
// is a byte-prefix match over the serialized request; when prod reports zero
// cachedInputTokens the question is always "is our request prefix actually
// byte-stable across steps/turns?". With LIAISON_DEBUG_GEMINI_REQ=1 every
// Gemini request logs its body length, hash, and the byte offset where it
// first diverges from the PREVIOUS Gemini request — a small offset means the
// prefix mutates (cache-hostile); an offset near the previous body's length
// means append-only (cache-friendly, so misses are on Google's side).
let lastGeminiBody: string | null = null
let geminiDebugSeq = -1
function geminiDebugFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    if (init?.method === "POST" && typeof init.body === "string") {
      const body = init.body
      const prev = lastGeminiBody
      lastGeminiBody = body
      let divergeAt = -1
      if (prev) {
        const n = Math.min(prev.length, body.length)
        divergeAt = n
        for (let i = 0; i < n; i++) {
          if (prev[i] !== body[i]) {
            divergeAt = i
            break
          }
        }
      }
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 12)
      // Contents outline: role + first chars of each message, in serialized
      // order — makes a reordering/reversal/mutation immediately visible.
      let outline = "unparsed"
      try {
        const parsed = JSON.parse(body)
        outline = (parsed.contents ?? [])
          .map((c: any) => {
            const p0 = c.parts?.[0] ?? {}
            const kind =
              p0.text != null ? JSON.stringify(String(p0.text).slice(0, 30)) : Object.keys(p0)[0]
            return `${c.role}:${kind}`
          })
          .join(" | ")
      } catch {}
      console.log(
        `[gemini-req-debug] url=${String(input).replace(/key=[^&]+/, "key=***")} bytes=${body.length} sha=${hash} prevBytes=${prev?.length ?? -1} divergeAt=${divergeAt} head=${JSON.stringify(body.slice(Math.max(0, divergeAt - 60), divergeAt + 120))} contents=[${outline}]`,
      )
      // Full-body dump (rolling, /tmp inside the container) so an operator can
      // byte-diff consecutive requests instead of inferring from divergeAt.
      geminiDebugSeq = (geminiDebugSeq + 1) % 20
      void Bun.write(`/tmp/gemini-req-${String(geminiDebugSeq).padStart(2, "0")}.json`, body)
    }
  } catch {
    // diagnostics must never break the request path
  }
  return fetch(input as never, init)
}

/**
 * Gemini answers a project that has exhausted its MONTHLY spending cap with the same
 * 429 it uses for a per minute rate limit. The AI SDK retries every 429 (background
 * runs climb the full BACKGROUND_MAX_RETRIES ladder, 8 attempts over ~4 minutes), so a
 * cap that will not lift for the rest of the month turned every routine tick into eight
 * provider calls and an error rate spike on the watchdog (prod, nine spikes between
 * 2026-07-21 and 2026-09-15). A spending cap is not a transient: the response is
 * rewritten to 402 Payment Required, which the SDK treats as terminal, so the run fails
 * once, surfaces the provider's own message in the thread, and stops paying for retries.
 * A plain rate limit 429 passes through untouched and keeps its retry ladder.
 */
export const GEMINI_SPEND_CAP_STATUS = 402
const GEMINI_SPEND_CAP_PATTERN = /spend(?:ing)? cap|spend cap|project spend/i

export function geminiSpendCapAwareFetch(
  inner: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const res = await inner(input, init)
    if (res.status !== 429) return res
    let body: string
    try {
      body = await res.clone().text()
    } catch {
      return res
    }
    if (!GEMINI_SPEND_CAP_PATTERN.test(body)) return res
    return new Response(body, {
      status: GEMINI_SPEND_CAP_STATUS,
      statusText: "Payment Required (Gemini spending cap exceeded)",
      headers: res.headers,
    })
  }
}

const providerFactories: Record<string, (apiKey: string) => (modelId: string) => LanguageModel> = {
  anthropic: (apiKey) => createAnthropic({ apiKey }),
  openai: (apiKey) => createOpenAI({ apiKey }),
  google: (apiKey) =>
    createGoogle({
      apiKey,
      fetch: geminiSpendCapAwareFetch(
        process.env.LIAISON_DEBUG_GEMINI_REQ ? (geminiDebugFetch as never) : fetch,
      ) as never,
    }),
  mistral: (apiKey) => createMistral({ apiKey }),
  openrouter: (apiKey) => (modelId) => createOpenRouterModel(apiKey, modelId),
}

/** The scripted model at the SDK's `LanguageModel` seam (its shapes are structural). */
function scriptedModel(key: string, turnId?: string | null): LanguageModel {
  return createScriptedModel(key, turnId) as unknown as LanguageModel
}

export async function resolveModel(params: ResolveModelParams): Promise<LanguageModel> {
  const { provider, modelId, apiKey, baseURL } = params

  // E2E lane only (`LIAISON_MODEL_PROVIDER=scripted`, set by the Playwright
  // worker env, never in dev or prod): a turn on a thread the test SCRIPTED
  // replays that script instead of calling a provider, so a browser scenario
  // can drive a SERVER-side turn. Threads nobody scripted fall through to the
  // normal path below, so arming the lane changes nothing on its own.
  const scriptKey = scriptedModelEnabled()
    ? await scriptKeyFor(params.threadId, params.routineId)
    : null
  if (scriptKey) return scriptedModel(scriptKey, params.scriptTurnId)

  if (provider === "custom") {
    if (!baseURL) {
      throw new Error("Custom provider requires a baseURL")
    }
    // An org's own server: address guard, pinned connection, no redirects
    // (model-server.ts).
    return createModelServerModel({ baseURL, apiKey, name: modelId })
  }

  if (provider === "openrouter") {
    const sessionId = params.providerThreadId ?? params.threadId
    const turn = params.idleCompaction
    const turnThreadId = params.threadId
    return createOpenRouterModel(apiKey, modelId, {
      ...(params.onUnreportedGeneration
        ? { onUnreportedGeneration: params.onUnreportedGeneration }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(params.orgId ? { orgId: params.orgId } : {}),
      ...(turn && turnThreadId
        ? {
            onTurnRequest: (sent: Record<string, unknown>, pinnedHost: string | null) => {
              void import("~/modules/agent/context/warm-compaction")
                .then((m) =>
                  m.recordTurnRequest({ ...turn, threadId: turnThreadId }, sent, pinnedHost),
                )
                .catch(() => {})
            },
          }
        : {}),
    })
  }

  const factory = providerFactories[provider]
  if (!factory) {
    throw new Error(`Unknown provider: ${provider}`)
  }

  return factory(apiKey)(modelId)
}

/**
 * The model instance for a pre-checked call (A7): the one place a credit
 * check's model becomes a provider call. The model's KEY stays on the credit
 * (messages, usage rows, reasoning lookups); only the provider sees the
 * upstream id and, for an org's own server, its address.
 */
export async function resolveModelFromCredit(
  credit: {
    model: { provider: string; modelId: string; upstreamId?: string; baseURL?: string }
    providerKey: string
    /** Set by preCheck for a load org only: the call runs on the load model. */
    loadOrgId?: string
    /** The org the check ran for (preCheck sets it): its OpenRouter blocked hosts apply. */
    orgId?: string
  },
  opts: {
    threadId?: string | null
    /** See ResolveModelParams.providerThreadId. */
    providerThreadId?: string | null
    /** See ResolveModelParams.idleCompaction. */
    idleCompaction?: IdleCompactionTurn | null
    routineId?: string | null
    /** See ResolveModelParams.scriptTurnId. */
    scriptTurnId?: string | null
    onUnreportedGeneration?: (generationId: string) => void
  } = {},
): Promise<LanguageModel> {
  // A load org's call never reaches a provider (lib/load-harness.ts), re-checked
  // here so a stale credit cannot route a real org to the load model.
  if (credit.loadOrgId && (await isLoadOrg(credit.loadOrgId))) {
    return scriptedModel(await loadScriptKey(opts.threadId))
  }
  return resolveModel({
    provider: credit.model.provider,
    modelId: credit.model.upstreamId ?? credit.model.modelId,
    apiKey: credit.providerKey,
    ...(credit.model.baseURL ? { baseURL: credit.model.baseURL } : {}),
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
    ...(opts.providerThreadId ? { providerThreadId: opts.providerThreadId } : {}),
    ...(opts.idleCompaction ? { idleCompaction: opts.idleCompaction } : {}),
    ...(opts.routineId ? { routineId: opts.routineId } : {}),
    ...(opts.scriptTurnId ? { scriptTurnId: opts.scriptTurnId } : {}),
    ...(opts.onUnreportedGeneration ? { onUnreportedGeneration: opts.onUnreportedGeneration } : {}),
    ...(credit.orgId ? { orgId: credit.orgId } : {}),
  })
}

export async function selectAutoModel(
  db: Pick<PrivilegedDb, "select">,
  opts: {
    /** When given and non-empty, only models of these providers are considered. */
    providers?: readonly string[]
    /** Model ids never picked (the org's switched-off models). */
    exclude?: readonly string[]
  } = {},
): Promise<{ provider: string; modelId: string } | null> {
  const providers = (CHAT_MODEL_PROVIDERS as readonly string[]).filter(
    (p) => !opts.providers || opts.providers.length === 0 || opts.providers.includes(p),
  )
  if (providers.length === 0) return null
  const conditions = [
    eq(modelPricing.autoEligible, true),
    // A catalogue row in an added-model namespace is never a native model (A17).
    notLike(modelPricing.modelId, "openrouter/%"),
    notLike(modelPricing.modelId, "custom/%"),
    // Only chat models: the catalogue also prices non-model work (web search).
    inArray(modelPricing.provider, providers),
    ...(opts.exclude && opts.exclude.length > 0
      ? [notInArray(modelPricing.modelId, [...opts.exclude])]
      : []),
  ]
  const [row] = await db
    .select({ provider: modelPricing.provider, modelId: modelPricing.modelId })
    .from(modelPricing)
    .where(and(...conditions))
    .orderBy(
      asc(
        drizzleSql`${modelPricing.inputCostPerM}::numeric + ${modelPricing.outputCostPerM}::numeric`,
      ),
      // Stable tie-break so equal-cost models always resolve in the same order
      asc(modelPricing.modelId),
    )
    .limit(1)

  return row ?? null
}
