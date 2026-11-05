// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TOOL SCHEMA BUDGET A TURN STARTS WITH, AND WHAT IT SHEDS FIRST.
//
// A person's agent conversation is one thread for the life of the account, so
// the tools it starts with are a mix: the core set, what the last turns used,
// what older turns loaded, and the tools of the apps the turn is about
// (turn-focus.ts). Over TURN_TOOL_SCHEMA_TOKEN_CAP something goes back to the
// deferred catalog, one kernel__tool_search away. The budget used to shed
// whole discovered apps, largest first, before any focus app's tool, so a demo
// visitor's open tab preloaded 68 tools of one app and the shipping app the
// last three turns had been working went instead: the person asked to book the
// shipment and the agent had nothing to book it with.
//
// The order is now least recently useful first:
//
//  1. Discoveries the last RECENT_TOOL_TURNS turns did not use or load, oldest
//     use first (never used before any use), the larger app first among
//     equally old ones, so an app with no recent use still leaves whole.
//  2. A hard focus app's PRELOAD (tools the turn added for the app it is
//     about, which no turn has used) past FOCUS_PRELOAD_TOKEN_SHARE of the
//     cap: a focus app is loaded first, never to the whole budget. Then the
//     focus app's tools that have not been used recently, in focusOverflow's
//     order.
//  3. Only then the recently used tools, oldest use first.
//
// Never shed: the core (non deferred) tools, kernel__tool_search among them,
// and anything a turn without tool_search could not load back. The tools a
// turn loads or calls while it runs are never trimmed (this runs once, before
// the first step), so a tool cannot vanish between two steps of a turn.

import { rootLogger } from "~/lib/logger"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { RECENT_TOOL_TURNS } from "~/modules/agent/context/discovery-window"
import {
  appOfSdkToolName,
  entityRank,
  focusOverflow,
  type TurnFocus,
} from "~/modules/agent/runtime/turn-focus"

const log = rootLogger.child({ module: "context-assembler" })

type ToolDefs = Record<string, { description?: string; inputSchema?: unknown }>

/** The share of the cap a hard focus app's preload may take (its entity's own tools aside). */
export const FOCUS_PRELOAD_TOKEN_SHARE = 0.5

/**
 * Shed `names` until `total` fits `cap`, least recently used first. Tools of
 * the same app last used in the same turn (or never) go together, so an app
 * only ever leaves part loaded when its tools were used at different times.
 */
export function evictByRecency(params: {
  names: readonly string[]
  tools: ToolDefs
  recency: ReadonlyMap<string, number>
  total: number
  cap: number
}): { dropped: string[]; total: number } {
  const groups = new Map<string, { app: string; ago: number; names: string[]; tokens: number }>()
  for (const name of params.names) {
    const app = appOfSdkToolName(name)
    const ago = params.recency.get(name) ?? Number.POSITIVE_INFINITY
    const key = `${app}\u0000${ago}`
    const g = groups.get(key) ?? { app, ago, names: [], tokens: 0 }
    g.names.push(name)
    g.tokens += estimateToolSchemaTokens(name, params.tools[name])
    groups.set(key, g)
  }
  const ordered = [...groups.values()].sort(
    (a, b) => b.ago - a.ago || b.tokens - a.tokens || a.app.localeCompare(b.app),
  )
  let total = params.total
  const dropped: string[] = []
  for (const g of ordered) {
    if (total <= params.cap) break
    total -= g.tokens
    dropped.push(...g.names)
  }
  return { dropped, total }
}

export interface TurnToolBudgetPlan {
  /** What goes back to the deferred catalog. */
  drop: string[]
  toolSchemaTokens: number
}

/** Plan the start-of-turn tool surface under the cap (see the header). Pure but for its one log line. */
export function planTurnToolBudget(params: {
  /** The provider-visible tool names at turn start, preloads included. */
  visible: readonly string[]
  tools: ToolDefs
  /** Whether a visible tool may go back to the catalog at all. */
  droppable: (name: string) => boolean
  /** The tools this turn added for its hard focus apps. */
  preloaded: ReadonlySet<string>
  hardFocusApps: ReadonlySet<string>
  focus: TurnFocus
  /** Turns since each tool was last used or loaded (0 = the last turn); absent = never. */
  recency: ReadonlyMap<string, number>
  cap: number
  recentTurns?: number
  logContext?: Record<string, unknown>
}): TurnToolBudgetPlan {
  const { tools, recency, cap, focus } = params
  const recentTurns = params.recentTurns ?? RECENT_TOOL_TURNS
  const cost = (name: string) => estimateToolSchemaTokens(name, tools[name])
  const visible = [...new Set(params.visible)]
  const before = visible.reduce((n, name) => n + cost(name), 0)
  let total = before

  const candidates = visible.filter(params.droppable)
  const isRecent = (name: string) => (recency.get(name) ?? Number.POSITIVE_INFINITY) < recentTurns
  const isFocus = (name: string) => params.hardFocusApps.has(appOfSdkToolName(name))
  const old = candidates.filter((n) => !isRecent(n) && !isFocus(n))
  const focusTools = candidates.filter((n) => !isRecent(n) && isFocus(n))
  const recent = candidates.filter(isRecent)

  // 1. What the conversation has not used lately.
  const tier1 = evictByRecency({ names: old, tools, recency, total, cap })
  total = tier1.total

  // 2. The focus apps: their preload within its share, then the rest in focusOverflow's order.
  const preload = focusTools.filter(
    (n) => params.preloaded.has(n) && entityRank(n, tools, focus) < 2,
  )
  const preloadTokens = preload.reduce((n, name) => n + cost(name), 0)
  const shareCap = Math.round(cap * FOCUS_PRELOAD_TOKEN_SHARE)
  const overShare =
    preloadTokens > shareCap
      ? focusOverflow({
          candidates: preload,
          tools,
          focus,
          visibleTokens: preloadTokens,
          cap: shareCap,
        })
      : []
  total -= overShare.reduce((n, name) => n + cost(name), 0)
  const shed = new Set(overShare)
  const focusOver = focusOverflow({
    candidates: focusTools.filter((n) => !shed.has(n)),
    tools,
    focus,
    visibleTokens: total,
    cap,
  })
  total -= focusOver.reduce((n, name) => n + cost(name), 0)

  // 3. The recently used tools, only when nothing else is left.
  const tier3 = evictByRecency({ names: recent, tools, recency, total, cap })
  total = tier3.total

  const drop = [...tier1.dropped, ...overShare, ...focusOver, ...tier3.dropped]
  const dropSet = new Set(drop)
  const kept = visible.filter((n) => !dropSet.has(n))
  if (drop.length > 0 || total > cap) {
    const appsOf = (names: readonly string[]) => [...new Set(names.map(appOfSdkToolName))].sort()
    const keptApps = new Set(kept.map(appOfSdkToolName))
    const protectedNames = visible.filter((n) => !params.droppable(n))
    log.warn(
      {
        ...params.logContext,
        toolCountBefore: visible.length,
        toolSchemaTokensBefore: before,
        toolCount: kept.length,
        toolSchemaTokens: total,
        cap,
        // Apps none of whose tools stayed, and every app something was shed from.
        droppedApps: appsOf(drop).filter((app) => !keptApps.has(app)),
        trimmedApps: appsOf(drop),
        droppedToolCount: drop.length,
        droppedUnusedCount: tier1.dropped.length,
        droppedFocusCount: overShare.length + focusOver.length,
        droppedRecentCount: tier3.dropped.length,
        keptRecentTools: recent.filter((n) => !dropSet.has(n)).sort(),
        keptApps: [...keptApps].sort(),
        protectedToolCount: protectedNames.length,
        protectedToolSchemaTokens: protectedNames.reduce((n, name) => n + cost(name), 0),
      },
      total > cap
        ? `tool schemas over their ${cap} token budget: what is left is the core set, the request's own entity tools or tools the turn cannot load back`
        : `tool schemas trimmed to the ${cap} token budget, least recently used first`,
    )
  }
  return { drop: drop.sort(), toolSchemaTokens: total }
}
