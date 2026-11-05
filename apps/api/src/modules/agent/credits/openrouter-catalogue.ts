// SPDX-License-Identifier: FSL-1.1-ALv2
//
// OPENROUTER'S MODEL CATALOGUE, as the AI models page and the price job read
// it: one public `GET /models` call, mapped to what an added model's entry
// holds (prices in EUR per million tokens at the pricing sync's ECB rate,
// whether it calls tools, which reasoning efforts it takes), cached in Redis
// for an hour so a page of admins searching it costs one fetch.
import type { AddedModel } from "@liaison/shared"
import { currentUsdEurRate, usdPerTokenToEurPerM } from "~/infra/jobs/sync-model-pricing"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { openRouterModelKey } from "~/modules/agent/credits/model-keys"
import { openRouterBaseURL, openRouterFetch } from "~/modules/agent/providers/openrouter"

const log = rootLogger.child({ module: "openrouter-catalogue" })

export const OPENROUTER_CATALOGUE_CACHE_KEY = "openrouter:catalogue"
const CACHE_TTL_SECONDS = 60 * 60
const FETCH_TIMEOUT_MS = 20_000

export interface OpenRouterCatalogueModel {
  upstreamId: string
  displayName: string
  contextWindow: number
  /** EUR per million tokens; null when OpenRouter gives no price. */
  inputCostPerM: string | null
  outputCostPerM: string | null
  tools: boolean
  reasoningEfforts: Array<"low" | "medium" | "high">
  canDisableReasoning: boolean
}

export class OpenRouterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenRouterUnavailableError"
  }
}

interface RawOpenRouterModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  supported_parameters?: unknown
  reasoning?: { supported_efforts?: unknown; mandatory?: unknown }
}

const EFFORTS = ["low", "medium", "high"] as const

function eurPerM(raw: unknown, rate: number): string | null {
  const perToken = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN
  // OpenRouter marks a dynamic price (routers) with a negative number.
  if (!Number.isFinite(perToken) || perToken < 0) return null
  return usdPerTokenToEurPerM(perToken, rate)
}

/**
 * One catalogue row as an added model would carry it (A10): the efforts are
 * the model's `supported_efforts` among low/medium/high, and reasoning can be
 * switched off when "none" is one of them and reasoning is not mandatory.
 */
export function mapOpenRouterModel(
  raw: RawOpenRouterModel,
  usdPerEur: number,
): OpenRouterCatalogueModel | null {
  if (typeof raw.id !== "string" || !raw.id) return null
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
  const supported = Array.isArray(raw.reasoning?.supported_efforts)
    ? (raw.reasoning?.supported_efforts as unknown[])
    : []
  const reasoningEfforts = EFFORTS.filter((e) => supported.includes(e))
  return {
    upstreamId: raw.id,
    displayName: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    contextWindow:
      typeof raw.context_length === "number" && raw.context_length > 0
        ? Math.floor(raw.context_length)
        : 32_768,
    inputCostPerM: eurPerM(raw.pricing?.prompt, usdPerEur),
    outputCostPerM: eurPerM(raw.pricing?.completion, usdPerEur),
    tools: params.includes("tools"),
    reasoningEfforts,
    canDisableReasoning: supported.includes("none") && raw.reasoning?.mandatory !== true,
  }
}

async function fetchFresh(): Promise<OpenRouterCatalogueModel[]> {
  const url = `${openRouterBaseURL()}/models`
  let res: Response
  try {
    res = await openRouterFetch("/models", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    log.warn({ err, url }, "OpenRouter catalogue fetch failed")
    throw new OpenRouterUnavailableError("OpenRouter could not be reached. Try again in a moment.")
  }
  if (!res.ok) {
    log.warn({ status: res.status, url }, "OpenRouter catalogue answered with an error")
    throw new OpenRouterUnavailableError(
      `OpenRouter could not be reached (HTTP ${res.status}). Try again in a moment.`,
    )
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  if (!body || !Array.isArray(body.data)) {
    throw new OpenRouterUnavailableError("OpenRouter sent a catalogue this version cannot read.")
  }
  const rate = await currentUsdEurRate()
  const out: OpenRouterCatalogueModel[] = []
  for (const raw of body.data as RawOpenRouterModel[]) {
    const mapped = mapOpenRouterModel(raw, rate)
    if (mapped) out.push(mapped)
  }
  return out
}

/** The whole catalogue, from the hour cache or one fetch. */
export async function getOpenRouterCatalogue(
  opts: { fresh?: boolean } = {},
): Promise<OpenRouterCatalogueModel[]> {
  if (!opts.fresh) {
    try {
      const cached = await redis.get(OPENROUTER_CATALOGUE_CACHE_KEY)
      if (cached) return JSON.parse(cached) as OpenRouterCatalogueModel[]
    } catch (err) {
      log.warn({ err }, "OpenRouter catalogue cache read failed")
    }
  }
  const models = await fetchFresh()
  try {
    await redis.set(OPENROUTER_CATALOGUE_CACHE_KEY, JSON.stringify(models), "EX", CACHE_TTL_SECONDS)
  } catch (err) {
    log.warn({ err }, "OpenRouter catalogue cache write failed")
  }
  return models
}

/** Catalogue rows matching a search, tools-only by default, at most `limit`. */
export function filterCatalogue(
  models: OpenRouterCatalogueModel[],
  opts: { q?: string; toolsOnly?: boolean; limit?: number },
): OpenRouterCatalogueModel[] {
  const q = (opts.q ?? "").trim().toLowerCase()
  const toolsOnly = opts.toolsOnly ?? true
  const limit = opts.limit ?? 200
  const out: OpenRouterCatalogueModel[] = []
  for (const m of models) {
    if (toolsOnly && !m.tools) continue
    if (q && !m.upstreamId.toLowerCase().includes(q) && !m.displayName.toLowerCase().includes(q))
      continue
    out.push(m)
    if (out.length >= limit) break
  }
  return out
}

/** The EUR prices, tools flag and efforts an OpenRouter entry carries. */
export function openRouterEntry(cat: OpenRouterCatalogueModel, now: string): AddedModel {
  return {
    key: openRouterModelKey(cat.upstreamId),
    provider: "openrouter",
    upstreamId: cat.upstreamId,
    displayName: cat.displayName,
    contextWindow: cat.contextWindow,
    inputCostPerM: cat.inputCostPerM,
    outputCostPerM: cat.outputCostPerM,
    tools: cat.tools,
    reasoningEfforts: cat.reasoningEfforts,
    canDisableReasoning: cat.canDisableReasoning,
    enabled: true,
    addedAt: now,
    priceUpdatedAt: now,
  }
}
