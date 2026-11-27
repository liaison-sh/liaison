// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"
import {
  getTabType,
  patternToUrl,
  tabDisplayLabel,
  tabTypeRegistryVersion,
  urlToTabInfo,
} from "~/framework/app-registry"
import { tNow } from "~/modules/i18n/i18n-context"
import { tabStore } from "~/modules/shell/tab-store"

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

/**
 * The screen Back goes UP to from the detail at `pathname`, as a route the
 * shell can actually render. A tab type may name it (`parentRoute`: a
 * conversation's list is `/chats`, not the `/threads` its pattern implies).
 * Otherwise the pathname is cut back one level at a time, from the pattern's
 * own entity tail, until a prefix resolves to a registered screen that is not
 * itself a detail: the bare pattern head is not enough, since `/threads`
 * matches no screen at all (an unmatched route, a dead page) and
 * `/projects/tasks` reads as the project whose id is "tasks". Nothing left
 * resolves: Home.
 */
export function parentRouteForPath(pathname: string): string {
  const info = urlToTabInfo(pathname)
  const registration = info ? getTabType(info.type) : undefined
  if (!registration) return "/"
  if (registration.parentRoute) return registration.parentRoute
  const parts = segments(pathname)
  // The pattern's entity tail may span several path segments (`:entityId+`),
  // so the cut starts at the pattern's head, read off the real path so an
  // earlier dynamic scope keeps its value.
  for (
    let depth = Math.min(segments(registration.urlPattern).length - 1, parts.length - 1);
    depth > 0;
    depth--
  ) {
    const candidate = `/${parts.slice(0, depth).join("/")}`
    const found = urlToTabInfo(candidate)
    const parent = found ? getTabType(found.type) : undefined
    if (!found || !parent || isDetailRoute(candidate)) continue
    // The screen's canonical url: `/knowledge/documents` resolves to the
    // Knowledge root by prefix, and Back lands on that root's own route.
    return patternToUrl(parent.urlPattern, found.entityId)
  }
  return "/"
}

/** Marker written into the pushed history entry's state by `pushDetail`. */
const PUSHED_DETAIL = "pushNavDetail"

/**
 * Where the CURRENT detail was opened from, for the back control: its label
 * and, for a detail opened as a tab of its own (You > Agents), the screen
 * Back returns to. A module signal rather than history state: the router
 * nests (and, across a tab-store URL sync, replaces) the entry's own state,
 * so reading it back out of history is unreliable, while there is only ever
 * one detail on screen at a time.
 *
 * It names the detail it was recorded for, the pathname `pushDetail` pushed
 * or the tab `openDetailFrom` opened, and holds only while that detail is on
 * screen. A record that outlived its screen (a thread pushed from Chats, left
 * through the tab bar) used to label the next detail opened from anywhere
 * else: "< Chats" on an agent page reached from You.
 */
interface DetailOpener {
  label: string | null
  /** The route Back goes to when there is no pushed history entry to pop. */
  returnTo: string | null
  /** The pathname the record is for (`pushDetail`), and the one it was pushed from. */
  path?: string
  from?: string
  /** The tab the record is for (`openDetailFrom`), kept across a re-key of its url. */
  tabId?: string
}

const [opener, setOpener] = createSignal<DetailOpener | null>(null)

/**
 * Open a detail that lives in a tab of its own from a root screen, so Back
 * returns there: `open` opens the tab (openTab), and the tab it leaves active
 * is the one the record is for. You > Agents opens the agent page this way;
 * without it, Back went to the agent's parent route, which redirects straight
 * back to the agent, and the button did nothing.
 */
export function openDetailFrom(from: { label: string; returnTo: string }, open: () => void): void {
  open()
  const tabId = tabStore.activeTabId
  setOpener(tabId ? { label: from.label, returnTo: from.returnTo, tabId } : null)
}

/** Test hook: no detail was opened from anywhere. */
export function resetPushNavOpener(): void {
  setOpener(null)
}

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
    const master = parentRouteForPath(location.pathname)
    const info = urlToTabInfo(master)
    const registration = info ? getTabType(info.type) : undefined
    if (!info || !registration) return null
    // In the reader's language: the registered label is the English fallback
    // ("< Knowledge", "< Projects" on a French phone).
    return tabDisplayLabel(tNow, { ...info, label: registration.defaultLabel })
  }

  /** The opener record, when it is for the detail on screen now. */
  const currentOpener = (): DetailOpener | null => {
    const record = opener()
    if (!record) return null
    if (record.path !== undefined && record.path === location.pathname) return record
    if (record.tabId !== undefined && record.tabId === tabStore.activeTabId) return record
    return null
  }

  // A record is dropped once its detail is left any other way than Back (the
  // tab bar, a link): it must not label whatever detail is opened next. The
  // screen it was pushed FROM still counts while the push is under way.
  createEffect(() => {
    const record = opener()
    if (!record) return
    const path = location.pathname
    if (record.path !== undefined && path !== record.path && path !== record.from) setOpener(null)
    if (record.tabId !== undefined && tabStore.activeTabId !== record.tabId) setOpener(null)
  })

  return {
    detailOpen,
    pushDetail: (path: string, opts?: { fromLabel?: string }) => {
      setOpener({ label: opts?.fromLabel ?? null, returnTo: null, path, from: location.pathname })
      navigate(path, { state: { [PUSHED_DETAIL]: true } })
    },
    backLabel: () => (detailOpen() ? (currentOpener()?.label ?? masterLabel()) : null),
    // A deep link opened straight into a detail (a push notification tap, a
    // `liaison://` link, a cold start) has nothing of ours behind it: a
    // browser back there lands wherever the app happened to be, or leaves it.
    // Only the entry `pushDetail` marked is safe to pop; everything else goes
    // UP to the screen it was opened from, else to its parent screen,
    // REPLACING the detail entry, so a later history back does not bounce the
    // user into the detail they just left.
    popDetail: () => {
      const returnTo = currentOpener()?.returnTo ?? null
      setOpener(null)
      if (historyHasPushedDetail()) {
        navigate(-1)
        return
      }
      navigate(returnTo ?? parentRouteForPath(location.pathname), { replace: true })
    },
  }
}
