// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Request durations of the last 15 minutes, for the managed `/diag` field
 * `http: {p95Ms, count, windowS}`. A fixed-size ring (typed arrays, 4096
 * samples): memory never grows, and under very high traffic the ring holds the
 * newest 4096 requests, a shorter window than 15 minutes. Recording happens
 * only in the managed edition (read per request); self-hosted pays one check.
 */
import type { MiddlewareHandler } from "hono"
import { isManagedEdition } from "~/lib/edition"

export const WINDOW_MS = 15 * 60_000
const RING = 4096
const times = new Float64Array(RING)
const durations = new Float32Array(RING)
let next = 0
let filled = 0

/** Probe and monitoring paths say nothing about user-facing latency. */
const SKIPPED = new Set(["/healthz", "/readyz", "/diag"])

/**
 * Nor does a request whose time goes to something other than this server: a model answering
 * (a turn, a dictation, a proofread), a tenant's webhook handler, a sibling service's
 * long call, an MCP client's long poll. A few of these would otherwise be the whole p95 of a
 * quiet cell and claim it needs room.
 */
const WAITS_ON_ANOTHER = /^\/(?:api\/agent\/chat|api\/assist|api\/cloud|webhooks|mcp)(?:\/|$)/

export function recordRequestDuration(ms: number, nowMs: number = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return
  times[next] = nowMs
  durations[next] = ms
  next = (next + 1) % RING
  if (filled < RING) filled++
}

export interface LatencySnapshot {
  p95Ms: number | null
  count: number
  windowS: number
}

export function latencySnapshot(nowMs: number = Date.now()): LatencySnapshot {
  const live: number[] = []
  for (let i = 0; i < filled; i++) {
    if (nowMs - (times[i] as number) <= WINDOW_MS) live.push(durations[i] as number)
  }
  live.sort((a, b) => a - b)
  const p95 = live.length === 0 ? null : (live[Math.ceil(0.95 * live.length) - 1] as number)
  return {
    p95Ms: p95 === null ? null : Math.round(p95),
    count: live.length,
    windowS: WINDOW_MS / 1000,
  }
}

export function _resetLatencyWindow(): void {
  next = 0
  filled = 0
}

export function latencyWindowMiddleware(): MiddlewareHandler {
  return async (c, nextHandler) => {
    if (!isManagedEdition() || SKIPPED.has(c.req.path) || WAITS_ON_ANOTHER.test(c.req.path)) {
      return nextHandler()
    }
    const start = performance.now()
    try {
      await nextHandler()
    } finally {
      recordRequestDuration(performance.now() - start)
    }
  }
}
