// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desktop shell's entry point in the page. The shell injects the built
// bundle as a Tauri `initialization_script`, so this runs in apps/web's page
// before that page's own scripts.
//
// IT DRAWS NOTHING (A33). The visible UI of a local session is apps/web's,
// rendered by apps/web's own components inside the surfaces the user already
// knows; this file appends no root of its own and mounts no tree. What is
// left is wiring, and every line of it is something the page cannot do for
// itself:
//
//   the server address global   the page resolves its API base while its own
//                               modules load, and it is served from
//                               `tauri://localhost` where "/api" lands in the
//                               bundle
//   the bridge                  the typed window-level API the page renders
//                               from (bridge.ts); a page that finds no bridge
//                               shows no desktop UI at all
//   the refresh bridge          the session token the API puts in the BODY
//                               for this origin, kept in the shell's 0600 file
//   the diagnostics and probe    a debug build's window has to be readable
//                               from outside
//   the shell's events          the sidecar's device grant arrives on the
//                               shell's own schedule, not in answer to
//                               anything here
//   the teardown                a window closing is a session ending, and a
//                               claim nobody releases leaves the conversation
//                               with no answerer until its TTL runs out
//
// Order matters for the first two: anything published after the first await
// is published too late.

import { createEffect, createRoot } from "solid-js"
import { endBridgeSession, publishDesktopBridge, releaseRuntimeLocation } from "./bridge"
import { installWebviewDiagnostics } from "./diagnostics"
import { installDomProbe } from "./dom-probe"
import { installDriverReporter } from "./driver-bridge"
import { onNotificationServerClick } from "./notifications"
import { installReload } from "./reload"
import { armAccountDialogs, defaultAccountHandlers } from "./session/account-menu"
import {
  bootstrapped,
  loadServerAddress,
  noteSessionToken,
  serverAddress,
} from "./session/desktop-store"
import {
  publishedServerAddress,
  publishMirroredServerAddress,
  settleServerAddress,
} from "./session/server-global"
import { installServerNoticeBanner } from "./session/server-notice-banner"
import { reconcileStorageOwner } from "./session/server-switch"
import {
  armShellEvents,
  getServerAddress,
  loadRefreshToken,
  saveRefreshToken,
  signOutOfServer,
  storeRefreshToken,
  switchServer,
} from "./session/sidecar-client"

/**
 * Where the wrapped app looks for its server (apps/web/src/lib/env.ts), and
 * the mobile shell's global by the same name.
 *
 * apps/web is built ONCE for every deployment (S15), so it has no address in
 * it. In a browser that is right: it is served by its own API's origin and a
 * relative "/api" lands there. In this shell the page is served from
 * `tauri://localhost`, where the same relative path resolves inside the
 * bundle, which holds no API, so the address the shell was given at first
 * launch has to be handed over. The overlay is the only part of the shell
 * running INSIDE that page, and it runs as an initialization script, before
 * the page's own modules.
 */
/**
 * Publishes the shell's hint for the wrapped app SYNCHRONOUSLY, as the
 * injected bundle's first act. apps/web resolves its API base while its own
 * modules load, so anything published after the first await is published too
 * late (session/server-global.ts).
 */
export function mountServerGlobal(target: object = globalThis): void {
  publishMirroredServerAddress(target)
}

/** What an auth call answers with, as far as this bridge reads it. */
interface AuthAnswer {
  data?: { refreshToken?: unknown; accessToken?: unknown }
}

/** The header the API takes the refresh token back in. */
const REFRESH_HEADER = "X-Liaison-Refresh"
const REFRESH_PATH = "/api/auth/refresh"
const LOGOUT_PATH = "/api/auth/logout"
const AUTH_PREFIX = "/api/auth/"
/** The marker that says this page's `fetch` is already wrapped. */
const BRIDGE_FLAG = "__liaisonRefreshBridge__"

/**
 * THE WRAPPED SESSION'S REFRESH TOKEN, on the page.
 *
 * The API's refresh cookie is SameSite=Strict, and from `tauri://localhost`
 * every call to the user's Liaison is cross site, so that cookie is attached
 * to none of them: the session died at the first access-token expiry. The API
 * answers one of the shells' own origins with the token in the BODY instead
 * (apps/api/src/lib/response.ts), and this wrapper is the other half: it keeps
 * what a login or a rotation hands back in the shell's 0600 file and presents
 * it on the next refresh.
 *
 * It is installed HERE because the overlay is an initialization script, the
 * only code of ours that runs in that page before apps/web's own modules, and
 * apps/web is wrapped unmodified (S15). The mobile shell does the same thing
 * from its boot bundle (apps/mobile/src/auth/refresh-bridge.ts).
 *
 * Narrow by construction: one header, on one path, on the ORIGIN this install
 * is bound to and no other, with the response handed back untouched.
 */
export interface RefreshBridgeOptions {
  /**
   * How long a sign-out waits for a token call already under way (a refresh
   * that does not come back) before it is sent anyway.
   */
  logoutQueueWaitMs?: number
}

/** How long a sign-out waits for the token call ahead of it. */
const LOGOUT_QUEUE_WAIT_MS = 5000

export function installRefreshBridge(
  origin: () => string | null,
  options: RefreshBridgeOptions = {},
): void {
  const target = globalThis as Record<string, unknown> & { fetch: typeof fetch }
  if (target[BRIDGE_FLAG] === true) return
  const original = target.fetch.bind(target)
  target[BRIDGE_FLAG] = true
  // ONE TOKEN CALL AT A TIME: a refresh or logout started while another is
  // spending the stored token would present that same token. They queue, each
  // reading the store once the one before it has settled (and saved).
  let tokenCalls: Promise<unknown> = Promise.resolve()
  // A SUCCESSOR THE SHELL COULD NOT STORE, held for the life of the window and
  // presented instead of the stored (spent) token, which the server refuses
  // inside 30 s of its rotation when it comes in the header: the window signed
  // out over a failed write. Every token call tries to store it again first.
  let unsaved: { server: string; token: string } | null = null
  // Bumped by every sign-out: a refresh it overtook keeps nothing it is
  // answered with.
  let session = 0
  const keep = async (token: string, server: string): Promise<boolean> => {
    const saved = await saveRefreshToken(token, server)
    unsaved = saved ? null : { server, token }
    return saved
  }
  const presentable = async (server: string): Promise<string | null> => {
    if (unsaved !== null && !sameOrigin(unsaved.server, server)) unsaved = null
    if (unsaved !== null) await keep(unsaved.token, server)
    return unsaved?.token ?? (await loadRefreshToken(server))
  }
  const bridged = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const bound = origin()
    if (typeof input !== "string" || bound === null) return original(input, init)
    let path: string
    try {
      const url = new URL(input)
      if (url.origin !== new URL(bound).origin) return original(input, init)
      path = url.pathname
    } catch {
      return original(input, init)
    }
    if (!path.startsWith(AUTH_PREFIX)) return original(input, init)

    let request = init
    // BOTH ENDS OF THE SESSION. The refresh call presents the token to rotate
    // it; the logout call presents the SAME token so the server has something
    // to revoke. apps/web posts an empty body and this origin carries no
    // cookie, so without the header a sign-out left the session row alive for
    // its full thirty days.
    if (path === REFRESH_PATH || path === LOGOUT_PATH) {
      // Named by the server it is about to be presented to: the shell releases
      // it only when that is its CURRENT server (servers.rs), so a page still
      // pointed at a server it is leaving is never handed the next one's.
      const stored = await presentable(bound)
      if (stored) {
        const headers = new Headers(init?.headers)
        if (!headers.has(REFRESH_HEADER)) headers.set(REFRESH_HEADER, stored)
        request = { ...init, headers }
      }
    }
    if (path === LOGOUT_PATH) {
      // The window's local agent session ends first, while the session it
      // runs under still authenticates the release of its thread claim.
      await endBridgeSession().catch(() => undefined)
      session += 1
      unsaved = null
      // A SIGN-OUT STICKS ON THIS MACHINE WHATEVER THE SERVER ANSWERED.
      // apps/web has dropped its own state by the time this resolves, and a
      // cold start under the shell refreshes with whatever token the shell
      // holds: a token kept after a failed call (offline, a 5xx, a proxy
      // error page) signed the user back in at the next launch. The
      // server-side session then runs out on its own.
      try {
        return await original(input, request)
      } finally {
        await endShellSession(bound)
      }
    }
    const started = session
    const response = await original(input, request)
    // OVERTAKEN BY A SIGN-OUT: what this refresh minted belongs to a session
    // the user has ended in this window, so none of it is kept or handed on.
    if (path === REFRESH_PATH && session !== started) {
      return new Response(JSON.stringify({ error: { code: "signed_out" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }
    if (path === REFRESH_PATH && response.status === 401) unsaved = null
    if (!response.ok) return response
    let body: AuthAnswer | null
    try {
      body = (await response.clone().json()) as AuthAnswer | null
    } catch {
      // A non-JSON answer carries no token, and reading it is not this
      // wrapper's business beyond that.
      return response
    }
    const minted = body?.data?.refreshToken
    if (typeof minted === "string" && minted.length > 0) {
      const saved = await keep(minted, bound)
      // SAVED BEFORE IT IS USED. A rotation whose successor the shell did not
      // keep is not handed to the page: it keeps its old pair and reads this
      // as a transient failure. The successor stays unused, held in memory
      // (`unsaved`), and is what the next refresh presents, never the spent
      // token. A login keeps its answer: there is no old pair to keep.
      if (!saved && path === REFRESH_PATH) {
        return new Response(JSON.stringify({ error: { code: "refresh_token_not_saved" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      }
    }
    // AND THE SESSION ITSELF. apps/web keeps its bearer in memory and tells
    // nobody, so the one place the overlay can learn that a user signed in,
    // and the only bearer its own entry points may use, is the answer to
    // that app's own auth call going past.
    const bearer = body?.data?.accessToken
    if (typeof bearer === "string" && bearer.length > 0) noteSessionToken(bearer)
    return response
  }
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let path: string | null = null
    try {
      path = typeof input === "string" ? new URL(input).pathname : null
    } catch {
      path = null
    }
    if (path !== REFRESH_PATH && path !== LOGOUT_PATH) return bridged(input, init)
    const ahead = tokenCalls
    // A SIGN-OUT WAITS FOR THE CALL AHEAD OF IT ONLY SO LONG, then goes; the
    // refresh it overtook keeps nothing (`session`).
    if (path === LOGOUT_PATH) {
      const call = waitAtMost(ahead, options.logoutQueueWaitMs ?? LOGOUT_QUEUE_WAIT_MS).then(() =>
        bridged(input, init),
      )
      tokenCalls = call.catch(() => undefined)
      return call
    }
    // A REFRESH RUNS TO ITS END whatever the page's signal says: by the time
    // the page gives up (its timeout) the server has usually rotated, and an
    // aborted call loses the successor while the shell keeps the spent token.
    // The call goes out without the signal, its rotation is kept, the next
    // token call queues behind THAT, and only the page stops waiting.
    const settled = ahead.then(() => bridged(input, withoutSignal(init)))
    tokenCalls = settled.catch(() => undefined)
    return honouringSignal(settled, init?.signal)
  }) as typeof fetch
}

/**
 * THE SHELL'S HALF OF A SIGN-OUT made from the page (its own sign-out button).
 *
 * Forgetting the refresh token alone was half a sign out: the agent tokens
 * and the MCP config this machine holds for the server (each a live bearer),
 * the notification credential and the node's credential all outlived the
 * session, and the next person to sign in on this window inherited them. The
 * shell's own `sign_out` forgets all of that, but only for its CURRENT server,
 * so it runs only when that is the server the page signed out of. The token is
 * cleared first, so `sign_out` has nothing left to revoke a second time.
 */
async function endShellSession(bound: string): Promise<void> {
  await storeRefreshToken("", bound)
  noteSessionToken(null)
  const current = serverAddress() ?? (await getServerAddress())
  if (current !== null && sameOrigin(current, bound)) {
    await signOutOfServer().catch(() => undefined)
  }
  // The runtime the user chose is this account's, and the next person to
  // sign in on this window did not choose it. The store and the signal go
  // with the mirror: a window still saying "This machine" to somebody else
  // is a window lying about where their turns run.
  releaseRuntimeLocation()
}

/** Resolves when `ahead` settles or after `ms`, whichever comes first. */
async function waitAtMost(ahead: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ahead.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function withoutSignal(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("signal" in init)) return init
  const { signal: _dropped, ...rest } = init
  return rest
}

/** `result`, or the caller's abort as soon as its signal fires. */
function honouringSignal(
  result: Promise<Response>,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if (!signal) return result
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    result.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Started once per window, whatever the bundle is evaluated. */
let wired = false
/** The reactive wiring's disposer, so a test leaves no effect behind. */
let disposeWiring: (() => void) | null = null

export interface MountOverlayOptions {
  /**
   * Starts the page again once an address is bound. Injected so a test never
   * reloads the runner; the shell leaves it to `location.reload`.
   */
  reload?: () => void
}

/**
 * Wires the shell into the page. Idempotent: an injection script can be
 * evaluated more than once (a reload, a second window), and a second run would
 * mean two listeners on the same shell events.
 *
 * It creates NO element and renders nothing. The name is kept because the
 * shell and every test call it, and because what it mounts is real: the
 * globals the page reads and the listeners the window needs.
 */
export function mountOverlay(doc: Document = document, options: MountOverlayOptions = {}): void {
  if (wired) return
  wired = true
  const view = doc.defaultView ?? globalThis
  // FIRST, before any await and before the page's own modules: the address
  // the last launch confirmed, so apps/web's very first request has a server.
  mountServerGlobal(view)
  // And the bridge, in the same breath and for the same reason (P6d-T04):
  // apps/web resolves it while its own modules load, and a page that found no
  // bridge renders no desktop UI at all.
  publishDesktopBridge(view)
  installWebviewDiagnostics((doc.defaultView ?? window) as Window)
  // The shape of the page a few seconds later: a walk judges the window, and
  // a blank window cannot say by itself whether the page never mounted or
  // mounted and painted nothing (dom-probe.ts).
  installDomProbe(doc)
  // The return half of the shell's DOM driver, so a walk can reach the page's
  // own controls without stealing the machine's pointer (driver-bridge.ts).
  installDriverReporter(view)
  // Reload / force reload: the macOS View menu calls it, Windows and Linux
  // listen for Ctrl+R / F5 (reload.ts).
  installReload(view)
  // Before the page's own modules make their first auth call: the token the
  // server puts in the body has nowhere else to be captured.
  //
  // THE ORIGIN IT MATCHES ON IS THE ONE THE PAGE IS ALREADY USING, which on a
  // reload is the synchronous mirror published two lines above, not the
  // shell's own `serverAddress()`: that one is a signal filled by an async
  // `get_server_address`, so it is still null on the tick apps/web boots. A
  // reload therefore sent `POST /api/auth/refresh` through the bridge while it
  // was bound to nothing, the header was left off, and this origin carries no
  // refresh cookie, so the API answered 401 and a signed-in window came back
  // to the login card. The mirror is only ever a validated origin
  // (session/server-global.ts) and the shell's answer is published over it.
  installRefreshBridge(() => serverAddress() ?? publishedServerAddress(view))
  // Asked once per window: the address is the shell's. Once it has answered,
  // the page's own storage is checked against it: a window that died half way
  // through a server switch still holds the previous server's storage, and is
  // put right before anything is sent (session/server-switch.ts).
  if (!bootstrapped()) {
    void loadServerAddress().then((current) =>
      reconcileStorageOwner(current, (address, outgoing) => switchServer(address, outgoing), {
        reload: options.reload,
      }).catch(() => undefined),
    )
  }
  // The shell's two native questions (removing a server, signing out of
  // Claude): their words in the page's language, and a confirmed removal.
  armAccountDialogs(doc)
  // A click on ANOTHER saved server's notification (the shell raises those
  // itself, server_listeners.rs): the window switches to that server, the
  // page starts again there and takes the route like one of its own.
  onNotificationServerClick((address) => defaultAccountHandlers(options.reload).switchTo(address))
  // Where such a click goes unheard: "New in <server>" when the window comes
  // forward, opening that server's latest notification.
  installServerNoticeBanner({
    doc,
    switchTo: (address) => defaultAccountHandlers(options.reload).switchTo(address),
  })
  // Listening before the shell asks: the device approval is emitted by the
  // shell's own grant, on its schedule, not in answer to anything here.
  void armShellEvents().catch(() => undefined)

  disposeWiring?.()
  disposeWiring = createRoot((dispose) => {
    // Whenever the install has an address, the page has it too: at boot from
    // `get_server_address`, and the moment the login card binds one. Binding
    // one the page did not boot with also starts the page again, once:
    // apps/web has already resolved its session against an origin that serves
    // no API.
    createEffect(() => {
      const address = serverAddress()
      if (address) settleServerAddress(address, { reload: options.reload })
    })
    return dispose
  })

  // THE WINDOW CLOSING IS A SESSION ENDING. Both events, because a Tauri
  // window close and an app exit do not agree on which one fires.
  const onLeaving = () => {
    void endBridgeSession().catch(() => undefined)
  }
  view.addEventListener?.("pagehide", onLeaving)
  view.addEventListener?.("beforeunload", onLeaving)
}

/** Test seam: forgets that this window was wired, and drops its effects. */
export function resetOverlayWiring(): void {
  wired = false
  disposeWiring?.()
  disposeWiring = null
}

/**
 * WHAT THE INJECTED BUNDLE DOES ON EVALUATION, and it does it NOW (P6d-FX3, W1).
 *
 * This used to wait for `document.body` and otherwise defer the whole of
 * `mountOverlay` to `DOMContentLoaded`. An initialization script by definition
 * runs before the document has a body, so the deferred branch was the only
 * branch that ever ran in the real shell, and `DOMContentLoaded` fires AFTER
 * the page's own modules have evaluated: apps/web had already resolved
 * `window.__LIAISON_DESKTOP__`, found nothing, and rendered no desktop surface
 * for the life of the window.
 *
 * NOTHING IN `mountOverlay` NEEDS A BODY. It defines two globals, wraps
 * `fetch`, adds listeners to the window and arms two timers that sample the
 * page seconds later (dom-probe.ts reads `document.body?` and tolerates its
 * absence). So there is nothing left to defer, and the wait was buying an
 * ordering failure for nothing.
 */
export function bootOverlay(doc: Document = document): void {
  mountOverlay(doc)
}

// In a test the module is imported instead, and the entry points are called
// explicitly.
if (typeof document !== "undefined" && !import.meta.env?.VITEST) bootOverlay(document)
