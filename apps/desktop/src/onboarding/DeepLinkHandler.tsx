// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison://connect?server=...`, and the reason it is a module and not a
// listener inside a component: the OS hands the app the URL as part of
// LAUNCHING it, which is before any component has mounted. A handler wired up
// on mount drops that first link, which is exactly the bug this guards. So the
// subscription starts when the overlay bundle is evaluated (the shell injects
// it before the page's own scripts) and the link waits in a signal until
// something is there to take it.

import type { JSX } from "solid-js"
import { createEffect, createSignal } from "solid-js"
import { invoke, listen } from "../tauri"

/** The Tauri event carrying one `liaison://` URL (`sidecar.rs:31-32`). */
export const DEEP_LINK_EVENT = "liaison-deep-link"

const [pendingDeepLinkSignal, setPendingDeepLink] = createSignal<string | null>(null)
/** The link the OS handed the app, until a mounted handler takes it. */
export const pendingDeepLink = pendingDeepLinkSignal

/**
 * THE ADDRESS A CONNECT LINK PROPOSED, kept rather than consumed (P6d-FX1).
 *
 * `pendingDeepLink` is a QUEUE: whoever drains it clears it, so a second
 * reader (the bridge, which forwards the proposal to apps/web's own connect
 * step) would race the first and usually lose. This signal holds the parsed
 * address instead, is never cleared by a reader, and carries only what
 * `parseConnectLink` already accepted. It is a PROPOSAL and never an applied
 * address: binding an install is still a click in the connect step.
 */
const [connectAddressSignal, setConnectAddress] = createSignal<string | null>(null)
export const connectDeepLinkAddress = connectAddressSignal

/**
 * The `server` a `liaison://connect` link names, or null when the link is not
 * one. The shell applies the same rule in `validate_deep_link` before it emits
 * the event; this is the second half, on the side that would act on the value.
 * A deep link is attacker reachable (any page can navigate to `liaison://`),
 * so a `javascript:` or `file:` server, an extra query parameter or a host
 * other than `connect` is dropped rather than interpreted.
 */
export function parseConnectLink(link: string): string | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== "liaison:") return null
  // A non special scheme keeps its authority in `host`.
  if (url.host !== "connect") return null
  const pairs = [...url.searchParams.entries()]
  if (pairs.length !== 1) return null
  const [name, server] = pairs[0]
  if (name !== "server") return null
  let target: URL
  try {
    target = new URL(server)
  } catch {
    return null
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null
  if (!target.hostname) return null
  return server
}

/**
 * `liaison://oauth-complete?code=...&state=...` (or `error=` in place of
 * `code=`): the end of a system-browser sign-in (RFC 8252), handed to the app
 * by the operating system. The shell checks the same shape in
 * `sidecar.rs::validate_oauth_complete_link` before it forwards the link; this
 * is the second half. The shape is all that is checked here: whether the
 * `state` is the one the page minted, and redeeming the code with its PKCE
 * verifier, is the page's job (apps/web `modules/auth/desktop-oauth.ts`), and
 * a code without that verifier is worth nothing.
 */
export function isOAuthCompleteLink(link: string): boolean {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return false
  }
  if (url.protocol !== "liaison:" || url.host !== "oauth-complete") return false
  if (url.pathname !== "" && url.pathname !== "/") return false
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length) return false
  if (keys.some((key) => key !== "code" && key !== "state" && key !== "error")) return false
  const state = url.searchParams.get("state")
  if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return false
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if ((code === null) === (error === null)) return false
  if (code !== null && !/^[0-9a-f]{64}$/.test(code)) return false
  if (error !== null && (error.length === 0 || error.length > 200)) return false
  return true
}

/**
 * WHO IS WAITING FOR A SIGN-IN TO COME BACK. A completion link that arrives
 * with nobody listening is held for the first listener: the page subscribes
 * when its login card mounts, and a link must not be lost to that ordering.
 */
const oauthListeners = new Set<(link: string) => void>()
const heldOAuthLinks: string[] = []

/** Follows `liaison://oauth-complete` links. The return value stops it. */
export function onOAuthCompleteLink(listener: (link: string) => void): () => void {
  oauthListeners.add(listener)
  for (const link of heldOAuthLinks.splice(0)) listener(link)
  return () => {
    oauthListeners.delete(listener)
  }
}

function deliverOAuthLink(link: string): void {
  if (oauthListeners.size === 0) {
    // One is enough: a newer completion supersedes an older one, and the page
    // matches the state anyway.
    heldOAuthLinks.splice(0, heldOAuthLinks.length, link)
    return
  }
  for (const listener of Array.from(oauthListeners)) listener(link)
}

/**
 * One link the OS handed the app: queued for whoever drains it, and parsed
 * once into the address signal above. Exported so a test can drive a link
 * without a Tauri event, which is the only way to reach this path under jsdom.
 */
export function noteDeepLink(link: string): void {
  // The launch link can reach here twice: on macOS the shell forwards it from
  // its Opened event AND the pull below reads it back from the plugin. The
  // pull records what it delivered, and the event path skips that link ONCE,
  // so the same link opened again later (a second click on it) is proposed
  // again like any new link.
  if (pulled.delete(link)) return
  propose(link)
}

function propose(link: string): void {
  // A sign-in coming back is not a connect proposal, and never reaches the
  // connect queue: it goes to whoever is waiting for it.
  if (isOAuthCompleteLink(link)) {
    deliverOAuthLink(link)
    return
  }
  setPendingDeepLink(link)
  const server = parseConnectLink(link)
  if (server) setConnectAddress(server)
}

/** Launch links the pull delivered and the event path has not yet seen. */
const pulled = new Set<string>()

/** The launch link this window already handled, kept across its reloads. */
const LAUNCH_LINK_SEEN_KEY = "liaison-desktop:launch-link-seen"

function launchLinkSeen(link: string): boolean {
  try {
    return sessionStorage.getItem(LAUNCH_LINK_SEEN_KEY) === link
  } catch {
    return false
  }
}

function markLaunchLinkSeen(link: string): void {
  try {
    sessionStorage.setItem(LAUNCH_LINK_SEEN_KEY, link)
  } catch {
    // A window that refuses storage proposes the launch link again after a
    // reload, which costs one extra confirmation and never a wrong server.
  }
}

/** The connect step was closed: the proposal is dropped, nothing applied. */
export function clearConnectProposal(): void {
  setConnectAddress(null)
}

/** Test seam: forgets the queued link and the proposed address. */
export function resetDeepLinks(): void {
  pulled.clear()
  oauthListeners.clear()
  heldOAuthLinks.length = 0
  setPendingDeepLink(null)
  setConnectAddress(null)
}

/** The deep link plugin's own command, allowed by the window's capability. */
export const LAUNCH_LINKS_COMMAND = "plugin:deep-link|get_current"

/**
 * THE LINK THE APP WAS LAUNCHED WITH, on Windows and Linux.
 *
 * There the plugin reads the launch URL off the command line while it is
 * being set up and emits it at once, which is BEFORE the shell's own listener
 * exists (`main.rs` registers `on_open_url` in setup, after every plugin), so
 * a cold `liaison://connect` link was neither applied nor logged as dropped:
 * the first Windows walk opened the app on a plain login. The plugin keeps
 * that URL as its "current" value, so the page asks for it once, here, at the
 * same moment it subscribes, and every URL goes through `parseConnectLink`
 * like one the shell forwarded. On macOS the launch URL arrives through the
 * shell instead (an Opened event, after setup) and this answers the same
 * value, which `noteDeepLink` folds into one proposal. The plugin keeps the
 * launch URL for the life of the process, so a window that reloads (binding
 * an address reloads it) would be handed the same link again: the link is
 * marked in sessionStorage the first time and skipped after that.
 */
export async function pullLaunchLinks(): Promise<void> {
  let urls: unknown
  try {
    urls = await invoke(LAUNCH_LINKS_COMMAND)
  } catch {
    // No Tauri underneath (apps/web in a browser), or no plugin: no launch
    // link either.
    return
  }
  if (!Array.isArray(urls)) return
  for (const url of urls) {
    if (typeof url !== "string" || launchLinkSeen(url)) continue
    markLaunchLinkSeen(url)
    pulled.add(url)
    propose(url)
  }
}

// Subscribed at import, not at mount: see the note at the top. A page with no
// Tauri underneath it (apps/web served in a plain browser) rejects here, and
// that is not an error worth surfacing: there are no deep links there.
const subscription = Promise.resolve()
  .then(() =>
    listen(DEEP_LINK_EVENT, (event: { payload: unknown }) => {
      if (typeof event.payload === "string") noteDeepLink(event.payload)
    }),
  )
  .catch(() => undefined)
void subscription
void pullLaunchLinks()

export interface DeepLinkHandlerProps {
  /** Called with the server address a connect link carried, once per link. */
  onServerAddress: (url: string) => void
}

/**
 * Renders nothing. It exists to drain the queue into whoever owns the server
 * address (FirstLaunch, through its `initialAddress`), on mount and on every
 * later link.
 */
export function DeepLinkHandler(props: DeepLinkHandlerProps): JSX.Element {
  createEffect(() => {
    const link = pendingDeepLink()
    if (link === null) return
    // Cleared before the callback, so a handler that itself re-renders cannot
    // see the same link a second time.
    setPendingDeepLink(null)
    const server = parseConnectLink(link)
    if (server) props.onServerAddress(server)
  })
  return null
}
