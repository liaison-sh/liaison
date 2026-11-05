// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison://` links, from a push tap or from anything else on the device that
// can open a URL, turned into a route inside the wrapped SolidJS app.
//
// Two properties this module exists for:
//
//   - It is FAIL CLOSED. A deep link is attacker reachable: any page the user
//     visits can navigate to `liaison://...`, and what comes out of here is
//     handed to the app's router. So a link is accepted only when it is
//     exactly `liaison://thread/<id>` or `liaison://session/<id>` with an
//     identifier shaped id, or exactly `liaison://attention/<app>/<type>/<id>`
//     (a thread-less notification such as an approval, or an entity such as a
//     task, optionally `?thread=<id>&message=<id>` for the comment to bring
//     into view), and nothing else:
//     no extra segment, no query, no
//     fragment. Everything else is
//     dropped, silently, the same rule the desktop shell applies to
//     `liaison://connect` (apps/desktop/src/onboarding/DeepLinkHandler.tsx).
//   - It QUEUES. The operating system hands the app a link as part of
//     LAUNCHING it, which is before the webview has a router to navigate. A
//     listener that fires into nothing drops exactly the link a push tap
//     depends on, so links wait here until the app says it is ready, and each
//     one is delivered exactly once.
//
// The navigator is injected. apps/web is wrapped UNMODIFIED, so there is no
// hook inside it to call: the default navigator below pushes a history entry
// and fires `popstate`, which the app's router already listens to.

/** Takes an in-app route path, e.g. `/threads/abc123`. */
export type DeepLinkNavigator = (routePath: string) => void

/** The literal prefix of a thread link. */
const THREAD_LINK_PREFIX = "liaison://thread/"
/** The literal prefix of a node session link (a session push, C9). */
export const SESSION_LINK_PREFIX = "liaison://session/"

/**
 * Every link shape this app routes: its host, its literal prefix and the route
 * it becomes. Each entry gets the same fail-closed checks.
 */
const ROUTES: readonly { host: string; prefix: string; route: string }[] = [
  { host: "thread", prefix: THREAD_LINK_PREFIX, route: "/threads/" },
  { host: "session", prefix: SESSION_LINK_PREFIX, route: "/sessions/" },
]
/** An id: what the API's own uuids and short ids are made of. */
const LINK_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The host of a thread-less notification link. */
const ATTENTION_HOST = "attention"
const ATTENTION_LINK_PREFIX = "liaison://attention/"
/**
 * `<app>/<entityType>/<entityId>`, the grammar the web app's notification
 * resolver accepts (apps/web/src/modules/notifications/open-route.ts).
 */
const ATTENTION_PATH =
  /^([a-z][a-z0-9_-]{0,63})\/([a-z][a-z0-9_-]{0,63})\/([A-Za-z0-9_.:@~+=,%-]{1,384})$/
/**
 * The entity id once percent-decoded (exactly once, as the web resolver does):
 * identifier characters only, never a slash or a dot segment.
 */
const SAFE_ENTITY_ID = /^[A-Za-z0-9_.:@~+=,-]{1,128}$/
/** `?thread=<id>&message=<id>`: the message an entity's discussion brings into view. */
const FOCUS_QUERY = /^\?thread=([^&#]*)&message=([^&#]*)$/

function isSafeEntityId(segment: string): boolean {
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    return false
  }
  return SAFE_ENTITY_ID.test(id) && id !== "." && !id.includes("..")
}

/**
 * A thread-less notification link to the route the web app opens it by:
 * `/?route=attention/<app>/<type>/<id>`, consumed by the app's notification
 * resolver (it strips the parameter and opens the item, an approval on Home).
 */
function parseAttentionLink(link: string): string | null {
  const rest = link.slice(ATTENTION_LINK_PREFIX.length)
  // The one query an attention link may carry: the thread and message a
  // notification about an entity's thread brings into view in its discussion
  // (a task comment), both identifiers, in this order and nothing else.
  const queryAt = rest.indexOf("?")
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const query = queryAt === -1 ? "" : rest.slice(queryAt)
  if (query !== "") {
    const focus = FOCUS_QUERY.exec(query)
    if (!focus || !LINK_ID.test(focus[1] ?? "") || !LINK_ID.test(focus[2] ?? "")) return null
  }
  const match = ATTENTION_PATH.exec(path)
  if (!match || !isSafeEntityId(match[3] ?? "")) return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== "liaison:" || url.host !== ATTENTION_HOST) return null
  if (url.search !== query || url.hash !== "") return null
  return `/?route=${encodeURIComponent(`attention/${path}${query}`)}`
}

/**
 * The in-app route a `liaison://` link names, or null when the link is not one
 * this app routes. `liaison://connect?server=...` is NOT one: it is answered
 * by the first launch flow (`onboarding/server-address.ts`), which asks before
 * it repoints the install.
 *
 * An `https://` link is never one either (D8): the app claims no associated
 * domain, so the operating system only hands it one by accident, and the
 * scheme is the single way in.
 */
export function parseDeepLink(link: string): string | null {
  // The RAW string, not the parsed one. `new URL("liaison://thread/../../x")`
  // normalizes the dot segments away and hands back a perfectly well formed
  // one segment path, so a check written against the parsed pathname accepts
  // a traversal it was written to refuse. The id is read off the literal text
  // and must be an identifier: no dot, no slash, no `?`, no `#`, no escape.
  if (link.startsWith(ATTENTION_LINK_PREFIX)) return parseAttentionLink(link)
  const entry = ROUTES.find((r) => link.startsWith(r.prefix))
  if (!entry) return null
  const id = link.slice(entry.prefix.length)
  if (!LINK_ID.test(id)) return null
  // Second opinion from the URL parser, so a link that is somehow not a URL at
  // all cannot reach the router either.
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== "liaison:" || url.host !== entry.host) return null
  if (url.search !== "" || url.hash !== "") return null
  return `${entry.route}${id}`
}

/** Pushes the route and lets the app's own router pick it up. */
export function historyNavigator(routePath: string): void {
  if (typeof window === "undefined") return
  window.history.pushState({}, "", routePath)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

export interface DeepLinkQueue {
  /** Called with every `liaison://` URL the OS hands the app. */
  onAppUrlOpen: (link: string) => void
  /** Replaces the navigator. Called at boot, before the app is marked ready. */
  registerNavigator: (navigator: DeepLinkNavigator) => void
  /** The app can route now. Flushes whatever arrived before this point, once. */
  markAppReady: () => void
  /** Links waiting for the app to be ready. Test and diagnostic read. */
  pending: () => readonly string[]
}

export function createDeepLinkQueue(
  navigator: DeepLinkNavigator = historyNavigator,
): DeepLinkQueue {
  let navigate = navigator
  let ready = false
  const pending: string[] = []

  const deliver = (routePath: string) => navigate(routePath)

  return {
    onAppUrlOpen(link: string): void {
      const routePath = parseDeepLink(link)
      if (routePath === null) return
      if (!ready) {
        pending.push(routePath)
        return
      }
      deliver(routePath)
    },
    registerNavigator(next: DeepLinkNavigator): void {
      navigate = next
    },
    markAppReady(): void {
      ready = true
      // Spliced out before delivery, so a navigator that itself re-enters can
      // never see the same link twice.
      const flush = pending.splice(0, pending.length)
      for (const routePath of flush) deliver(routePath)
    },
    pending(): readonly string[] {
      return [...pending]
    },
  }
}

/** The app's one queue. Created at module evaluation, before anything mounts. */
export const deepLinkQueue = createDeepLinkQueue()
