// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NOTICING A DEPLOY FROM AN OPEN TAB.
//
// A browser tab that loaded the app before a deploy keeps running the old code
// for as long as it stays open: nothing in it ever asks whether the server now
// ships something newer. So the build carries its own id (substituted into
// index.html's `liaison-web-build` meta tag by `web-build-id-plugin.ts`, and
// written beside index.html as `build-id.txt`), and the server stamps every API response
// with the id of the web build it bundles (`X-Liaison-Web-Build`). The two are
// compared on the responses the app already receives, and once more when the
// tab comes back into view, through `build-id.txt`, at most every few minutes.
//
// When they differ the page reloads ITSELF, but only when that loses nothing:
// on the next visibility change or navigation, with no upload in flight and no
// text typed into a composer. Otherwise it shows a small banner and lets the
// person reload when they are done. It reloads at most ONCE per new id: if the
// reloaded page still has the old id (a stale cache in front of the server),
// it shows the banner rather than reloading again.
//
// None of this runs in the desktop (Tauri) or mobile (Capacitor) shells. They
// bundle their own web build, which never matches the server's, and update
// through their own channels. Nor in `vite dev`, whose page carries no id.
//
// The id lives in index.html, never in a JS chunk. A chunk's file name is its
// content hash, computed BEFORE the id is known, so a chunk whose source did
// not change keeps its name from one deploy to the next while the id baked
// into it changes. Assets are cached immutably, so a reload served the
// previous deploy's copy of that chunk, with the previous id: the page still
// looked out of date, and "Reload" could never clear the banner. index.html
// is revalidated on every load, so the id it carries is always the one the
// server ships.

import { createSignal } from "solid-js"
import { DESKTOP_BRIDGE_KEY } from "~/lib/desktop-shell-contract"
import { serverAddressOverride } from "~/lib/env"
import { isNativeShell } from "~/lib/native-bridge"

/** The meta tag in index.html whose content is the page's build id. */
export const WEB_BUILD_META_NAME = "liaison-web-build"

/** The build id of the index.html this page was loaded from, or null. */
export function pageWebBuildId(doc: Document | undefined = globalThis.document): string | null {
  const meta = doc?.querySelector?.(`meta[name="${WEB_BUILD_META_NAME}"]`)
  return meta?.getAttribute("content") ?? null
}

export const WEB_BUILD_HEADER = "X-Liaison-Web-Build"
export const WEB_BUILD_ID_PATH = "/build-id.txt"
/** The id this tab last reloaded itself for (sessionStorage, per tab). */
export const RELOADED_FOR_KEY = "liaison:web-build-reloaded-for"
/** The fewest milliseconds between two checks triggered by focus. */
export const CHECK_INTERVAL_MS = 5 * 60_000

/** True for an id a build really carries, false for the bare placeholder. */
export function isRealBuildId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.trim() !== "" && !/^__[A-Z_]+__$/.test(id)
}

/** Inside the desktop or mobile shell, which update through their own channels. */
export function insideAppShell(): boolean {
  if (isNativeShell()) return true
  const global = globalThis as Record<string, unknown>
  if (global[DESKTOP_BRIDGE_KEY] !== undefined && global[DESKTOP_BRIDGE_KEY] !== null) return true
  if (global.__TAURI__ !== undefined || global.__TAURI_INTERNALS__ !== undefined) return true
  if (serverAddressOverride() !== null) return true
  if (typeof location !== "undefined" && !/^https?:$/.test(location.protocol)) return true
  return false
}

export interface WebBuildEnv {
  /** The id of the build this page runs (from its index.html). */
  compiledId: string | null
  inShell: () => boolean
  hasUnsavedWork: () => boolean
  reload: () => void
  fetchServerId: () => Promise<string | null>
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
  now?: () => number
}

export interface WebBuildWatcher {
  /** Feed the id a server response carried (null when it carried none). */
  observe: (serverId: string | null | undefined) => void
  /** The page was hidden or shown. */
  onVisibilityChange: (visible: boolean) => void
  /** The tab regained focus. */
  onFocus: () => void
  /** The SPA moved to another route. */
  onNavigate: () => void
  /** Whether the "updated, reload" banner is up. */
  bannerVisible: () => boolean
}

export function createWebBuildWatcher(env: WebBuildEnv): WebBuildWatcher {
  const now = env.now ?? (() => Date.now())
  const [banner, setBanner] = createSignal(false)
  let newerId: string | null = null
  let lastCheck = now()
  let checking = false

  const enabled = () => isRealBuildId(env.compiledId) && !env.inShell()

  function readReloadedFor(): string | null {
    try {
      return env.storage?.getItem(RELOADED_FOR_KEY) ?? null
    } catch {
      return null
    }
  }

  function observe(serverId: string | null | undefined): void {
    if (!isRealBuildId(serverId) || !enabled()) return
    if (serverId === env.compiledId) {
      newerId = null
      setBanner(false)
      return
    }
    newerId = serverId
    // Already reloaded once for this very id and still running the old code:
    // a second reload would loop. Say so instead.
    if (readReloadedFor() === serverId) setBanner(true)
  }

  /** Reload now if that loses nothing, else raise the banner. */
  function apply(): void {
    if (newerId === null || !enabled()) return
    if (readReloadedFor() === newerId || env.hasUnsavedWork()) {
      setBanner(true)
      return
    }
    try {
      env.storage?.setItem(RELOADED_FOR_KEY, newerId)
    } catch {
      // Cannot remember the attempt; without storage there is no loop guard,
      // so do not reload at all.
      setBanner(true)
      return
    }
    env.reload()
  }

  function check(): void {
    if (!enabled() || checking || now() - lastCheck < CHECK_INTERVAL_MS) return
    checking = true
    lastCheck = now()
    env
      .fetchServerId()
      .then((id) => observe(id))
      .catch(() => {
        // Offline or the server is restarting: the next response will tell.
      })
      .finally(() => {
        checking = false
      })
  }

  return {
    observe,
    onVisibilityChange(visible) {
      apply()
      if (visible) check()
    },
    onFocus: check,
    onNavigate: apply,
    bannerVisible: banner,
  }
}

/**
 * What a reload would throw away: a file still uploading, or text typed into
 * a composer (every composer is a textarea or a contenteditable). Mail and
 * ticket drafts are saved as they are typed, but a thread composer's text is
 * not, so any non-empty field counts.
 */
export function pageHasUnsavedWork(inFlightUploads: () => number): boolean {
  if (inFlightUploads() > 0) return true
  if (typeof document === "undefined") return false
  for (const el of Array.from(document.querySelectorAll("textarea"))) {
    if (el.value.trim() !== "") return true
  }
  for (const el of Array.from(document.querySelectorAll('[contenteditable="true"]'))) {
    if ((el.textContent ?? "").trim() !== "") return true
  }
  return false
}

// The page's one watcher, installed at boot by `startWebBuildWatch`. The API
// client reports every response here; before installation (and in tests that
// never install one) reporting is a no-op.
let installed: WebBuildWatcher | null = null

export function installWebBuildWatcher(watcher: WebBuildWatcher | null): void {
  installed = watcher
}

/** Hand a response's build header to the watcher. Never throws. */
export function noteWebBuildFrom(response: { headers?: Headers } | null | undefined): void {
  if (installed === null) return
  try {
    installed.observe(response?.headers?.get?.(WEB_BUILD_HEADER) ?? null)
  } catch {
    // A hint, never worth a failed request.
  }
}
