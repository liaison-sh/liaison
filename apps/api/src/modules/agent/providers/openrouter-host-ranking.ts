// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ── WHICH HOST A THREAD STARTS ON ──────────────────────────────────────────
// A thread keeps the upstream host its first request lands on
// (openrouter-provider-pin.ts), so that first landing decides what the whole
// thread costs. The hosts of one model differ a lot in price (up to ~14x on a
// cheap model), and a turn's input is mostly cached reads, so a host is ranked
// by its CACHED price first: score = 0.8 x cache-read price + 0.2 x prompt price.
// A host whose cache read is not really discounted (cache read >= 50% of its
// prompt price, or no cache price at all) is excluded: its cache saves almost
// nothing. OpenRouter's own `sort: "price"` ranks by the prompt price only, so
// the ranking is ours, sent as `provider.order` (best first) with the excluded
// hosts in `provider.ignore` and `allow_fallbacks: true`.
//
// The ranking comes from OpenRouter's public endpoints list for the model,
// cached in Redis (one entry per model, shared by every process) and refreshed
// in the background once older than RANKING_FRESH_SECONDS. A request never
// waits for it: with no ranking at hand (first sight of a model, endpoints API
// or Redis down) the first request asks for `sort: "price"` and nothing else.
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "openrouter-host-ranking" })

/** Weight of the cache-read price in a host's score; the prompt price has the rest. */
export const CACHE_READ_WEIGHT = 0.8
/** A host whose cache read costs this share of its prompt price or more is excluded. */
export const MAX_CACHE_READ_SHARE = 0.5
/** A ranking older than this is refreshed in the background (it is still used meanwhile). */
export const RANKING_FRESH_SECONDS = 60 * 60
/** A ranking older than this is gone. */
const RANKING_TTL_SECONDS = 6 * 60 * 60
/** After a failed refresh, this process waits this long before it tries again. */
const REFRESH_RETRY_MS = 60 * 1000
const READ_TIMEOUT_MS = 500

export interface HostRanking {
  /** Eligible hosts, best (cheapest) first. */
  order: string[]
  /** Hosts excluded for a cache read that is not meaningfully discounted. */
  ignore: string[]
}

interface EndpointPricing {
  prompt?: unknown
  input_cache_read?: unknown
}

export interface ModelEndpoint {
  provider_name?: unknown
  pricing?: EndpointPricing
}

function price(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The score of one endpoint (lower is cheaper), or null when the cache rule excludes it. */
export function endpointScore(pricing: EndpointPricing | undefined): number | null {
  const prompt = price(pricing?.prompt)
  const cache = price(pricing?.input_cache_read)
  if (prompt === null || cache === null || prompt <= 0) return null
  if (cache >= MAX_CACHE_READ_SHARE * prompt) return null
  return CACHE_READ_WEIGHT * cache + (1 - CACHE_READ_WEIGHT) * prompt
}

/**
 * Rank a model's hosts from its endpoints. A host with several endpoints
 * (quantizations, tiers) counts at its best eligible one; a host none of whose
 * endpoints passes the cache rule is ignored.
 */
export function rankHosts(endpoints: ModelEndpoint[]): HostRanking {
  const best = new Map<string, number | null>()
  for (const e of endpoints) {
    const name = typeof e.provider_name === "string" ? e.provider_name : ""
    if (!name) continue
    const score = endpointScore(e.pricing)
    const prev = best.get(name) ?? null
    best.set(name, prev === null ? score : score === null ? prev : Math.min(prev, score))
  }
  const ranked: Array<[string, number]> = []
  const ignore: string[] = []
  for (const [name, score] of best) {
    if (score === null) ignore.push(name)
    else ranked.push([name, score])
  }
  ranked.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  return { order: ranked.map(([name]) => name), ignore: ignore.sort() }
}

/** The `provider` fields of a thread's first request (no pin yet). */
export function firstRequestRouting(ranking: HostRanking | null): Record<string, unknown> {
  if (!ranking || ranking.order.length === 0) return { sort: "price" }
  return {
    order: ranking.order,
    ...(ranking.ignore.length ? { ignore: ranking.ignore } : {}),
    allow_fallbacks: true,
  }
}

/**
 * The `provider` fields of a pinned request: the pin first, then the ranking,
 * so the host OpenRouter falls back to when the pin fails is the next best one.
 * The pin itself is never ignored (it may predate the rule).
 */
export function pinnedRouting(pin: string, ranking: HostRanking | null): Record<string, unknown> {
  const rest = ranking ? ranking.order.filter((h) => h !== pin) : []
  const ignore = ranking ? ranking.ignore.filter((h) => h !== pin) : []
  return {
    order: [pin, ...rest],
    ...(ignore.length ? { ignore } : {}),
    allow_fallbacks: true,
  }
}

interface StoredRanking extends HostRanking {
  /** Epoch ms of the fetch. */
  at: number
}

export interface RankingStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export interface HostRankingSource {
  /** The model's ranking if one is at hand; never waits on the endpoints API. */
  get(model: string): Promise<HostRanking | null>
}

const redisRankingStore: RankingStore = {
  async get(key) {
    const { redis } = await import("~/lib/redis")
    return redis.get(key)
  },
  async set(key, value, ttlSeconds) {
    const { redis } = await import("~/lib/redis")
    await redis.set(key, value, "EX", ttlSeconds)
  },
}

async function fetchEndpointsFromOpenRouter(model: string): Promise<ModelEndpoint[]> {
  const { openRouterFetch } = await import("~/modules/agent/providers/openrouter")
  const res = await openRouterFetch(`/models/${model}/endpoints`)
  if (!res.ok) throw new Error(`OpenRouter endpoints for ${model}: HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { endpoints?: unknown } }
  const endpoints = body.data?.endpoints
  if (!Array.isArray(endpoints)) throw new Error(`OpenRouter endpoints for ${model}: no list`)
  return endpoints as ModelEndpoint[]
}

export function hostRankingKey(model: string): string {
  return `openrouter:host-ranking:${model}`
}

/** A ranking source over a store and the endpoints API (both injectable for tests). */
export function createHostRankingSource(
  deps: {
    store?: RankingStore
    fetchEndpoints?: (model: string) => Promise<ModelEndpoint[]>
    now?: () => number
  } = {},
): HostRankingSource & { refresh(model: string): Promise<void> } {
  const store = deps.store ?? redisRankingStore
  const fetchEndpoints = deps.fetchEndpoints ?? fetchEndpointsFromOpenRouter
  const now = deps.now ?? Date.now
  const inFlight = new Map<string, Promise<void>>()
  const failedAt = new Map<string, number>()

  const refresh = (model: string): Promise<void> => {
    const running = inFlight.get(model)
    if (running) return running
    const run = (async () => {
      try {
        const ranking = rankHosts(await fetchEndpoints(model))
        const stored: StoredRanking = { ...ranking, at: now() }
        await store.set(hostRankingKey(model), JSON.stringify(stored), RANKING_TTL_SECONDS)
        failedAt.delete(model)
      } catch (err) {
        failedAt.set(model, now())
        log.warn(
          { err, model },
          "OpenRouter host ranking refresh failed; first requests sort by price",
        )
      } finally {
        inFlight.delete(model)
      }
    })()
    inFlight.set(model, run)
    return run
  }

  const refreshInBackground = (model: string) => {
    const failed = failedAt.get(model)
    if (failed !== undefined && now() - failed < REFRESH_RETRY_MS) return
    void refresh(model)
  }

  return {
    refresh,
    async get(model) {
      let raw: string | null = null
      try {
        raw = await Promise.race([
          store.get(hostRankingKey(model)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
        ])
      } catch (err) {
        log.warn({ err, model }, "OpenRouter host ranking read failed")
      }
      let stored: StoredRanking | null = null
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as StoredRanking
          if (Array.isArray(parsed.order) && Array.isArray(parsed.ignore)) stored = parsed
        } catch {
          stored = null
        }
      }
      if (!stored || now() - stored.at > RANKING_FRESH_SECONDS * 1000) refreshInBackground(model)
      return stored ? { order: stored.order, ignore: stored.ignore } : null
    },
  }
}

export const defaultHostRankingSource = createHostRankingSource()
