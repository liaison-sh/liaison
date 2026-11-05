// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ── HOW FAST EACH OPENROUTER HOST REALLY IS, FROM OUR OWN TRAFFIC ──────────
// The host ranking (openrouter-host-ranking.ts) picks the cheapest host with a
// real cache discount, and a thread then stays on it (openrouter-provider-pin.ts).
// Price alone picked hosts that answered at ~25 tokens/s with seconds of wait
// before the first token, which made a ten-step routine take well over a
// minute. So a host must also be FAST ENOUGH: "the cheapest host among those
// fast enough". OpenRouter's public endpoints list no longer reports latency
// or throughput, so the speed is measured on our own agent steps.
//
// A SAMPLE is one streamed agent step served by a host: its time to first token
// (request sent → first streamed chunk) and, when it wrote enough tokens to
// measure, its output speed (output tokens over the time from the first chunk
// to the end). Samples are kept per model and host in Redis, shared by every
// process: the last SPEED_SAMPLES of them, none older than SPEED_WINDOW_SECONDS,
// so a host that got faster (or slower) is judged on how it is now.
//
// THE FLOOR. A host is SLOW when it has at least `minSamples` samples and its
// median time to first token is above `maxTtftMs`, or its median output speed
// is below `minTokensPerSecond`. A host with fewer samples is NOT slow: it
// keeps its place, so a new or rarely used host gets measured. It is FAR BELOW
// the floor at twice the limits (median TTFT over 2 x maxTtftMs, or median
// speed under minTokensPerSecond / 2): that is what moves a live thread off its
// pinned host (see the pin).
//
// The defaults (overridable, see `hostSpeedFloor`): 2.5 s median TTFT, 50
// tokens/s median speed, 5 samples. Calibrated on live runs of a multi-step
// agent turn through this path (30k-token prompts, mostly cached, DeepSeek V4.1
// Flash): the fast hosts answered with a median TTFT of 0.7-1.1 s at well over
// 100 tokens/s, the slow one with a median TTFT of 3.5-7 s. TTFT is what tells
// them apart; the speed rule catches a host that starts fast but trickles.
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "openrouter-host-speed" })

/** Samples kept per model and host. */
export const SPEED_SAMPLES = 20
/** A sample older than this is not counted (and the list expires after it). */
export const SPEED_WINDOW_SECONDS = 6 * 60 * 60
/** A step that wrote fewer output tokens than this gives no speed (too noisy), only a TTFT. */
export const MIN_SPEED_TOKENS = 40
/** Speeds read from Redis are reused this long in a process (a request never waits for them). */
const SPEED_CACHE_MS = 30 * 1000
const READ_TIMEOUT_MS = 300

export interface HostSpeedFloor {
  maxTtftMs: number
  minTokensPerSecond: number
  minSamples: number
}

function envNumber(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/**
 * The floor, from the environment: `OPENROUTER_HOST_MAX_TTFT_MS` (default 2500),
 * `OPENROUTER_HOST_MIN_TOKENS_PER_SECOND` (default 50; 0 turns the speed rule
 * off) and `OPENROUTER_HOST_SPEED_MIN_SAMPLES` (default 5).
 */
export function hostSpeedFloor(): HostSpeedFloor {
  return {
    maxTtftMs: envNumber(process.env.OPENROUTER_HOST_MAX_TTFT_MS, 2500, 1),
    minTokensPerSecond: envNumber(process.env.OPENROUTER_HOST_MIN_TOKENS_PER_SECOND, 50, 0),
    minSamples: envNumber(process.env.OPENROUTER_HOST_SPEED_MIN_SAMPLES, 5, 1),
  }
}

export interface SpeedSample {
  /** Epoch ms. */
  at: number
  ttftMs: number
  /** Output tokens per second, or null when the step wrote too little to measure. */
  tps: number | null
}

export interface HostSpeed {
  samples: number
  ttftP50Ms: number | null
  tpsP50: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/** One host's medians over its samples inside the window. */
export function summarize(samples: SpeedSample[], now: number): HostSpeed {
  const fresh = samples.filter((s) => now - s.at <= SPEED_WINDOW_SECONDS * 1000)
  return {
    samples: fresh.length,
    ttftP50Ms: median(fresh.map((s) => s.ttftMs)),
    tpsP50: median(fresh.flatMap((s) => (s.tps === null ? [] : [s.tps]))),
  }
}

/** Below the floor (`factor` 1), or far below it (`factor` 2). Too few samples is never slow. */
export function isBelowFloor(
  speed: HostSpeed | undefined,
  floor: HostSpeedFloor,
  factor = 1,
): boolean {
  if (!speed || speed.samples < floor.minSamples) return false
  if (speed.ttftP50Ms !== null && speed.ttftP50Ms > floor.maxTtftMs * factor) return true
  return (
    floor.minTokensPerSecond > 0 &&
    speed.tpsP50 !== null &&
    speed.tpsP50 < floor.minTokensPerSecond / factor
  )
}

/**
 * The ranked hosts with the slow ones moved to the end, in their price order.
 * Moved, not ignored: if every fast host is down, OpenRouter can still fall
 * back to a slow one rather than fail the request.
 */
export function demoteSlowHosts(
  order: string[],
  speeds: Map<string, HostSpeed>,
  floor: HostSpeedFloor,
): { order: string[]; slow: string[] } {
  const slow = order.filter((h) => isBelowFloor(speeds.get(h), floor))
  if (slow.length === 0) return { order, slow }
  return { order: [...order.filter((h) => !slow.includes(h)), ...slow], slow }
}

export interface SpeedStore {
  push(key: string, value: string, keep: number, ttlSeconds: number): Promise<void>
  range(keys: string[]): Promise<Array<string[] | null>>
}

const redisSpeedStore: SpeedStore = {
  async push(key, value, keep, ttlSeconds) {
    const { redis } = await import("~/lib/redis")
    await redis
      .multi()
      .lpush(key, value)
      .ltrim(key, 0, keep - 1)
      .expire(key, ttlSeconds)
      .exec()
  },
  async range(keys) {
    const { redis } = await import("~/lib/redis")
    const pipe = redis.pipeline()
    for (const key of keys) pipe.lrange(key, 0, -1)
    const res = (await pipe.exec()) ?? []
    return res.map(([err, v]) => (err ? null : (v as string[])))
  },
}

export function hostSpeedKey(model: string, host: string): string {
  return `openrouter:host-speed:${model}:${host}`
}

/**
 * The output speed of one step, or null when it wrote too little to measure:
 * output tokens over the time from the first streamed chunk to the end.
 */
export function stepTokensPerSecond(
  outputTokens: number | null | undefined,
  ttftMs: number,
  modelMs: number,
): number | null {
  const genMs = modelMs - ttftMs
  if (!outputTokens || outputTokens < MIN_SPEED_TOKENS || genMs <= 0) return null
  return Math.round((outputTokens / (genMs / 1000)) * 10) / 10
}

export interface HostSpeedSource {
  /** Record one step of `host` (never waits, never throws). */
  record(model: string, host: string, sample: Omit<SpeedSample, "at">): void
  /** The hosts' speeds; bounded, never throws, empty when unknown. */
  get(model: string, hosts: string[]): Promise<Map<string, HostSpeed>>
}

export function createHostSpeedSource(
  deps: { store?: SpeedStore; now?: () => number } = {},
): HostSpeedSource & { clear(): void } {
  const store = deps.store ?? redisSpeedStore
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; speeds: Map<string, HostSpeed> }>()

  return {
    clear() {
      cache.clear()
    },
    record(model, host, sample) {
      if (!host || !Number.isFinite(sample.ttftMs) || sample.ttftMs < 0) return
      const value = JSON.stringify({ ...sample, at: now() } satisfies SpeedSample)
      store
        .push(hostSpeedKey(model, host), value, SPEED_SAMPLES, SPEED_WINDOW_SECONDS)
        .catch((err: unknown) => log.debug({ err, model, host }, "host speed sample not recorded"))
    },
    async get(model, hosts) {
      if (hosts.length === 0) return new Map()
      const cacheKey = `${model}\n${[...hosts].sort().join("\n")}`
      const hit = cache.get(cacheKey)
      if (hit && now() - hit.at < SPEED_CACHE_MS) return hit.speeds
      let lists: Array<string[] | null> = []
      try {
        lists = await Promise.race([
          store.range(hosts.map((h) => hostSpeedKey(model, h))),
          new Promise<Array<string[] | null>>((resolve) =>
            setTimeout(() => resolve([]), READ_TIMEOUT_MS),
          ),
        ])
      } catch (err) {
        log.debug({ err, model }, "host speeds unreadable; ranking by price alone")
        return hit?.speeds ?? new Map()
      }
      const speeds = new Map<string, HostSpeed>()
      const t = now()
      hosts.forEach((host, i) => {
        const raw = lists[i]
        if (!raw) return
        const samples: SpeedSample[] = []
        for (const item of raw) {
          try {
            const s = JSON.parse(item) as SpeedSample
            if (typeof s.at === "number" && typeof s.ttftMs === "number") samples.push(s)
          } catch {
            // A malformed sample is skipped.
          }
        }
        speeds.set(host, summarize(samples, t))
      })
      cache.set(cacheKey, { at: t, speeds })
      return speeds
    },
  }
}

export const defaultHostSpeedSource = createHostSpeedSource()
