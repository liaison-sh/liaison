// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation, useNavigate } from "@solidjs/router"
import { createSignal } from "solid-js"
import {
  getTabType,
  tabDisplayLabel,
  tabTypeRegistryVersion,
  urlToTabInfo,
} from "~/framework/app-registry"
import { tNow } from "~/modules/i18n/i18n-context"

const DYNAMIC_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)\+?$/

/**
 * The registry's entity convention: a dynamic slot names an ENTITY when its
 * param is `entityId` (the kernel tab system's own name, optionally the
 * multi-segment `:entityId+`) or a descriptive `<thing>Id`, as plugins name
 * theirs in their manifest (`:documentId`). A dynamic slot named for anything
 * else is a list facet, not an entity: `/invoicing/documents/:typeFilter`
 * scopes a LIST, and a Back control there drops the user out of the list they
 * were reading rather than out of a detail they opened.
 */
function isEntityParam(param: string): boolean {
  return param === "entityId" || /Id$/.test(param)
}

/** The pattern's path segments, "/a/b/:c" -> ["a", "b", ":c"]. */
function segments(pattern: string): string[] {
  return pattern.split("/").filter((s) => s !== "")
}

/**
 * True when a registered url pattern describes a detail view: its LAST segment
 * is a dynamic entity segment. A dynamic segment anywhere earlier is a scope
 * (an account, a board) that the tail still lists inside, so it does not make
 * the route a detail.
 */
export function patternIsDetail(pattern: string): boolean {
  const parts = segments(pattern)
  const last = parts.at(-1)
  if (last === undefined) return false
  const match = DYNAMIC_SEGMENT.exec(last)
  return match !== null && isEntityParam(match[1])
}

/** The list route a detail pattern was opened from: the pattern minus its entity tail. */
export function masterRouteFor(pattern: string): string {
  const parts = segments(pattern)
  if (parts.length === 0) return "/"
  const head = parts.slice(0, -1)
  return head.length === 0 ? "/" : `/${head.join("/")}`
}

/**
 * True when `pathname` resolves to a registered tab type whose own url pattern
 * names an entity in its last segment. The registry's `urlPattern` declaration
 * is the existing seam for "this route is a detail view"; no second routing
 * table is introduced.
 */
export function isDetailRoute(pathname: string): boolean {
  const info = urlToTabInfo(pathname)
  if (!info) return false
  const registration = getTabType(info.type)
  if (!registration) return false
  return patternIsDetail(registration.urlPattern) && info.entityId !== ""
}

/** The master route for a rendered pathname, or "/" when nothing matches. */
function masterRouteForPath(pathname: string): string {
  const info = urlToTabInfo(pathname)
  const registration = info ? getTabType(info.type) : undefined
  return registration ? masterRouteFor(registration.urlPattern) : "/"
}

/** Marker written into the pushed history entry's state by `pushDetail`. */
const PUSHED_DETAIL = "pushNavDetail"

/**
 * The screen the CURRENT detail was pushed from, for the back control's label.
 * A module signal rather than history state: the router nests (and, across a
 * tab-store URL sync, replaces) the entry's own state, so reading the label
 * back out of history is unreliable, while there is only ever one detail on
 * screen at a time.
 */
const [pushedFromLabel, setPushedFromLabel] = createSignal<string | null>(null)

function historyHasPushedDetail(): boolean {
  const raw: unknown = typeof history === "undefined" ? null : history.state
  if (!raw || typeof raw !== "object") return false
  const state = raw as Record<string, unknown>
  if (state[PUSHED_DETAIL] === true) return true
  // The router nests the caller's state under `state` in its own entry.
  const nested = state.state
  return (
    !!nested &&
    typeof nested === "object" &&
    (nested as Record<string, unknown>)[PUSHED_DETAIL] === true
  )
}

export interface PushNav {
  /** True when the active route is a detail view of the active tab type. */
  detailOpen: () => boolean
  /** Push a detail screen. Real navigation, so it lands in the history stack.
   *  `fromLabel` names the screen it was pushed from, for the back control. */
  pushDetail: (path: string, opts?: { fromLabel?: string }) => void
  /** Back out of a detail: real browser back when we pushed it, else the master route. */
  popDetail: () => void
  /** What the back control should say: the screen the detail was pushed from
   *  when one was named, else the master route's registered label. */
  backLabel: () => string | null
}

/**
 * Phone-tier master/detail push navigation. A list plus detail surface shows
 * one pane at a time: opening a detail pushes a back navigable screen instead
 * of splitting the view.
 */
export function createPushNav(): PushNav {
  const location = useLocation()
  const navigate = useNavigate()

  // A plain derived accessor, not a memo: the router's `location.pathname` is
  // itself reactive, so every read re-tracks, and nothing here is expensive
  // enough to be worth caching.
  const detailOpen = () => {
    // Re-derive when a manifest registers tab types after load.
    tabTypeRegistryVersion()
    return isDetailRoute(location.pathname)
  }

  /** The registered label of the route a Back would land on. */
  const masterLabel = (): string | null => {
    tabTypeRegistryVersion()
    const master = masterRouteForPath(location.pathname)
    const info = urlToTabInfo(master)
    const registration = info ? getTabType(info.type) : undefined
    if (!info || !registration) return null
    // In the reader's language: the registered label is the English fallback
    // ("< Knowledge", "< Projects" on a French phone).
    return tabDisplayLabel(tNow, { ...info, label: registration.defaultLabel })
  }

  return {
    detailOpen,
    pushDetail: (path: string, opts?: { fromLabel?: string }) => {
      setPushedFromLabel(opts?.fromLabel ?? null)
      navigate(path, { state: { [PUSHED_DETAIL]: true } })
    },
    backLabel: () => (detailOpen() ? (pushedFromLabel() ?? masterLabel()) : null),
    // A deep link opened straight into a detail has nothing behind it: a
    // browser back there leaves the app entirely. Only the entry `pushDetail`
    // marked is safe to pop; everything else goes UP to the master route.
    popDetail: () => {
      setPushedFromLabel(null)
      if (historyHasPushedDetail()) {
        navigate(-1)
        return
      }
      navigate(masterRouteForPath(location.pathname))
    },
  }
}
