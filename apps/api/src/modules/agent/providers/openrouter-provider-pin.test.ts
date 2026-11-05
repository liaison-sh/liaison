// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A thread stays on the OpenRouter upstream host its first request landed on,
// and moves only when OpenRouter had to serve it elsewhere (openrouter-provider-pin.ts).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the `order` injection: "names the pinned host" fails.
//  * Send `allow_fallbacks: false`: the same test fails (an outage would fail the turn).
//  * Overwrite the pin when the request carried none: "keeps the pin another request set" fails.
//  * Re-pin or log on a response from the pinned host: "no switch otherwise" fails.
//  * Skip the re-pin after a fallback: "switches only on a forced fallback" fails.
//  * Drop `applyHostDenyList` from providerPinFetch: every "deny-list" test fails.
//  * Honour a pin on a denied host: "a pin on a denied host is not honoured" fails.
//  * Match the deny-list case-sensitively: "matches any case" fails.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { generateText, streamText } from "ai"
import { env } from "~/lib/env"
import {
  createBlockedHostsSource,
  parseHostDenyList,
} from "~/modules/agent/providers/openrouter-blocked-hosts"
import type { HostRankingSource } from "~/modules/agent/providers/openrouter-host-ranking"
import {
  applyHostDenyList,
  type ProviderPinStore,
  providerPinFetch,
  providerPinKey,
  providerPinLog,
  readResponseProvider,
} from "~/modules/agent/providers/openrouter-provider-pin"
import { resolveModel } from "~/modules/agent/providers/provider"

const MODEL = "deepseek/deepseek-v4.1-flash"
/** No ranking at hand: first requests sort by price (openrouter-host-ranking.ts). */
const NO_RANKING: HostRankingSource = { get: async () => null }
const THREAD = "00000000-0000-4000-8000-000000000001"

class MemoryStore implements ProviderPinStore {
  map = new Map<string, string>()
  writes: Array<{ key: string; host: string; onlyIfAbsent: boolean }> = []
  async get(key: string) {
    return this.map.get(key) ?? null
  }
  async set(key: string, host: string, onlyIfAbsent: boolean) {
    this.writes.push({ key, host, onlyIfAbsent })
    if (onlyIfAbsent && this.map.has(key)) return
    this.map.set(key, host)
  }
}

function json(host: string): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      provider: host,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function sse(host: string): Response {
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
  const body =
    chunk({
      id: "gen-1",
      provider: host,
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
    }) +
    chunk({
      id: "gen-1",
      provider: host,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }) +
    "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** A fake upstream that answers from `hosts` in turn and records each request body. */
function upstream(hosts: string[], stream = false) {
  const bodies: Array<Record<string, unknown>> = []
  let i = 0
  const f = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const host = hosts[Math.min(i++, hosts.length - 1)] as string
    return stream ? sse(host) : json(host)
  }
  return { bodies, fetch: Object.assign(f, { preconnect: fetch.preconnect }) as typeof fetch }
}

function providerOf(body: Record<string, unknown> | undefined): Record<string, unknown> {
  return (body?.provider ?? {}) as Record<string, unknown>
}

function orderOf(body: Record<string, unknown> | undefined): unknown {
  return (body?.provider as Record<string, unknown> | undefined)?.order
}

async function call(f: typeof fetch, stream = false): Promise<void> {
  const res = await f("https://openrouter.test/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      provider: { data_collection: "deny", require_parameters: true },
      ...(stream ? { stream: true } : {}),
    }),
  })
  await res.text()
  // Let the fire-and-forget pin write land.
  await new Promise((r) => setTimeout(r, 5))
}

const key = providerPinKey(THREAD, MODEL)
let spies: Array<{ mockRestore(): void }> = []
const DEFAULT_DENIED = env.LIAISON_OPENROUTER_IGNORE_HOSTS
afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
  delete process.env.OPENROUTER_BASE_URL
  env.LIAISON_OPENROUTER_IGNORE_HOSTS = DEFAULT_DENIED
})

describe("OpenRouter provider pin", () => {
  // These cover the pin itself, with no host deny-list (an empty setting changes nothing).
  beforeEach(() => {
    env.LIAISON_OPENROUTER_IGNORE_HOSTS = ""
  })

  it("pins the host the thread's first request landed on (JSON and stream)", async () => {
    for (const stream of [false, true]) {
      const store = new MemoryStore()
      const up = upstream(["Morph"], stream)
      await call(providerPinFetch(up.fetch, THREAD, store, NO_RANKING), stream)
      expect(store.map.get(key)).toBe("Morph")
      // The first request had no pin and no ranking: price sort, no order.
      expect(orderOf(up.bodies[0])).toBeUndefined()
      expect(providerOf(up.bodies[0]).sort).toBe("price")
    }
  })

  it("hands each request, as sent with its pin, to the turn observer (idle compaction)", async () => {
    const store = new MemoryStore()
    const up = upstream(["Morph", "Morph"])
    const seen: Array<{ body: Record<string, unknown>; host: string | null }> = []
    const f = providerPinFetch(up.fetch, THREAD, store, NO_RANKING, {
      onSent: (body, host) => seen.push({ body, host }),
    })
    await call(f)
    await call(f)
    expect(seen.map((s) => s.host)).toEqual([null, "Morph"])
    // Exactly the bytes the upstream received.
    expect(seen.map((s) => s.body)).toEqual(up.bodies)
  })

  it("a throwing observer never fails the request", async () => {
    const up = upstream(["Morph"])
    const f = providerPinFetch(up.fetch, THREAD, new MemoryStore(), NO_RANKING, {
      onSent: () => {
        throw new Error("observer down")
      },
    })
    await call(f)
    expect(up.bodies).toHaveLength(1)
  })

  it("names the pinned host on every later request, fallbacks still allowed, routing kept", async () => {
    const store = new MemoryStore()
    const up = upstream(["Morph", "Morph", "Morph"], true)
    const f = providerPinFetch(up.fetch, THREAD, store, NO_RANKING)
    for (let n = 0; n < 3; n++) await call(f, true)
    for (const body of up.bodies.slice(1)) {
      expect(body.provider).toEqual({
        data_collection: "deny",
        require_parameters: true,
        order: ["Morph"],
        allow_fallbacks: true,
      })
    }
  })

  it("survives a process restart: a new fetch reads the pin from the shared store", async () => {
    const store = new MemoryStore()
    store.map.set(key, "Wafer")
    const up = upstream(["Wafer"])
    await call(providerPinFetch(up.fetch, THREAD, store, NO_RANKING))
    expect(orderOf(up.bodies[0])).toEqual(["Wafer"])
  })

  it("no switch otherwise: a response from the pinned host writes nothing and logs nothing", async () => {
    const store = new MemoryStore()
    store.map.set(key, "Morph")
    const warn = spyOn(providerPinLog, "warn")
    spies.push(warn)
    const up = upstream(["Morph", "Morph"])
    const f = providerPinFetch(up.fetch, THREAD, store, NO_RANKING)
    await call(f)
    await call(f)
    expect(store.writes).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it("switches only on a forced fallback: re-pins the new host and logs provider_pin_switched", async () => {
    const store = new MemoryStore()
    store.map.set(key, "Morph")
    const warn = spyOn(providerPinLog, "warn")
    spies.push(warn)
    // The pinned host failed, OpenRouter fell back to Wafer; the next request names Wafer.
    const up = upstream(["Wafer", "Wafer"], true)
    const f = providerPinFetch(up.fetch, THREAD, store, NO_RANKING)
    await call(f, true)
    expect(store.map.get(key)).toBe("Wafer")
    const logged = warn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(logged).toMatchObject({
      event: "provider_pin_switched",
      from: "Morph",
      to: "Wafer",
      reason: "pinned_host_unavailable",
    })
    await call(f, true)
    expect(orderOf(up.bodies[1])).toEqual(["Wafer"])
  })

  it("keeps the pin another request of the thread set first (no pin sent, no overwrite)", async () => {
    const store = new MemoryStore()
    const up = upstream(["Wafer"])
    const f = providerPinFetch(up.fetch, THREAD, store, NO_RANKING)
    const pending = call(f)
    store.map.set(key, "Morph") // a concurrent request pinned Morph meanwhile
    await pending
    expect(store.map.get(key)).toBe("Morph")
    expect(store.writes[0]?.onlyIfAbsent).toBe(true)
  })

  it("pins per model: another model of the same thread has its own pin", async () => {
    const store = new MemoryStore()
    store.map.set(providerPinKey(THREAD, "other/model"), "Morph")
    const up = upstream(["DeepInfra"])
    await call(providerPinFetch(up.fetch, THREAD, store, NO_RANKING))
    expect(orderOf(up.bodies[0])).toBeUndefined()
    expect(store.map.get(key)).toBe("DeepInfra")
  })

  it("a failing store never fails the call: the request goes unpinned", async () => {
    const broken: ProviderPinStore = {
      get: async () => {
        throw new Error("redis down")
      },
      set: async () => {
        throw new Error("redis down")
      },
    }
    const up = upstream(["Morph"])
    await call(providerPinFetch(up.fetch, THREAD, broken, NO_RANKING))
    expect(up.bodies).toHaveLength(1)
  })

  it("starts a thread on the ranking and falls back along it after the pin", async () => {
    const ranked: HostRankingSource = {
      get: async () => ({ order: ["Morph", "Wafer", "Parasail"], ignore: ["NoCacheHost"] }),
    }
    const store = new MemoryStore()
    const up = upstream(["Morph", "Morph"])
    const f = providerPinFetch(up.fetch, THREAD, store, ranked)
    await call(f)
    expect(up.bodies[0]?.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      order: ["Morph", "Wafer", "Parasail"],
      ignore: ["NoCacheHost"],
      allow_fallbacks: true,
    })
    await call(f)
    expect(orderOf(up.bodies[1])).toEqual(["Morph", "Wafer", "Parasail"])
    // A pin on a host the rule now ignores (pinned before it) stays first and is not ignored.
    store.map.set(key, "NoCacheHost")
    await call(f)
    expect(orderOf(up.bodies[2])).toEqual(["NoCacheHost", "Morph", "Wafer", "Parasail"])
    expect(providerOf(up.bodies[2]).ignore).toBeUndefined()
  })

  it("a failing ranking source falls back to price sort", async () => {
    const broken: HostRankingSource = {
      get: async () => {
        throw new Error("endpoints down")
      },
    }
    const up = upstream(["Morph"])
    await call(providerPinFetch(up.fetch, THREAD, new MemoryStore(), broken))
    expect(providerOf(up.bodies[0]).sort).toBe("price")
  })

  it("reads the host from a response, escaped names included", () => {
    expect(readResponseProvider('data: {"id":"g","provider":"Sail Research","x":1}')).toBe(
      "Sail Research",
    )
    expect(readResponseProvider('{"content":"say \\"provider\\":\\"X\\""}')).toBeNull()
  })

  it("resolveModel pins a side call's thread without handing it to the scripted provider", async () => {
    process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1"
    const up = upstream(["Morph"])
    const spy = spyOn(globalThis, "fetch").mockImplementation(up.fetch)
    spies.push(spy)
    const model = await resolveModel({
      provider: "openrouter",
      modelId: MODEL,
      apiKey: "sk-or-test",
      providerThreadId: THREAD,
    })
    await generateText({ model, prompt: "hi" })
    expect(up.bodies[0]?.session_id).toBe(THREAD)
    // No thread: no session, no pin.
    const bare = await resolveModel({
      provider: "openrouter",
      modelId: MODEL,
      apiKey: "sk-or-test",
    })
    await streamText({ model: bare, prompt: "hi" }).consumeStream()
    expect(up.bodies[1]?.session_id).toBeUndefined()
  })
})

describe("OpenRouter host deny-list", () => {
  const RANKED: HostRankingSource = {
    get: async () => ({ order: ["OpenInference", "Morph", "Wafer"], ignore: ["NoCacheHost"] }),
  }

  it("defaults to OpenInference", () => {
    expect(parseHostDenyList(DEFAULT_DENIED)).toEqual(["OpenInference"])
    expect(parseHostDenyList(" A, ,b ")).toEqual(["A", "b"])
    expect(parseHostDenyList("")).toEqual([])
  })

  it("a denied host never appears in order and always in ignore (first request on the ranking)", async () => {
    const up = upstream(["Morph"])
    await call(providerPinFetch(up.fetch, THREAD, new MemoryStore(), RANKED))
    expect(up.bodies[0]?.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      order: ["Morph", "Wafer"],
      ignore: ["NoCacheHost", "OpenInference"],
      allow_fallbacks: true,
    })
  })

  it("no ranking at hand: the price-sort fallback carries the ignore", async () => {
    const up = upstream(["Morph"])
    await call(providerPinFetch(up.fetch, THREAD, new MemoryStore(), NO_RANKING))
    expect(providerOf(up.bodies[0]).sort).toBe("price")
    expect(orderOf(up.bodies[0])).toBeUndefined()
    expect(providerOf(up.bodies[0]).ignore).toEqual(["OpenInference"])
  })

  it("a pin on a denied host is not honoured: the thread re-pins where it lands, logged", async () => {
    const store = new MemoryStore()
    store.map.set(key, "OpenInference")
    const warn = spyOn(providerPinLog, "warn")
    spies.push(warn)
    const up = upstream(["Morph", "Morph"], true)
    const f = providerPinFetch(up.fetch, THREAD, store, RANKED)
    await call(f, true)
    expect(orderOf(up.bodies[0])).toEqual(["Morph", "Wafer"])
    expect(providerOf(up.bodies[0]).ignore).toContain("OpenInference")
    expect(store.map.get(key)).toBe("Morph")
    expect(store.writes).toEqual([{ key, host: "Morph", onlyIfAbsent: false }])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "provider_pin_switched",
      from: "OpenInference",
      to: "Morph",
      reason: "denied_host",
    })
    await call(f, true)
    expect(orderOf(up.bodies[1])).toEqual(["Morph", "Wafer"])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("matches any case, and the injected list overrides the setting", async () => {
    const store = new MemoryStore()
    store.map.set(key, "wafer")
    const up = upstream(["Morph"])
    await call(providerPinFetch(up.fetch, THREAD, store, RANKED, { deniedHosts: ["WAFER"] }))
    // OpenInference is not on the injected list, so it stays first.
    expect(orderOf(up.bodies[0])).toEqual(["OpenInference", "Morph"])
    expect(providerOf(up.bodies[0]).ignore).toEqual(["NoCacheHost", "WAFER"])
  })

  it("an empty setting changes nothing", async () => {
    env.LIAISON_OPENROUTER_IGNORE_HOSTS = ""
    const store = new MemoryStore()
    store.map.set(key, "OpenInference")
    const up = upstream(["OpenInference"])
    await call(providerPinFetch(up.fetch, THREAD, store, RANKED))
    expect(orderOf(up.bodies[0])).toEqual(["OpenInference", "Morph", "Wafer"])
    expect(providerOf(up.bodies[0]).ignore).toEqual(["NoCacheHost"])
    expect(store.writes).toEqual([])
  })

  it("applyHostDenyList: dedupes ignore, falls back to price when order empties", () => {
    expect(
      applyHostDenyList(
        { order: ["OpenInference"], allow_fallbacks: true, ignore: ["openinference"] },
        ["OpenInference"],
      ),
    ).toEqual({ sort: "price", ignore: ["openinference"] })
    expect(applyHostDenyList({ data_collection: "deny" }, ["X"])).toEqual({
      data_collection: "deny",
      ignore: ["X"],
    })
    const r = { order: ["A"] }
    expect(applyHostDenyList(r, [])).toBe(r)
  })

  it("a thread-less request (no pin) carries the ignore", async () => {
    process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1"
    const up = upstream(["Morph"])
    const spy = spyOn(globalThis, "fetch").mockImplementation(up.fetch)
    spies.push(spy)
    const bare = await resolveModel({
      provider: "openrouter",
      modelId: MODEL,
      apiKey: "sk-or-test",
    })
    await generateText({ model: bare, prompt: "hi" })
    expect(providerOf(up.bodies[0]).ignore).toEqual(["OpenInference"])
    expect(orderOf(up.bodies[0])).toBeUndefined()
  })

  describe("per org (settings.ai.models.blockedHosts)", () => {
    const ORG = "00000000-0000-4000-8000-0000000000a1"
    const source = (orgList: string[] | undefined) => {
      const reads: string[] = []
      return {
        reads,
        src: createBlockedHostsSource({
          read: async (orgId) => {
            reads.push(orgId)
            return orgList
          },
        }),
      }
    }
    const send = async (blockedHosts: { get(o: string | null): Promise<string[]> }) => {
      const up = upstream(["Morph"])
      await call(
        providerPinFetch(up.fetch, THREAD, new MemoryStore(), RANKED, { orgId: ORG, blockedHosts }),
      )
      return up.bodies[0]
    }

    it("the org's list replaces the instance default", async () => {
      const body = await send(source(["Wafer"]).src)
      expect(orderOf(body)).toEqual(["OpenInference", "Morph"])
      expect(providerOf(body).ignore).toEqual(["NoCacheHost", "Wafer"])
    })

    it("an empty org list blocks nothing", async () => {
      const body = await send(source([]).src)
      expect(orderOf(body)).toEqual(["OpenInference", "Morph", "Wafer"])
      expect(providerOf(body).ignore).toEqual(["NoCacheHost"])
    })

    it("no org list: the instance default applies", async () => {
      const body = await send(source(undefined).src)
      expect(orderOf(body)).toEqual(["Morph", "Wafer"])
      expect(providerOf(body).ignore).toEqual(["NoCacheHost", "OpenInference"])
    })

    it("reads an org once per cache window; a failed read falls back to the default", async () => {
      const { reads, src } = source(["Wafer"])
      expect(await src.get(ORG)).toEqual(["Wafer"])
      await src.get(ORG)
      expect(reads).toEqual([ORG])
      src.invalidate(ORG)
      await src.get(ORG)
      expect(reads).toEqual([ORG, ORG])
      expect(await src.get(null)).toEqual(["OpenInference"])
      const broken = createBlockedHostsSource({
        read: async () => {
          throw new Error("db down")
        },
      })
      expect(await broken.get(ORG)).toEqual(["OpenInference"])
    })
  })
})
