// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a thread starts on OpenRouter: hosts ranked by cached price first, hosts
// without a real cache discount ignored, the ranking cached and refreshed in the
// background, never waited for (openrouter-host-ranking.ts).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Rank by prompt price only: "ranks by cached price first" fails (Parasail's cheap
//    cache would lose to OpenInference's cheap prompt).
//  * Drop the 50% rule: "ignores hosts whose cache read is not discounted" fails.
//  * Await the endpoints fetch in get(): "never waits" fails (the fetch never resolves).
//  * Throw from get() when the store fails: "store failure" fails.
import { describe, expect, it } from "bun:test"
import {
  createHostRankingSource,
  endpointScore,
  firstRequestRouting,
  hostRankingKey,
  type ModelEndpoint,
  pinnedRouting,
  RANKING_FRESH_SECONDS,
  type RankingStore,
  rankHosts,
} from "~/modules/agent/providers/openrouter-host-ranking"

const M = 1e-6
function ep(name: string, prompt: number, cache?: number): ModelEndpoint {
  return {
    provider_name: name,
    pricing: {
      prompt: String(prompt * M),
      ...(cache !== undefined ? { input_cache_read: String(cache * M) } : {}),
    },
  }
}

// deepseek/deepseek-v4.1-flash, USD per 1M tokens (endpoints API, 2026-10-30, abridged).
const TODAY = [
  ep("Morph", 0.022, 0.004),
  ep("Wafer", 0.045, 0.006),
  ep("Parasail", 0.3, 0.006),
  ep("Together", 0.3, 0.006),
  ep("OpenInference", 0.0433, 0.0399),
  ep("NoCache", 0.01),
  ep("DeepInfra", 0.14, 0.028),
  ep("DeepInfra", 0.07, 0.014), // a second, cheaper endpoint of the same host
]

class MemoryRankingStore implements RankingStore {
  map = new Map<string, string>()
  fail = false
  async get(key: string) {
    if (this.fail) throw new Error("redis down")
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string) {
    if (this.fail) throw new Error("redis down")
    this.map.set(key, value)
  }
}

describe("OpenRouter host ranking", () => {
  it("ranks by cached price first (80/20), a host at its best endpoint", () => {
    expect(rankHosts(TODAY).order).toEqual(["Morph", "Wafer", "DeepInfra", "Parasail", "Together"])
    expect(endpointScore(TODAY[0]?.pricing)).toBeCloseTo((0.8 * 0.004 + 0.2 * 0.022) * M, 12)
  })

  it("ignores hosts whose cache read is not discounted (>= 50% of prompt, or none)", () => {
    expect(rankHosts(TODAY).ignore).toEqual(["NoCache", "OpenInference"])
    expect(endpointScore(ep("Half", 0.1, 0.05).pricing)).toBeNull()
    expect(endpointScore(ep("JustUnder", 0.1, 0.049).pricing)).not.toBeNull()
  })

  it("builds the first request's routing, and price sort when there is no ranking", () => {
    expect(firstRequestRouting(rankHosts(TODAY))).toEqual({
      order: ["Morph", "Wafer", "DeepInfra", "Parasail", "Together"],
      ignore: ["NoCache", "OpenInference"],
      allow_fallbacks: true,
    })
    expect(firstRequestRouting(null)).toEqual({ sort: "price" })
    expect(firstRequestRouting({ order: [], ignore: ["X"] })).toEqual({ sort: "price" })
  })

  it("keeps the pin first and the ranking after it", () => {
    expect(pinnedRouting("Wafer", rankHosts(TODAY))).toEqual({
      order: ["Wafer", "Morph", "DeepInfra", "Parasail", "Together"],
      ignore: ["NoCache", "OpenInference"],
      allow_fallbacks: true,
    })
    expect(pinnedRouting("Wafer", null)).toEqual({ order: ["Wafer"], allow_fallbacks: true })
  })

  it("never waits: a miss returns null at once and fills the cache in the background", async () => {
    const store = new MemoryRankingStore()
    let release: (e: ModelEndpoint[]) => void = () => {}
    const src = createHostRankingSource({
      store,
      fetchEndpoints: () => new Promise((r) => (release = r)),
    })
    expect(await src.get("m")).toBeNull()
    release(TODAY)
    await new Promise((r) => setTimeout(r, 5))
    expect((await src.get("m"))?.order[0]).toBe("Morph")
  })

  it("serves a stale ranking while it refreshes it", async () => {
    const store = new MemoryRankingStore()
    let t = 0
    let fetches = 0
    const src = createHostRankingSource({
      store,
      now: () => t,
      fetchEndpoints: async () => {
        fetches++
        return fetches === 1 ? TODAY : [ep("Wafer", 0.045, 0.006)]
      },
    })
    await src.refresh("m")
    t = (RANKING_FRESH_SECONDS + 1) * 1000
    expect((await src.get("m"))?.order[0]).toBe("Morph") // stale, still used
    await new Promise((r) => setTimeout(r, 5))
    expect(await src.get("m")).toEqual({ order: ["Wafer"], ignore: [] })
  })

  it("an endpoints failure or a store failure leaves no ranking, never an error", async () => {
    const store = new MemoryRankingStore()
    let fetches = 0
    const src = createHostRankingSource({
      store,
      fetchEndpoints: async () => {
        fetches++
        throw new Error("HTTP 503")
      },
    })
    expect(await src.get("m")).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    expect(store.map.has(hostRankingKey("m"))).toBe(false)
    // A failed refresh is not retried on every request.
    await src.get("m")
    expect(fetches).toBe(1)
    store.fail = true
    expect(await src.get("m")).toBeNull()
  })
})
