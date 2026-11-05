// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The way to a beat's screen. A beat whose element is on another screen
 * offers "Take me there"; the person also learns how to get there alone: the
 * app's entry on the desktop rail is ringed while they are in another app,
 * then each hop of the beat's `path` in turn (the project's row, the agent in
 * the chats list), and the panel ticks each hop off as it is passed. The rail
 * ring drops as soon as the person is in that app.
 */
import type { EffectivePathHop } from "@liaison/shared"
import {
  type ActivityBarEntry,
  getActivityBarEntries,
  getTabType,
  resolveRegisteredTabType,
  urlToTabInfo,
} from "~/framework/app-registry"
import { tabStore } from "~/modules/shell/tab-store"

function registered(type: string): string {
  return resolveRegisteredTabType(type) ?? type
}

/**
 * The rail entry a tab type lights: the entry whose own page it is or that
 * reads as active under it (Messages under a conversation), else the entry of
 * the app the tab type belongs to. The kernel's entries share one app id, so a
 * kernel page no entry names has none.
 */
export function railEntryForTabType(type: string): ActivityBarEntry | null {
  const want = registered(type)
  const entries = getActivityBarEntries()
  const own = entries.find(
    (e) =>
      registered(e.tabAction.type) === want ||
      (e.activeForTabTypes ?? []).some((t) => registered(t) === want),
  )
  if (own) return own
  const appId = getTabType(want)?.appId
  if (!appId || appId === "kernel") return null
  return entries.find((e) => e.appId === appId) ?? null
}

/** Whether two beat routes (or a route and a tab) address the same page. */
function samePage(a: { type: string; entityId: string }, b: { type: string; entityId: string }) {
  return registered(a.type) === registered(b.type) && a.entityId === b.entityId
}

function activeTab() {
  return tabStore.tabs.find((t) => t.id === tabStore.activeTabId) ?? null
}

/** The page a beat route opens, or null when no page owns it. */
function routePage(route: string) {
  return urlToTabInfo(route.split(/[?#]/)[0] ?? route)
}

/**
 * The person is on the very page `route` opens (its tab is the active one).
 * Undefined when that cannot be told (no page owns the route).
 */
export function onBeatRoute(route: string | null): boolean | undefined {
  if (!route) return undefined
  const page = routePage(route)
  if (!page) return undefined
  const tab = activeTab()
  return tab ? samePage(page, tab) : false
}

/**
 * The anchor of the rail entry of the app `route` opens, while the person is
 * in another app; null when they are in it already, or nothing on the rail
 * opens it.
 */
export function railWayAnchor(route: string | null): string | null {
  if (!route) return null
  const page = routePage(route)
  if (!page) return null
  const destination = railEntryForTabType(page.type)
  if (!destination) return null
  const tab = activeTab()
  const current = tab ? railEntryForTabType(tab.type) : null
  if (current?.id === destination.id) return null
  return `activity-*[data-rail-entry=${destination.id}]`
}

/** The rail's "+N" control: where an app folded off the rail is reached. */
export const RAIL_MORE_ANCHOR = "activity-bar-more"

/** Where the person is on a beat's way: hops before `done` are passed, `current` is the one to take. */
export interface PathProgress {
  done: number
  /** The hop to take now; null when every hop is passed. */
  current: number | null
}

/** A hop that has something on screen to ring (the rail entry, an element). */
export function ringableHop(hop: EffectivePathHop): boolean {
  return hop.rail === true || hop.anchor !== undefined
}

/**
 * How far the person got on a beat's way: `reached` hops passed, the hops
 * seen on screen, and whether they got to the step's element (`arrived`).
 */
export interface PathState {
  reached: number
  seen: ReadonlySet<number>
  arrived?: boolean
}

export const PATH_START: PathState = { reached: 0, seen: new Set() }

/**
 * One look at the screen, moving the person along `path`: the deepest hop on
 * screen is the one to take, so every hop before it is passed;
 * a hop seen and now gone while the element is on screen was taken (the agent
 * picked, the conversation opened); a rail hop is passed once the person is in
 * that app (`inApp`). The step's element on screen, on the step's page
 * (`onRoute` not false), puts every hop before it behind the person, even one
 * still in view (Chats in the dock, the session's row in the list); a hop
 * beyond it (`targetAnchor` names an earlier hop: the agent to pick once Chats
 * is open) stays to take. The way only goes back once the person got to the
 * element and left it: then the deepest earlier hop on screen is the one to
 * take again (back on the task, the project's breadcrumb). Before that, a hop
 * left behind while the element loads keeps its place, so nothing flickers.
 */
export function advancePath(
  path: readonly EffectivePathHop[],
  prev: PathState,
  onScreen: (index: number) => boolean,
  targetOnScreen: boolean,
  inApp: boolean,
  arrived: { onRoute?: boolean; targetAnchor?: string } = {},
): PathState {
  const seen = new Set(prev.seen)
  let reached = prev.reached
  path.forEach((hop, i) => {
    if (ringableHop(hop) && onScreen(i)) {
      seen.add(i)
      if (i > reached) reached = i
    }
  })
  const targetHop =
    arrived.targetAnchor === undefined
      ? -1
      : path.findIndex((hop) => hop.anchor === arrived.targetAnchor)
  const atTarget = targetOnScreen && arrived.onRoute !== false
  let wasThere = prev.arrived === true
  if (wasThere && !targetOnScreen) {
    for (let i = Math.min(reached, path.length) - 1; i >= 0; i--) {
      const hop = path[i]
      if (hop && ringableHop(hop) && onScreen(i)) {
        reached = i
        wasThere = false
        break
      }
    }
  }
  for (;;) {
    const hop = path[reached]
    if (!hop || !ringableHop(hop)) break
    const taken =
      (atTarget && (targetHop === -1 || reached <= targetHop)) ||
      (hop.rail === true && inApp && !onScreen(reached)) ||
      (seen.has(reached) && !onScreen(reached) && targetOnScreen)
    if (!taken) break
    reached += 1
  }
  const there = wasThere || atTarget
  if (
    reached === prev.reached &&
    seen.size === prev.seen.size &&
    there === (prev.arrived === true)
  ) {
    return prev
  }
  return { reached, seen, arrived: there }
}

/** Where the person is on the way: hops before `done` passed, `current` the one to take. */
export function pathProgress(path: readonly EffectivePathHop[], state: PathState): PathProgress {
  const done = Math.min(state.reached, path.length)
  return { done, current: done < path.length ? done : null }
}
