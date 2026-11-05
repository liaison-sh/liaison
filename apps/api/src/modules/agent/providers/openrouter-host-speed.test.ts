// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A thread starts on the cheapest OpenRouter host among those FAST ENOUGH, as
// measured on our own steps, and a live thread leaves its host only when it is
// far below the floor (openrouter-host-speed.ts, openrouter-provider-pin.ts).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Judge a host with too few samples: "a host with too few samples keeps its place" fails.
//  * Ignore slow hosts instead of moving them last: "demoted, not ignored" fails.
//  * Re-pin on a merely slow host: "a merely slow pin stays" fails.
//  * Skip the re-pin when far below: "far below the floor moves the thread" fails.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import type { HostRankingSource } from "~/modules/agent/providers/openrouter-host-ranking"
import {
  createHostSpeedSource,
  demoteSlowHosts,
  type HostSpeed,
  type HostSpeedSource,
  hostSpeedFloor,
  isBelowFloor,
  type SpeedSample,
  type SpeedStore,
  stepTokensPerSecond,
  summarize,
} from "~/modules/agent/providers/openrouter-host-speed"
import {
  type ProviderPinStore,
  providerPinFetch,
  providerPinKey,
  providerPinLog,
} from "~/modules/agent/providers/openrouter-provider-pin"
import { StepTimer } from "~/modules/agent/runtime/step-timing"

const FLOOR = { maxTtftMs: 2500, minTokensPerSecond: 50, minSamples: 5 }
const fast: HostSpeed = { samples: 10, ttftP50Ms: 900, tpsP50: 110 }
const slow: HostSpeed = { samples: 10, ttftP50Ms: 1500, tpsP50: 40 }
const farSlow: HostSpeed = { samples: 10, ttftP50Ms: 6000, tpsP50: 110 }

describe("the speed floor", () => {
  it("a host is slow on its median TTFT or its median output speed", () => {
    expect(isBelowFloor(fast, FLOOR)).toBe(false)
    expect(isBelowFloor(slow, FLOOR)).toBe(true)
    expect(isBelowFloor({ samples: 10, ttftP50Ms: 2600, tpsP50: 100 }, FLOOR)).toBe(true)
    expect(isBelowFloor({ samples: 10, ttftP50Ms: 800, tpsP50: null }, FLOOR)).toBe(false)
  })

  it("a host with too few samples keeps its place, so new hosts get measured", () => {
    expect(isBelowFloor({ ...farSlow, samples: 4 }, FLOOR)).toBe(false)
    expect(isBelowFloor(undefined, FLOOR)).toBe(false)
  })

  it("far below is twice the limits", () => {
    expect(isBelowFloor(slow, FLOOR, 2)).toBe(false)
    expect(isBelowFloor(farSlow, FLOOR, 2)).toBe(true)
    expect(isBelowFloor({ samples: 10, ttftP50Ms: 900, tpsP50: 24 }, FLOOR, 2)).toBe(true)
  })

  it("slow hosts are demoted to the end in their price order, not ignored", () => {
    const speeds = new Map([
      ["Cheap", slow],
      ["Mid", fast],
      ["Dear", fast],
      ["Cheapish", farSlow],
    ])
    expect(demoteSlowHosts(["Cheap", "Cheapish", "Mid", "Dear"], speeds, FLOOR)).toEqual({
      order: ["Mid", "Dear", "Cheap", "Cheapish"],
      slow: ["Cheap", "Cheapish"],
    })
  })

  it("defaults and env overrides", () => {
    const saved = { ...process.env }
    try {
      delete process.env.OPENROUTER_HOST_MAX_TTFT_MS
      delete process.env.OPENROUTER_HOST_MIN_TOKENS_PER_SECOND
      delete process.env.OPENROUTER_HOST_SPEED_MIN_SAMPLES
      expect(hostSpeedFloor()).toEqual(FLOOR)
      process.env.OPENROUTER_HOST_MAX_TTFT_MS = "3000"
      process.env.OPENROUTER_HOST_MIN_TOKENS_PER_SECOND = "0"
      process.env.OPENROUTER_HOST_SPEED_MIN_SAMPLES = "nope"
      expect(hostSpeedFloor()).toEqual({ maxTtftMs: 3000, minTokensPerSecond: 0, minSamples: 5 })
      // Speed rule off: only TTFT counts.
      expect(isBelowFloor(slow, hostSpeedFloor())).toBe(false)
    } finally {
      process.env = saved
    }
  })

  it("medians over the window only", () => {
    const now = 10 * 3600 * 1000
    const s = (ageH: number, ttftMs: number, tps: number | null): SpeedSample => ({
      at: now - ageH * 3600 * 1000,
      ttftMs,
      tps,
    })
    expect(
      summarize([s(1, 1000, 50), s(2, 3000, null), s(3, 2000, 70), s(7, 99999, 1)], now),
    ).toEqual({ samples: 3, ttftP50Ms: 2000, tpsP50: 60 })
  })

  it("a step's output speed counts from its first token; short steps give none", () => {
    expect(stepTokensPerSecond(300, 1000, 4000)).toBe(100)
    expect(stepTokensPerSecond(20, 1000, 1500)).toBeNull()
    expect(stepTokensPerSecond(300, 1000, 1000)).toBeNull()
  })
})

class MemorySpeedStore implements SpeedStore {
  lists = new Map<string, string[]>()
  reads = 0
  async push(key: string, value: string, keep: number) {
    this.lists.set(key, [value, ...(this.lists.get(key) ?? [])].slice(0, keep))
  }
  async range(keys: string[]) {
    this.reads++
    return keys.map((k) => this.lists.get(k) ?? null)
  }
}

describe("the shared speed samples", () => {
  it("records per model and host, keeps the last 20, and caches reads briefly", async () => {
    const store = new MemorySpeedStore()
    let t = 1_000_000
    const source = createHostSpeedSource({ store, now: () => t })
    for (let i = 0; i < 25; i++) source.record("m", "A", { ttftMs: 1000 + i, tps: 50 })
    source.record("m", "B", { ttftMs: 500, tps: null })
    await new Promise((r) => setTimeout(r, 5))
    const speeds = await source.get("m", ["A", "B", "C"])
    expect(speeds.get("A")?.samples).toBe(20)
    expect(speeds.get("B")).toEqual({ samples: 1, ttftP50Ms: 500, tpsP50: null })
    expect(speeds.has("C")).toBe(false)
    await source.get("m", ["C", "B", "A"])
    expect(store.reads).toBe(1)
    t += 31_000
    await source.get("m", ["A", "B", "C"])
    expect(store.reads).toBe(2)
  })

  it("an unreadable store ranks by price alone", async () => {
    const source = createHostSpeedSource({
      store: {
        push: async () => {},
        range: async () => {
          throw new Error("redis down")
        },
      },
    })
    expect((await source.get("m", ["A"])).size).toBe(0)
  })
})

describe("the step timer", () => {
  it("measures TTFT and model time per step, and the step from the previous step's end", () => {
    let t = 0
    const timer = new StepTimer(() => t)
    t = 100
    timer.callStart()
    t = 1100
    timer.chunk()
    t = 1200
    timer.chunk()
    t = 3100
    timer.callEnd()
    t = 3150
    expect(timer.stepFinished()).toEqual({ ttftMs: 1000, modelMs: 3000, stepMs: 3150 })
    t = 3500 // tools ran
    timer.callStart()
    t = 4000
    timer.callEnd()
    t = 4000
    expect(timer.stepFinished()).toEqual({ ttftMs: null, modelMs: 500, stepMs: 850 })
  })
})

// ── the pin ────────────────────────────────────────────────────────────────

const MODEL = "deepseek/deepseek-v4.1-flash"
const THREAD = "00000000-0000-4000-8000-0000000000f1"
const RANKING: HostRankingSource = {
  get: async () => ({ order: ["Cheap", "Mid", "Dear"], ignore: ["NoCache"] }),
}

class MemoryPinStore implements ProviderPinStore {
  map = new Map<string, string>()
  async get(key: string) {
    return this.map.get(key) ?? null
  }
  async set(key: string, host: string, onlyIfAbsent: boolean) {
    if (onlyIfAbsent && this.map.has(key)) return
    this.map.set(key, host)
  }
}

function speedsOf(entries: Record<string, HostSpeed>): HostSpeedSource {
  return { record() {}, get: async () => new Map(Object.entries(entries)) }
}

/** Answers from the first host of the request's order, as OpenRouter does when it is up. */
function upstream() {
  const bodies: Array<Record<string, unknown>> = []
  const f = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const host = ((body.provider as { order?: string[] }).order ?? ["?"])[0]
    return new Response(JSON.stringify({ id: "g", provider: host, choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { bodies, fetch: Object.assign(f, { preconnect: fetch.preconnect }) as typeof fetch }
}

async function call(f: typeof fetch) {
  const res = await f("https://openrouter.test/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  })
  await res.text()
  await new Promise((r) => setTimeout(r, 5))
}

const orderOf = (b: Record<string, unknown> | undefined) =>
  (b?.provider as { order?: string[] } | undefined)?.order

describe("the pin with the speed floor", () => {
  afterEach(() => {})

  it("a new thread starts on the cheapest host that is fast enough", async () => {
    const store = new MemoryPinStore()
    const up = upstream()
    const f = providerPinFetch(up.fetch, THREAD, store, RANKING, {
      speeds: speedsOf({ Cheap: slow, Mid: fast }),
    })
    await call(f)
    expect(orderOf(up.bodies[0])).toEqual(["Mid", "Dear", "Cheap"])
    expect(store.map.get(providerPinKey(THREAD, MODEL))).toBe("Mid")
  })

  it("a merely slow pin stays: a switch would re-read the prompt uncached", async () => {
    const store = new MemoryPinStore()
    store.map.set(providerPinKey(THREAD, MODEL), "Cheap")
    const up = upstream()
    const f = providerPinFetch(up.fetch, THREAD, store, RANKING, {
      speeds: speedsOf({ Cheap: slow, Mid: fast }),
    })
    await call(f)
    expect(orderOf(up.bodies[0])?.[0]).toBe("Cheap")
    expect(store.map.get(providerPinKey(THREAD, MODEL))).toBe("Cheap")
  })

  it("a pin far below the floor moves the thread to a fast host, logged with reason slow", async () => {
    const warn = spyOn(providerPinLog, "warn")
    try {
      const store = new MemoryPinStore()
      store.map.set(providerPinKey(THREAD, MODEL), "Cheap")
      const up = upstream()
      const f = providerPinFetch(up.fetch, THREAD, store, RANKING, {
        speeds: speedsOf({ Cheap: farSlow, Mid: fast }),
      })
      await call(f)
      expect(orderOf(up.bodies[0])).toEqual(["Mid", "Dear", "Cheap"])
      expect(store.map.get(providerPinKey(THREAD, MODEL))).toBe("Mid")
      const switched = warn.mock.calls.find(
        (c) => (c[0] as { event?: string }).event === "provider_pin_switched",
      )
      expect(switched?.[0]).toMatchObject({ from: "Cheap", to: "Mid", reason: "slow" })
    } finally {
      warn.mockRestore()
    }
  })

  it("a pin far below the floor stays when no other host is known fast enough", async () => {
    const store = new MemoryPinStore()
    store.map.set(providerPinKey(THREAD, MODEL), "Cheap")
    const up = upstream()
    const f = providerPinFetch(up.fetch, THREAD, store, RANKING, {
      speeds: speedsOf({ Cheap: farSlow, Mid: slow, Dear: slow }),
    })
    await call(f)
    expect(orderOf(up.bodies[0])?.[0]).toBe("Cheap")
  })
})
