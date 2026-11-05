// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION HEADER'S DERIVED FIGURES (S20, S22, S55; owner D6, D21, D23).
// Pure: every figure is read from the session's held events or its row, so a
// chip's value can always be traced to an event (charter, header actions).
//
//   subagents(events, now)  the subagents of the main thread (spec §1: an SDK
//                           task of type `local_agent`, or one naming a
//                           subagent type; never a background shell, never
//                           `skipTranscript` or `ambient`), from the top-level
//                           `system` task events the node forwards (S19):
//                           start = `task_started`, end = `data.endTime` or
//                           the `task_notification`; `task_progress` carries
//                           the live tool count and the last tool. Stuck
//                           (D21, D31a) = running and no event of that
//                           subagent (task events, and its own when held) for
//                           STUCK_AFTER_MS, whatever its last tool: the badge
//                           names that tool. A notification without a start
//                           is ignored. A
//                           second start of a task is a resume; the model is
//                           its Agent call's `model` input, when given.
//   cacheState(events, now) the main thread's prompt cache: warm until the
//                           last model call plus the TTL (1 h when the last
//                           cache write of the main thread wrote 1 h, else
//                           5 min), "cold" after or before any call.
//   context(events)         the latest main-thread context size and the
//                           model's window (the last `result.contextWindow`).
//   tokenSplit(row)         the cumulative token figures (D23): in = uncached
//                           input + cache writes, out, the breakdown and the
//                           cache hit rate; a row without the split (an older
//                           API or node) gives the old single total.
//   driver(events)          S51 (D28): who else drives an in-place session,
//                           from the node's last top-level `system` `driver`
//                           event: cleared by `elsewhere: false` or by the
//                           next run's `start`. `refused`: a message was
//                           settled `driven_elsewhere` since that start, so
//                           the owner already sent once and the next send is
//                           the confirmed one. drivenElsewhere(row, events)
//                           adds the row: a session back to running has no
//                           other driver (W1 has no continuous follow).
//   atelier(row, events)    S35: the session's Atelier state: the row's
//                           `atelier` when the API serves the field (null:
//                           none), else the latest valid `atelier` event of
//                           the fold (an older API); re-checked either way.
//
// S56 (D30): every figure reads the session's fold (session-fold.ts), folded
// once per event as it arrives; a clock tick re-derives from the fold (one
// entry per subagent), never from the event list.

import type {
  NodeSessionAtelierState,
  NodeSessionDriver,
  NodeSessionEvent,
  NodeSessionOrphan,
} from "@liaison/shared"
import { createSignal } from "solid-js"
import { sessionState } from "./display"
import type { NodeSessionRow } from "./session-api"
import { atelierStateOf, foldOf } from "./session-fold"

/** D21, D31a: a running subagent with no event of its own for this long is stuck. */
export const STUCK_AFTER_MS = 4 * 60_000

export const CACHE_TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const
export type CacheTtl = keyof typeof CACHE_TTL_MS

export type SubagentState = "running" | "stuck" | "done" | "failed" | "stopped"

/** A subagent's dot, in the panel and on its transcript line alike (one source). */
export const SUBAGENT_DOT: Record<SubagentState, string> = {
  running: "bg-success",
  stuck: "bg-warning",
  done: "bg-text-tertiary",
  failed: "bg-error",
  stopped: "bg-text-tertiary",
}

export interface SubagentInfo {
  taskId: string
  /** The Agent tool call that started it: the id its own events carry as `parentToolUseId`. */
  toolUseId: string | null
  description: string
  subagentType: string | null
  state: SubagentState
  startedAt: number
  endedAt: number | null
  lastEventAt: number
  toolUses: number | null
  lastToolName: string | null
  /** S54: started again after a first run (the main agent resumed it). */
  resumed: boolean
  /** The model its Agent call asked for, when it named one. */
  model: string | null
}

export interface SubagentSummary {
  running: number
  stuck: number
  done: number
  /** Stuck first, then running, then finished; newest first within each. */
  list: SubagentInfo[]
}

export function subagents(events: readonly NodeSessionEvent[], now: number): SubagentSummary {
  const fold = foldOf(events)
  const list: SubagentInfo[] = []
  for (const acc of fold.tasks.values()) {
    const ownAt = acc.toolUseId ? (fold.lastAtByParent.get(acc.toolUseId) ?? 0) : 0
    const lastEventAt = Math.max(acc.lastEventAt, ownAt)
    // D31a: stuck is time alone. Neither the SDK's last_tool_name nor an
    // open call of its own proves a tool is still running.
    const state: SubagentState =
      acc.ended ?? (now - lastEventAt >= STUCK_AFTER_MS ? "stuck" : "running")
    list.push({
      taskId: acc.taskId,
      toolUseId: acc.toolUseId,
      description: acc.description,
      subagentType: acc.subagentType,
      startedAt: acc.startedAt,
      endedAt: acc.endedAt,
      toolUses: acc.toolUses,
      lastToolName: acc.lastToolName,
      resumed: acc.resumed,
      state,
      lastEventAt,
      model: acc.toolUseId ? (fold.models.get(acc.toolUseId) ?? null) : null,
    })
  }
  const rank = (s: SubagentState) => (s === "stuck" ? 0 : s === "running" ? 1 : 2)
  list.sort((a, b) => rank(a.state) - rank(b.state) || b.startedAt - a.startedAt)
  let running = 0
  let stuck = 0
  for (const s of list) {
    if (s.state === "running") running++
    else if (s.state === "stuck") stuck++
  }
  return { running, stuck, done: list.length - running - stuck, list }
}

export type CacheState =
  | { state: "warm"; remainingMs: number; ttl: CacheTtl }
  | { state: "cold"; ttl?: CacheTtl }

/**
 * S22: the main thread's prompt cache. A model call is a main-thread usage
 * event carrying the cache split (a message's first chunk); an older node
 * sends no split, so there every main-thread usage event counts, at 5 min.
 * Folded as the events arrive (S56): reading it never rescans them.
 */
export function cacheState(events: readonly NodeSessionEvent[], now: number): CacheState {
  const fold = foldOf(events)
  const last = fold.lastSplitUsageAt ?? fold.lastMainUsageAt
  if (last === null) return { state: "cold" }
  const ttl: CacheTtl = fold.lastSplitUsageAt !== null ? fold.cacheTtl : "5m"
  const remainingMs = last + CACHE_TTL_MS[ttl] - now
  return remainingMs > 0 ? { state: "warm", remainingMs, ttl } : { state: "cold", ttl }
}

export interface ContextInfo {
  tokens: number
  window: number
  percent: number
}

/** S22, D23: the latest main-thread context size over the window; null until both are known. */
export function context(events: readonly NodeSessionEvent[]): ContextInfo | null {
  const { contextTokens: tokens, contextWindow: window } = foldOf(events)
  if (tokens === null || window === null) return null
  return { tokens, window, percent: Math.round((tokens / window) * 100) }
}

export function contextPercent(events: readonly NodeSessionEvent[]): number | null {
  return context(events)?.percent ?? null
}

/** `m:ss` for a countdown (S22). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export type TokenSplit =
  | {
      kind: "split"
      /** Uncached input + cache writes: what the model processed fresh. */
      in: number
      out: number
      uncached: number
      cacheWrite5m: number
      cacheWrite1h: number
      cacheRead: number
      /** Cache read / all input, 0..1; null before any input. */
      hitRate: number | null
    }
  | { kind: "total"; total: number }

type TokenRow = Pick<NodeSessionRow, "tokensIn" | "tokensOut"> &
  Partial<Pick<NodeSessionRow, "tokensCacheRead" | "tokensCacheWrite5m" | "tokensCacheWrite1h">>

/**
 * D23: `tokensIn` counts cache reads and writes too, so it re-counts the
 * cached context on every call. The split row gives the fresh input. A row
 * without the split fields, whose split is all zero while it has input (a
 * session run by a node older than the split), or whose split exceeds its
 * input (split for only part of the session), keeps the single total.
 */
export function tokenSplit(row: TokenRow): TokenSplit {
  const read = row.tokensCacheRead
  const w5 = row.tokensCacheWrite5m
  const w1 = row.tokensCacheWrite1h
  const allIn = Math.max(0, row.tokensIn || 0)
  const out = Math.max(0, row.tokensOut || 0)
  if (typeof read !== "number" || typeof w5 !== "number" || typeof w1 !== "number") {
    return { kind: "total", total: allIn + out }
  }
  const cached = read + w5 + w1
  if (cached === 0 && allIn > 0) return { kind: "total", total: allIn + out }
  // F7: more cached than input is a split counted only for part of the session
  // (a node upgraded mid-session, or bounded input): the total is the honest figure.
  if (cached > allIn) return { kind: "total", total: allIn + out }
  const uncached = Math.max(0, allIn - cached)
  return {
    kind: "split",
    in: uncached + w5 + w1,
    out,
    uncached,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    cacheRead: read,
    hitRate: allIn > 0 ? Math.min(1, read / allIn) : null,
  }
}

// ---- one driver at a time (S51, D28) ----

export interface DriverState {
  /** Who drives it, when the node could tell (null: another Claude Code). */
  via: NodeSessionDriver | null
  /** A message was refused `driven_elsewhere` since the last run start. */
  refused: boolean
  /** D33: an orphaned Claude process (parent launchd) holds it: its pid. */
  orphan: NodeSessionOrphan | null
}

/** S51: the session's other driver, from its events, or null. */
export function driver(events: readonly NodeSessionEvent[]): DriverState | null {
  const fold = foldOf(events)
  return fold.driverVia === undefined
    ? null
    : { via: fold.driverVia, refused: fold.driverRefused, orphan: fold.driverOrphan }
}

/** D33: the orphans the owner stopped from this page ("Stop it"), by session and pid. */
const [stoppedOrphans, setStoppedOrphans] = createSignal<ReadonlySet<string>>(new Set())
const orphanKey = (sessionId: string, pid: number) => `${sessionId}:${pid}`

/** D33: the shell stopped that orphan: it drives the session no more. */
export function markOrphanStopped(sessionId: string, pid: number): void {
  setStoppedOrphans((s) => new Set([...s, orphanKey(sessionId, pid)]))
}

/** Tests: forget the stopped orphans. */
export function resetStoppedOrphans(): void {
  setStoppedOrphans(new Set<string>())
}

/**
 * S51: the other driver the view shows: none while the session runs here,
 * and none once the owner stopped the orphan that held it (D33; the node
 * checks again on the next send).
 */
export function drivenElsewhere(
  session: Pick<NodeSessionRow, "status" | "state"> & { id?: string },
  events: readonly NodeSessionEvent[],
): DriverState | null {
  if (sessionState(session) === "running") return null
  const d = driver(events)
  if (d?.orphan && session.id && stoppedOrphans().has(orphanKey(session.id, d.orphan.pid))) {
    return null
  }
  return d
}

/** The i18n key part of a driver: `orphan` (D33), `vscode`, `cli`, or `elsewhere` (unknown). */
export const driverKey = (d: Pick<DriverState, "via" | "orphan">) =>
  d.orphan ? "orphan" : (d.via ?? "elsewhere")

// ---- Atelier (S35) ----

/** S35: the Atelier state the header shows, or null (no stepper). */
export function atelier(
  row: Pick<NodeSessionRow, "atelier">,
  events: readonly NodeSessionEvent[],
): NodeSessionAtelierState | null {
  if (row.atelier !== undefined) return atelierStateOf(row.atelier)
  return foldOf(events).atelier
}

/**
 * A long name cut in its middle ("liaison/373b…-repo-3"), so both the prefix
 * and the distinguishing tail stay readable; the full name goes in a tooltip.
 */
export function middleTruncate(value: string, max: number): string {
  if (value.length <= max || max < 3) return value
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`
}
