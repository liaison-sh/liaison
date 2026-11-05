// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE COST OF A STREAM THAT STOPPED BEFORE ITS USAGE, FROM OPENROUTER'S RECORD.
//
// A turn stopped mid-step (its time limit, a newer request, a client that went
// away) never reads the usage of the step in flight, and OpenRouter bills that
// step all the same. The OpenRouter model hears the generation id of such a
// stream (openrouter.ts, `onUnreportedGeneration`); this reads what the
// generation cost from `GET /generation?id=` and writes it as the org's usage
// row, at OpenRouter's own figure. The record appears a few seconds after the
// generation ends, so the read is retried.
//
// A demo visitor's box key step needs nothing more for its BUDGET: the step
// meter already settled that step at its reserved maximum (credit-meter.ts,
// "SENT IS BILLED"). The row written here is the org's usage, which the meter
// does not touch.
import { rootLogger } from "~/lib/logger"
import { finalizeUsage } from "~/modules/agent/credits/credit-meter"
import { openRouterFetch } from "~/modules/agent/providers/openrouter"

const log = rootLogger.child({ module: "unreported-generations" })

/** What OpenRouter's generation record says one generation cost. */
export interface GenerationRecord {
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/** Read one generation's record; null while it is not there yet (or never will be). */
async function readGeneration(apiKey: string, id: string): Promise<GenerationRecord | null> {
  const res = await openRouterFetch(`/generation?id=${encodeURIComponent(id)}`, { apiKey })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as {
    data?: {
      total_cost?: unknown
      tokens_prompt?: unknown
      tokens_completion?: unknown
      native_tokens_prompt?: unknown
      native_tokens_completion?: unknown
    }
  } | null
  const d = body?.data
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null)
  const cost = num(d?.total_cost)
  if (cost === null) return null
  return {
    costUsd: cost,
    inputTokens: num(d?.native_tokens_prompt) ?? num(d?.tokens_prompt) ?? 0,
    outputTokens: num(d?.native_tokens_completion) ?? num(d?.tokens_completion) ?? 0,
  }
}

export const UnreportedGenerationsTestAccess = {
  /** Delays between reads, ms (tests shorten them). */
  delays: [2_000, 4_000, 8_000, 15_000, 30_000] as number[],
}

/**
 * Write a usage row for each generation that stopped before its usage came back, at the cost
 * OpenRouter recorded for it. Never throws: the turn it belongs to is already over. Resolves
 * once every id is written or given up on.
 */
export async function recordUnreportedGenerations(
  orgId: string,
  params: {
    generationIds: readonly string[]
    apiKey: string
    /** The usage row's model key (the turn's own). */
    modelId: string
    keySource: "liaison" | "byok"
    userId: string
  },
): Promise<void> {
  for (const id of new Set(params.generationIds)) {
    try {
      let record: GenerationRecord | null = null
      for (const wait of [0, ...UnreportedGenerationsTestAccess.delays]) {
        if (wait > 0) await Bun.sleep(wait)
        record = await readGeneration(params.apiKey, id).catch(() => null)
        if (record) break
      }
      if (!record) {
        log.warn({ orgId, generationId: id }, "no OpenRouter record for a stopped generation")
        continue
      }
      await finalizeUsage(orgId, {
        model: {
          provider: "openrouter",
          modelId: params.modelId,
          inputCostPerM: "0",
          outputCostPerM: "0",
        },
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        providerCostUsd: record.costUsd,
        keySource: params.keySource,
        userId: params.userId,
        // The turn's own reservation is the turn's business, already settled.
        releaseReservation: false,
        description: "a step stopped before its usage came back: OpenRouter's record of it",
      })
    } catch (err) {
      log.warn({ err, orgId, generationId: id }, "failed to record a stopped generation")
    }
  }
}
