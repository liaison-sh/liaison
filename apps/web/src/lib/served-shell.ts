// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PAGE'S SIDE OF THE SERVED SHELL (apps/desktop/src-tauri/src/served_shell.rs).
//
// The desktop app may run the server's own web build in its window, once it
// verified Liaison's signature over it, instead of the build compiled into the
// app. The page then:
//
// - tells the shell it rendered (`shellReady`, once, with its own build id):
//   a served build that never does is quarantined and the shell falls back;
// - learns what runs (`shellStatus`): a served build covers every app the
//   server ships, so the compatibility notice never notes one, and the page
//   names it in X-Liaison-Client (`shell=served:<id>` / `bundled:<reason>`);
// - watches for a newer server build while it runs: it asks the shell to
//   fetch it (`refreshShell`), which then runs at the next load, and reloads
//   by itself only once nobody has touched the page for 10 minutes and nothing
//   typed would be lost. No prompt.

import { createSignal } from "solid-js"
import {
  type DesktopBridge,
  type DesktopShellStatus,
  getDesktopBridge,
} from "~/lib/desktop-shell-contract"
import { isRealBuildId, pageWebBuildId } from "~/lib/web-build"

const [status, setStatus] = createSignal<DesktopShellStatus | null>(null)

/** What the shell said runs, or null before (or without) an answer. Reactive. */
export function shellStatus(): DesktopShellStatus | null {
  return status()
}

/** True while the window runs a served build. Reactive. */
export function runningServedShell(): boolean {
  return status()?.served === true
}

/** Asks the shell what runs, once per call. Null when it cannot say. Never throws. */
export async function loadShellStatus(
  bridge: DesktopBridge | null = getDesktopBridge(),
): Promise<DesktopShellStatus | null> {
  if (typeof bridge?.shellStatus !== "function") return null
  try {
    const answer = (await bridge.shellStatus()) ?? null
    setStatus(answer)
    return answer
  } catch {
    return null
  }
}

/** Test seam. */
export function resetShellStatus(): void {
  setStatus(null)
}

const REASON = /^[a-z_]{1,32}$/

/** The `shell=` value of X-Liaison-Client: `served:<build id>` or `bundled:<reason>`. */
export function shellReport(s: DesktopShellStatus | null): string | null {
  if (s === null) return null
  if (s.served && s.buildId !== null && /^[0-9a-f]{16}$/.test(s.buildId)) {
    return `served:${s.buildId}`
  }
  const reason = s.reason !== null && REASON.test(s.reason) ? s.reason : "unknown"
  return `bundled:${reason}`
}

let readySent = false

/** Tells the shell this page rendered, once per page. No-op without a shell or a build id. */
export function signalShellReady(
  bridge: DesktopBridge | null = getDesktopBridge(),
  doc: Document | undefined = globalThis.document,
): void {
  if (readySent || typeof bridge?.shellReady !== "function") return
  const id = pageWebBuildId(doc)
  if (!isRealBuildId(id)) return
  readySent = true
  void bridge.shellReady(id).catch(() => {})
}

/** Test seam. */
export function resetShellReady(): void {
  readySent = false
}

/** No input for this long, and nothing unsaved, before a silent reload. */
export const IDLE_RELOAD_MS = 10 * 60_000
/** The fewest milliseconds between two asks for the server's build id. */
export const SERVED_CHECK_INTERVAL_MS = 5 * 60_000

export interface ServedShellUpdaterEnv {
  /** The build id of the page that runs (its index.html). */
  pageBuildId: string
  /** The server's desktop build id (`/api/shell/info`), or null. */
  fetchServerBuildId: () => Promise<string | null>
  /** The shell's refresh: the build pending for the next load, or null. */
  refreshShell: () => Promise<string | null>
  hasUnsavedWork: () => boolean
  reload: () => void
  now?: () => number
}

export interface ServedShellUpdater {
  /** The person typed, clicked, scrolled or touched. */
  noteInput: () => void
  /** Ask the server for its build (rate limited); a newer one is fetched by the shell. */
  check: () => Promise<void>
  /** Reload now if a newer build is pending, the page is idle and nothing is unsaved. */
  tick: () => boolean
  /** The build waiting for the next load, or null. */
  pending: () => string | null
}

export function createServedShellUpdater(env: ServedShellUpdaterEnv): ServedShellUpdater {
  const now = env.now ?? (() => Date.now())
  let lastInput = now()
  let lastCheck = Number.NEGATIVE_INFINITY
  let checking = false
  let pending: string | null = null

  return {
    noteInput() {
      lastInput = now()
    },
    async check() {
      if (checking || pending !== null || now() - lastCheck < SERVED_CHECK_INTERVAL_MS) return
      checking = true
      lastCheck = now()
      try {
        const serverId = await env.fetchServerBuildId()
        if (!isRealBuildId(serverId) || serverId === env.pageBuildId) return
        const next = await env.refreshShell()
        if (next !== null && next !== env.pageBuildId) pending = next
      } catch {
        // Offline or restarting: the next check will tell.
      } finally {
        checking = false
      }
    },
    tick() {
      if (pending === null) return false
      if (now() - lastInput < IDLE_RELOAD_MS) return false
      if (env.hasUnsavedWork()) return false
      env.reload()
      return true
    },
    pending: () => pending,
  }
}
