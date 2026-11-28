// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PAGE'S SIDE OF THE SERVED SHELL (apps/desktop/src-tauri/src/served_shell.rs,
// and on iOS apps/mobile/ios/LiaisonShell through lib/native-bridge.ts).
//
// The desktop or phone app may run the server's own web build in its window, once it
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
//   typed would be lost. No prompt. A build that must stop at once (revoked,
//   below the floor, switched off) is left by the host itself, draft or not.
//
// The phone's host fetches and stages newer builds on its own; the page only
// asks it whether the next load would run another build (`refreshShell`).

import { createSignal } from "solid-js"
import {
  type DesktopBridge,
  type DesktopShellStatus,
  getDesktopBridge,
} from "~/lib/desktop-shell-contract"
import { nativeRefreshShell, nativeShellInfo } from "~/lib/native-bridge"
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

/**
 * Asks the shell what runs, once per call: the desktop bridge when there is
 * one, else the phone's host. Null when it cannot say. Never throws.
 */
export async function loadShellStatus(
  bridge: DesktopBridge | null = getDesktopBridge(),
): Promise<DesktopShellStatus | null> {
  if (bridge === null) return loadNativeShellStatus()
  if (typeof bridge.shellStatus !== "function") return null
  try {
    const answer = (await bridge.shellStatus()) ?? null
    setStatus(answer)
    return answer
  } catch {
    return null
  }
}

/** The phone host's report, in the desktop's shape (`pending` is the host's own business). */
async function loadNativeShellStatus(): Promise<DesktopShellStatus | null> {
  const info = await nativeShellInfo()
  if (info === null) return null
  const answer: DesktopShellStatus = {
    served: info.served === true,
    buildId: typeof info.buildId === "string" ? info.buildId : null,
    reason: typeof info.reason === "string" ? info.reason : null,
    pending: false,
  }
  setStatus(answer)
  return answer
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
  /** The shell's refresh: what is pending for the next load (a build id or "bundled"), or null. */
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

/** What the phone's updater stands on: the host stages, the page only asks. */
export interface NativeServedShellUpdaterEnv extends Omit<ServedShellUpdaterEnv, "refreshShell"> {
  /** The host chose again; true when the next document load runs another build. */
  refresh?: () => Promise<boolean>
}

/** The phone's pending marker: the host knows which build, the page only that one waits. */
const NATIVE_STAGED = "staged"

/**
 * The phone's idle reload (S6 on iOS): the same rule as the desktop's, routed
 * to the native host. When the server runs another build, the page asks the
 * host to choose again; when that choice changes the next load, the page
 * reloads itself once idle for 10 minutes with nothing unsaved, and the host
 * moves to the staged build on that load.
 */
export function createNativeServedShellUpdater(
  env: NativeServedShellUpdaterEnv,
): ServedShellUpdater {
  const refresh = env.refresh ?? nativeRefreshShell
  return createServedShellUpdater({
    ...env,
    refreshShell: async () => ((await refresh()) ? NATIVE_STAGED : null),
  })
}
