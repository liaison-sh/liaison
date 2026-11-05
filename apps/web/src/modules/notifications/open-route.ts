// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE A NOTIFICATION CLICK GOES (LIF-18). One resolver for every surface: a
// desktop notification, a browser notification, a Web Push click handed over
// by the service worker, a `?route=` the worker opened a window on, and a
// phone push tap (the mobile shell turns `liaison://attention/...` into
// `/?route=...`, apps/mobile/src/deep-link.ts).
//
// The route is what the server wrote (push/fanout-consumer.ts for messages,
// notifications/dispatch.ts `attentionRoute` for attention rows), and ONLY
// its two grammars are accepted:
//
//   thread/<id>[?replyRoot=<id>]           the conversation (+ reply panel)
//   attention/<app>/<entityType>/<id>      the item; an approval opens Home
//     [?thread=<id>&message=<id>]          + a message of the item's own thread
//                                          (a task comment) brought into view
//
// A route can arrive from a URL anyone can link to (`/?route=...`), so it is
// treated as hostile: an id is percent-decoded once and must then be an
// identifier (letters, digits and `_ . : @ ~ + = , -`, at most 128, never a
// slash or a dot segment), and anything else is ignored. A well-formed route
// whose `<app>/<entityType>` this client cannot open lands on Home. Nothing
// here ever navigates to a raw path or URL.

import { createEffect, createRoot } from "solid-js"
import {
  areManifestAppsSettled,
  getEntityOpener,
  getPanel,
  getTabType,
  namespaceRegistryKey,
} from "~/framework/app-registry"
import type { ApiClient } from "~/lib/api-client"
import { type DesktopBridge, getDesktopBridge } from "~/lib/desktop-shell-contract"
import { tNow } from "~/modules/i18n/i18n-context"
import { focusApproval } from "~/modules/shell/approval-focus"
import { markAttentionRead, openEntity } from "~/modules/shell/entity-opener"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { openThreadWithReplyPanel, requestChannelJump } from "~/modules/threads/reply-panel-store"

export type NotificationRoute =
  | { kind: "thread"; threadId: string; replyRootId: string | null }
  | {
      kind: "attention"
      app: string
      entityType: string
      entityId: string
      /** A message of the entity's own thread to bring into view (a task comment). */
      focus?: { threadId: string; messageId: string }
    }

const MAX_ROUTE_LENGTH = 512
// An id segment as it may arrive (identifier characters plus percent escapes);
// it is percent-decoded ONCE and the decoded id must then pass `isSafeId`.
const SEGMENT = "[A-Za-z0-9_.:@~+=,%-]{1,384}"
const NAME = "[a-z][a-z0-9_-]{0,63}"
const THREAD_ROUTE = new RegExp(`^thread/(${SEGMENT})(?:\\?replyRoot=(${SEGMENT}))?$`)
const ATTENTION_ROUTE = new RegExp(
  `^attention/(${NAME})/(${NAME})/(${SEGMENT})(?:\\?thread=(${SEGMENT})&message=(${SEGMENT}))?$`,
)
// Ids are not only uuids: an app's own ids may carry `.`, `:`, `@`... What an
// id may never be is a path: no slash or backslash (none of those survive the
// charset), no dot segment, nothing a second decode could turn into one.
const SAFE_ID = /^[A-Za-z0-9_.:@~+=,-]{1,128}$/

/** The decoded id, or null when the segment is not a safe identifier. */
function decodeId(segment: string | undefined): string | null {
  if (segment === undefined) return null
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    return null
  }
  if (!SAFE_ID.test(id) || id === "." || id.includes("..")) return null
  return id
}

/** The route, or null for anything that is not exactly one of the two grammars. */
export function parseNotificationRoute(route: unknown): NotificationRoute | null {
  if (typeof route !== "string" || route.length === 0 || route.length > MAX_ROUTE_LENGTH) {
    return null
  }
  const thread = THREAD_ROUTE.exec(route)
  if (thread) {
    const threadId = decodeId(thread[1])
    const replyRootId = thread[2] === undefined ? null : decodeId(thread[2])
    if (threadId === null || (thread[2] !== undefined && replyRootId === null)) return null
    return { kind: "thread", threadId, replyRootId }
  }
  const attention = ATTENTION_ROUTE.exec(route)
  if (attention) {
    const entityId = decodeId(attention[3])
    if (entityId === null) return null
    const parsed = {
      kind: "attention" as const,
      app: attention[1],
      entityType: attention[2],
      entityId,
    }
    if (attention[4] === undefined) return parsed
    const threadId = decodeId(attention[4])
    const messageId = decodeId(attention[5])
    if (threadId === null || messageId === null) return null
    return { ...parsed, focus: { threadId, messageId } }
  }
  return null
}

/** An approval is decided on Home, where its card is (not in its thread). */
function isApproval(route: NotificationRoute): boolean {
  return (
    route.kind === "attention" && route.app === "kernel" && route.entityType === "approval_request"
  )
}

/** Whether this client registered an in-app destination for `<app>/<entityType>`. */
function isOpenable(app: string, entityType: string): boolean {
  return (
    getEntityOpener(app, entityType) !== undefined ||
    getTabType(`${app}:${entityType}`) !== undefined ||
    getPanel(namespaceRegistryKey(app, `detail:${entityType}`)) !== undefined
  )
}

/** How long a route waits for the plugin apps' UI to register its tab types. */
const SETTLE_TIMEOUT_MS = 15_000

/** Resolves once the manifest apps registered (or gave up), at most SETTLE_TIMEOUT_MS. */
function manifestAppsSettled(): Promise<void> {
  if (areManifestAppsSettled()) return Promise.resolve()
  return new Promise((resolve) => {
    createRoot((dispose) => {
      const done = (): void => {
        clearTimeout(timer)
        dispose()
        resolve()
      }
      const timer = setTimeout(done, SETTLE_TIMEOUT_MS)
      createEffect(() => {
        if (areManifestAppsSettled()) done()
      })
    })
  })
}

let installedApi: ApiClient | null = null
const pending: string[] = []

/**
 * Open what a notification is about. Returns whether it navigated. Before the
 * shell is up (a cold start from a click) the route waits and opens once
 * `installNotificationRoutes` runs. Never throws.
 */
export async function openNotificationRoute(route: unknown, api?: ApiClient): Promise<boolean> {
  const parsed = parseNotificationRoute(route)
  if (parsed === null) return false
  const client = api ?? installedApi
  if (client === null) {
    if (pending.length < 8) pending.push(route as string)
    return false
  }
  try {
    if (parsed.kind === "thread") {
      if (parsed.replyRootId) {
        openThreadWithReplyPanel(parsed.threadId, parsed.replyRootId)
      } else {
        const reg = getTabType("thread")
        openTab({
          type: "thread",
          entityId: parsed.threadId,
          label: reg?.resolveLabel?.(parsed.threadId) ?? reg?.defaultLabel ?? "Thread",
        })
      }
      return true
    }
    if (isApproval(parsed)) {
      // An approval clears through its decision, never by being read: Home,
      // with its card brought into view and opened.
      focusApproval(parsed.entityId)
      openTab({
        type: "kernel:home",
        entityId: "home",
        label: getTabType("kernel:home")?.defaultLabel ?? "Home",
      })
      return true
    }
    if (!isOpenable(parsed.app, parsed.entityType)) {
      await manifestAppsSettled()
      // Nothing here opens that kind of item (an app this client lacks): the
      // click still lands somewhere, on Home, where the attention list is.
      if (!isOpenable(parsed.app, parsed.entityType)) return openHomeFallback()
    }
    // The entity's discussion brings the message into view once it has loaded
    // (threads/EntityDiscussion.tsx follows the same jump a quote asks for).
    if (parsed.focus) requestChannelJump(parsed.focus.threadId, parsed.focus.messageId)
    await openEntity(client, parsed.app, parsed.entityType, parsed.entityId, undefined, {
      markAttentionRead: true,
    })
    // The conversation's own row (a mention, a reply) is read with it.
    if (parsed.focus) markAttentionRead(client, "kernel", "thread", parsed.focus.threadId)
    return true
  } catch (err) {
    console.warn("[notifications] could not open the notification's item:", err)
    return openHomeFallback()
  }
}

/** A well-formed route that resolves to nothing opens Home rather than nothing. */
function openHomeFallback(): boolean {
  try {
    openTab({
      type: "kernel:home",
      entityId: "home",
      label: getTabType("kernel:home")?.defaultLabel ?? "Home",
    })
    return true
  } catch {
    return false
  }
}

/**
 * The `?route=` a service worker opened this window on, or a phone push tap
 * pushed: removed from the address bar (so a reload or a shared link does
 * not replay it), then opened. The parameter is stripped whatever it holds.
 */
export function captureNotificationRouteFromUrl(): void {
  if (typeof window === "undefined") return
  let url: URL
  try {
    url = new URL(window.location.href)
  } catch {
    return
  }
  if (!url.searchParams.has("route")) return
  const route = url.searchParams.get("route")
  url.searchParams.delete("route")
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // An opaque origin refuses replaceState; the route still opens once.
  }
  void openNotificationRoute(route)
}

/**
 * Called once at boot, BEFORE the app renders: reads `?route=` now, and on
 * every history move (the phone shell routes a push tap by pushing
 * `/?route=...` and firing `popstate`). Registered ahead of the router's own
 * listener, so the router never sees the parameter.
 */
export function startNotificationRouteCapture(): void {
  if (typeof window === "undefined") return
  captureNotificationRouteFromUrl()
  window.addEventListener("popstate", captureNotificationRouteFromUrl)
}

// ─── Desktop shell fallback ──────────────────────────────────────────
//
// On a bundled macOS app the shell raises through UNUserNotificationCenter
// and reports the click (`onNotificationClick`, heard in
// installNotificationRoutes). Where it cannot (Windows and Linux, whose
// plugin toast reports no activation, or an unbundled dev build) a click
// brings the window forward and that is all the shell learns. There the page
// offers the way in itself: an "Open" toast, at once when the window is in
// front, else the next time the user comes back to it.

/** How long after the raise coming back to the window still offers the item. */
const OFFER_WINDOW_MS = 2 * 60_000
/** How long the Open toast stays up. */
const OFFER_TOAST_MS = 12_000

let offered: { route: string; title: string; at: number } | null = null
let hasFocus: () => boolean = () => typeof document !== "undefined" && document.hasFocus()

function showOffer(route: string, title: string): void {
  addToast({
    message: title,
    type: "info",
    durationMs: OFFER_TOAST_MS,
    action: {
      label: tNow("kernel.shellUi.openNotification"),
      onClick: () => {
        void openNotificationRoute(route)
      },
    },
  })
}

/** After the desktop shell raised a notification for `route`. */
export function offerShellNotificationRoute(route: string, title: string): void {
  if (parseNotificationRoute(route) === null) return
  if (hasFocus()) {
    offered = null
    showOffer(route, title)
    return
  }
  offered = { route, title, at: Date.now() }
}

function onWindowFocus(): void {
  const offer = offered
  offered = null
  if (offer && Date.now() - offer.at <= OFFER_WINDOW_MS) showOffer(offer.route, offer.title)
}

export interface NotificationRouteDeps {
  /** Where the service worker's messages arrive (navigator.serviceWorker). */
  serviceWorker?: EventTarget | null
  /** Whether this window is in front. */
  hasFocus?: () => boolean
  /** The desktop shell whose notification clicks open here (getDesktopBridge). */
  desktop?: Pick<DesktopBridge, "onNotificationClick"> | null
}

function defaultServiceWorker(): EventTarget | null {
  if (typeof navigator === "undefined") return null
  const sw = (navigator as { serviceWorker?: EventTarget & { startMessages?: () => void } })
    .serviceWorker
  if (!sw || typeof sw.addEventListener !== "function") return null
  // A message the worker posted before this listener existed (a click that
  // focused a window still booting) is delivered once the queue is started.
  queueMicrotask(() => sw.startMessages?.())
  return sw
}

/**
 * The shell is up: routes open from here on, the ones that arrived earlier
 * open now, the service worker's `open-route` messages are heard, and the
 * desktop Open offer follows the window's focus. Returns the uninstaller.
 */
export function installNotificationRoutes(
  api: ApiClient,
  deps: NotificationRouteDeps = {},
): () => void {
  installedApi = api
  if (deps.hasFocus) hasFocus = deps.hasFocus
  const sw = deps.serviceWorker === undefined ? defaultServiceWorker() : deps.serviceWorker
  const onMessage = (event: Event): void => {
    const data = (event as MessageEvent).data as { type?: unknown; route?: unknown } | null
    if (!data || typeof data !== "object" || data.type !== "open-route") return
    const origin = (event as MessageEvent).origin
    if (origin && typeof window !== "undefined" && origin !== window.location.origin) return
    void openNotificationRoute(data.route)
  }
  sw?.addEventListener("message", onMessage)
  if (typeof window !== "undefined") window.addEventListener("focus", onWindowFocus)
  // A click on a notification the desktop shell raised (a click that
  // launched the app is delivered as this subscribes).
  const desktop = deps.desktop === undefined ? getDesktopBridge() : deps.desktop
  const stopDesktop = desktop?.onNotificationClick?.((route) => {
    offered = null
    void openNotificationRoute(route)
  })
  for (const route of pending.splice(0, pending.length)) void openNotificationRoute(route)
  return () => {
    stopDesktop?.()
    sw?.removeEventListener("message", onMessage)
    if (typeof window !== "undefined") window.removeEventListener("focus", onWindowFocus)
    if (installedApi === api) installedApi = null
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const NotificationRouteTestAccess = {
  reset(): void {
    installedApi = null
    pending.splice(0, pending.length)
    offered = null
    hasFocus = () => typeof document !== "undefined" && document.hasFocus()
  },
}
