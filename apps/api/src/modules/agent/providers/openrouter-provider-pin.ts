// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ── ONE UPSTREAM HOST PER THREAD, SWITCHED ONLY WHEN IT FAILS ──────────────
// OpenRouter serves a model from many upstream hosts, each with its own prompt
// cache. `session_id` (openrouter.ts) makes routing sticky, but only as a
// preference: a live walk saw threads hop between hosts mid-conversation and
// lose a third of their cache hits. So a thread PINS the host its first request
// landed on (the response's `provider`, the same field the step log reads into
// `upstream`) and every later request of that thread and model (its steps and
// turns, routines, mentions, approval results, its sub-runs and its compaction
// and brief calls) names that host as `provider.order: [host]`.
//
// THE FALLBACK RULE. The request keeps `allow_fallbacks: true`. With an `order`,
// OpenRouter tries the listed host first and moves to another host only when
// that one cannot serve the request (down, 5xx, rate-limited, filtered out by
// the request's own constraints); `order` overrides its price and load
// balancing. So the host changes only when the pinned one is unavailable,
// with no failed round trip of our own to wait out. Rejected alternative:
// `allow_fallbacks: false` plus our own unpinned retry, which costs a whole
// failed request per outage and has to classify OpenRouter's errors itself.
// A response served by another host than the pin is therefore a forced switch:
// the thread pins the new host and `provider_pin_switched` is logged.
//
// WHERE A THREAD STARTS, AND WHERE IT FALLS BACK TO. The first request (no pin)
// carries the host ranking (openrouter-host-ranking.ts: cheapest cached price
// first, hosts without a real cache discount ignored), or `sort: "price"` when
// no ranking is at hand. A pinned request lists the ranking after the pin, so a
// forced switch lands on the next best host and the thread re-pins there.
//
// FAST ENOUGH (openrouter-host-speed.ts). A host measured below the speed floor
// on our own steps goes to the end of a NEW thread's ranking, so a thread
// starts on the cheapest host among those fast enough. A live thread keeps its
// pin while its host is merely below the floor: a switch re-reads the whole
// prompt uncached once on the new host, so it is worth it only for a host that
// is persistently FAR below the floor (twice the limits, over enough samples).
// Then the request goes out ranked as a new thread's would (the slow pin last),
// the thread re-pins where it lands, and `provider_pin_switched` is logged with
// reason `slow`. That costs one uncached prompt on the new host (a few tenths
// of a cent on a cheap model at 40k tokens) and saves seconds on every later
// step; it happens at most once per thread unless the new host degrades too.
//
// The pin lives in Redis (shared by every api process and the worker, and kept
// across restarts), keyed by thread and model id, for PIN_TTL_SECONDS after its
// last use. Redis trouble never fails a call: the request just goes unpinned.
// OpenRouter only; other providers never reach this code.
//
// DENIED HOSTS. Some hosts serve a model wrongly (one answered the first user
// message of a multi-turn conversation instead of the latest one). Hosts named
// in LIAISON_OPENROUTER_IGNORE_HOSTS never serve a request: whatever routing is
// computed, they leave `order` and join `ignore` (`applyHostDenyList`), and a
// pin on one is not honoured, so the thread re-pins where its next request
// lands (`provider_pin_switched`, reason `denied_host`). Every OpenRouter chat
// request path applies the same helper (openrouter.ts `openRouterBaseRouting`
// for requests outside a thread).
import { rootLogger } from "~/lib/logger"
import {
  type BlockedHostsSource,
  blockedHostsSource,
} from "~/modules/agent/providers/openrouter-blocked-hosts"
import {
  defaultHostRankingSource,
  firstRequestRouting,
  type HostRanking,
  type HostRankingSource,
  pinnedRouting,
} from "~/modules/agent/providers/openrouter-host-ranking"
import {
  defaultHostSpeedSource,
  demoteSlowHosts,
  type HostSpeed,
  type HostSpeedSource,
  hostSpeedFloor,
  isBelowFloor,
} from "~/modules/agent/providers/openrouter-host-speed"

/** Exported so a test can hear `provider_pin_switched`. */
export const providerPinLog = rootLogger.child({ module: "openrouter-provider-pin" })

/** How long a pin outlives the thread's last request. */
export const PIN_TTL_SECONDS = 14 * 24 * 60 * 60

/** A pin read slower than this sends the request unpinned (Redis awaits are bounded). */
const PIN_READ_TIMEOUT_MS = 500

export interface ProviderPinStore {
  /** The pinned host, its lifetime renewed; null when none. */
  get(key: string): Promise<string | null>
  /** Pin `host`. `onlyIfAbsent`: keep a pin another request set first. */
  set(key: string, host: string, onlyIfAbsent: boolean): Promise<void>
}

const redisPinStore: ProviderPinStore = {
  async get(key) {
    const { redis } = await import("~/lib/redis")
    return redis.getex(key, "EX", PIN_TTL_SECONDS)
  },
  async set(key, host, onlyIfAbsent) {
    const { redis } = await import("~/lib/redis")
    if (onlyIfAbsent) await redis.set(key, host, "EX", PIN_TTL_SECONDS, "NX")
    else await redis.set(key, host, "EX", PIN_TTL_SECONDS)
  },
}

export function providerPinKey(threadId: string, upstreamId: string): string {
  return `openrouter:provider-pin:${threadId}:${upstreamId}`
}

/** The upstream host named in a response body (JSON or the first SSE chunks), or null. */
export function readResponseProvider(text: string): string | null {
  const m = /"provider"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(text)
  if (!m?.[1]) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

/** The request body with `routing` merged into its `provider` object. */
export function withRouting(
  body: Record<string, unknown>,
  routing: Record<string, unknown>,
): Record<string, unknown> {
  const provider = (
    body.provider && typeof body.provider === "object" ? body.provider : {}
  ) as Record<string, unknown>
  return { ...body, provider: { ...provider, ...routing } }
}

/** Is `host` on the deny-list (case-insensitive)? */
export function isDeniedHost(host: string, denied: readonly string[]): boolean {
  const h = host.toLowerCase()
  return denied.some((d) => d.toLowerCase() === h)
}

/**
 * `routing` (a request's `provider` fields) with the denied hosts removed from
 * `order` and added to `ignore` (deduplicated, any case). An `order` left empty
 * falls back to `sort: "price"`. No denied hosts: `routing` unchanged.
 */
export function applyHostDenyList(
  routing: Record<string, unknown>,
  denied: readonly string[],
): Record<string, unknown> {
  if (denied.length === 0) return routing
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  const ignore = strings(routing.ignore)
  for (const d of denied) if (!isDeniedHost(d, ignore)) ignore.push(d)
  const out: Record<string, unknown> = { ...routing, ignore }
  if (Array.isArray(routing.order)) {
    const order = strings(routing.order).filter((h) => !isDeniedHost(h, denied))
    if (order.length > 0) {
      out.order = order
    } else {
      delete out.order
      delete out.allow_fallbacks
      out.sort = "price"
    }
  }
  return out
}

/**
 * A fetch that pins a thread's OpenRouter chat requests to one upstream host
 * (see above). Requests without a JSON chat body pass through untouched.
 */
export function providerPinFetch(
  inner: typeof fetch,
  threadId: string,
  store: ProviderPinStore = redisPinStore,
  ranking: HostRankingSource = defaultHostRankingSource,
  opts: {
    /**
     * Hears each chat request body as sent (routing applied) and the host it
     * was pinned to: a TURN's requests are kept for the idle compaction, which
     * replays the last one with its summary instruction appended
     * (context/warm-compaction.ts). Never awaited, never fails the request.
     */
    onSent?: (sent: Record<string, unknown>, pinnedHost: string | null) => void
    /** The measured host speeds (openrouter-host-speed.ts); replaced by tests. */
    speeds?: HostSpeedSource
    /**
     * The org the thread belongs to: its effective blocked-host list applies
     * (openrouter-blocked-hosts.ts). No org: the instance default.
     */
    orgId?: string | null
    /** Where the org's list is read (cached); replaced by tests. */
    blockedHosts?: Pick<BlockedHostsSource, "get">
    /** A fixed host deny-list, overriding the org's (tests). */
    deniedHosts?: readonly string[]
  } = {},
): typeof fetch {
  const speedSource = opts.speeds ?? defaultHostSpeedSource
  const pinned = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as unknown
        if (parsed && typeof parsed === "object" && "messages" in parsed) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        body = null
      }
    }
    const model = typeof body?.model === "string" ? body.model : null
    if (!body || !model) return inner(input, init)

    const key = providerPinKey(threadId, model)
    const readPin = async (): Promise<string | null> => {
      try {
        return await Promise.race([
          store.get(key),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), PIN_READ_TIMEOUT_MS)),
        ])
      } catch (err) {
        providerPinLog.warn(
          { err, threadId, model },
          "provider pin read failed; request goes unpinned",
        )
        return null
      }
    }
    // The ranking and blocked-host sources bound their own reads and never throw.
    const [storedPin, hosts, denied] = await Promise.all([
      readPin(),
      ranking.get(model).catch(() => null),
      opts.deniedHosts ?? (opts.blockedHosts ?? blockedHostsSource).get(opts.orgId ?? null),
    ])
    // A pin on a denied host is not honoured: the request goes out as a new
    // thread's would, and the thread re-pins where it lands.
    const deniedPin = storedPin !== null && isDeniedHost(storedPin, denied) ? storedPin : null
    const pin = deniedPin ? null : storedPin
    // The speed floor: slow hosts go last; a pin far below it is left (above).
    const floor = hostSpeedFloor()
    let speeds = new Map<string, HostSpeed>()
    if (hosts && hosts.order.length > 0) {
      const names = pin && !hosts.order.includes(pin) ? [...hosts.order, pin] : hosts.order
      speeds = await speedSource.get(model, names).catch(() => new Map<string, HostSpeed>())
    }
    const fast: HostRanking | null = hosts
      ? { ...hosts, order: demoteSlowHosts(hosts.order, speeds, floor).order }
      : null
    const leaveSlowPin =
      pin !== null &&
      isBelowFloor(speeds.get(pin), floor, 2) &&
      (fast?.order.some((h) => h !== pin && !isBelowFloor(speeds.get(h), floor)) ?? false)
    const slowPin = leaveSlowPin ? pin : null
    const computed =
      pin && !slowPin
        ? pinnedRouting(pin, fast)
        : firstRequestRouting(
            fast && slowPin
              ? {
                  order: [...fast.order.filter((h) => h !== slowPin), slowPin],
                  ignore: fast.ignore.filter((h) => h !== slowPin),
                }
              : fast,
          )
    const routing = applyHostDenyList(computed, denied)
    const sent = withRouting(body, routing)
    if (opts.onSent) {
      try {
        opts.onSent(sent, pin)
      } catch (err) {
        providerPinLog.warn({ err, threadId, model }, "turn request observer failed")
      }
    }
    const res = await inner(input, { ...init, body: JSON.stringify(sent) })
    if (!res.ok || !res.body) return res

    const record = (host: string | null) => {
      if (!host || host === pin) return
      if (deniedPin) {
        providerPinLog.warn(
          {
            event: "provider_pin_switched",
            threadId,
            model,
            from: deniedPin,
            to: host,
            reason: "denied_host",
          },
          "provider_pin_switched: the pinned host is on the deny-list, the thread moves to another one",
        )
      } else if (slowPin) {
        const speed = speeds.get(slowPin)
        providerPinLog.warn(
          {
            event: "provider_pin_switched",
            threadId,
            model,
            from: slowPin,
            to: host,
            reason: "slow",
            ttftP50Ms: speed?.ttftP50Ms ?? null,
            tokensPerSecondP50: speed?.tpsP50 ?? null,
            samples: speed?.samples ?? 0,
          },
          "provider_pin_switched: the pinned host is far below the speed floor, the thread moves to a faster one",
        )
      } else if (pin) {
        providerPinLog.warn(
          {
            event: "provider_pin_switched",
            threadId,
            model,
            from: pin,
            to: host,
            reason: "pinned_host_unavailable",
          },
          "provider_pin_switched: OpenRouter served the thread from another host, the pinned one could not serve it",
        )
      }
      // No pin sent: another request of the thread may have pinned first; keep its
      // pin. A denied pin is always replaced.
      store.set(key, host, !pin && !deniedPin).catch((err) => {
        providerPinLog.warn({ err, threadId, model }, "provider pin write failed")
      })
    }

    const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    if (!isStream) {
      res
        .clone()
        .text()
        .then((text) => record(readResponseProvider(text)))
        .catch(() => {})
      return res
    }
    let seen = false
    let head = ""
    const decoder = new TextDecoder()
    const stream = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          if (seen) return
          head += decoder.decode(chunk, { stream: true })
          const host = readResponseProvider(head)
          if (host) {
            seen = true
            head = ""
            record(host)
          } else if (head.length > 65536) {
            // Every chunk names its provider; one this far in without it never will.
            seen = true
            head = ""
          }
        },
      }),
    )
    return new Response(stream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
  return Object.assign(pinned, { preconnect: fetch.preconnect })
}
