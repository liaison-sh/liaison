// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recovery from a stale lazy chunk after a deploy.
//
// The app is code-split: every tab body is a `lazy()` dynamic import of a
// hashed asset (`/assets/MailConversation-LdzMX3g8.js`). The hash changes on
// every build, and a deploy replaces the whole `assets/` directory. A browser
// that loaded `index.html` BEFORE the deploy is still holding the old module
// graph, so the first tab it opens afterwards asks for a file that no longer
// exists and the import rejects with
//   TypeError: error loading dynamically imported module: <url>
//
// The tab error boundary caught this and rendered its generic "something went
// wrong" with a `reset` button — which cannot possibly work here: reset re-runs
// the same import, against the same missing URL, forever. Prod, ticket-10193:
// an operator could not open a pending mail draft at all; the page was simply
// dead until they happened to hard-refresh. Deploys are frequent
// (deploy-liaison.sh recreates the container on the active node), so every
// deploy leaves every open session one click away from this.
//
// A stale chunk is fixed by exactly one thing: reload, and pick up the new
// index. So do that automatically, ONCE. The sentinel is what keeps it honest:
// if the reload does not fix it (a genuinely broken build, an asset the server
// really is not serving), the second failure must render an explanation rather
// than reload again, or the tab becomes a refresh loop.

const RELOAD_SENTINEL = "liaison:stale-chunk-reloaded-at"
/** How long a reload counts as "we already tried that". */
const RETRY_WINDOW_MS = 30_000

/**
 * True when `err` is a failed dynamic import, across the wordings the engines
 * use. Chrome/Safari say "error loading dynamically imported module", Firefox
 * says "error loading dynamically imported module" too but Vite's own preload
 * helper rejects with "Failed to fetch dynamically imported module"; a
 * `<script>`-level failure surfaces as "Importing a module script failed".
 */
export function isStaleChunkError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "")
  return (
    /dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /^Failed to fetch dynamically imported module/i.test(message)
  )
}

function readSentinel(storage: Pick<Storage, "getItem">): number | null {
  try {
    const raw = storage.getItem(RELOAD_SENTINEL)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    // Private mode / blocked site data: no memory of a previous attempt. Treat
    // it as "not yet tried" — one reload is the right guess, and the worst case
    // is a browser that cannot remember and so does not loop-protect. See the
    // caller: it only reloads for a stale-chunk error, which a reload fixes.
    return null
  }
}

export interface StaleChunkEnv {
  storage?: Pick<Storage, "getItem" | "setItem">
  reload?: () => void
  now?: () => number
  /** Whether the device has a network. Defaults to `navigator.onLine`. */
  online?: () => boolean
  /** Runs `fn` once the device is back online. Defaults to the window's `online` event. */
  whenOnline?: (fn: () => void) => void
}

// OFFLINE IS NOT STALE. A chunk requested while the device has no network
// fails with the same "Failed to fetch dynamically imported module" as a chunk
// a deploy removed. Reloading then lands on the browser's own offline error
// page: the app is gone, and it does not come back with the network. So while
// offline the reload waits for the network, and happens once it is back
// (once, however many imports failed meanwhile).
let reloadWaitingForOnline = false

function browserOnline(): boolean {
  if (typeof navigator === "undefined") return true
  return typeof navigator.onLine === "boolean" ? navigator.onLine : true
}

function onNextOnline(fn: () => void): void {
  if (typeof window === "undefined") return
  window.addEventListener("online", fn, { once: true })
}

/**
 * Run `reload` now, or, while the device is offline, when it is back online.
 * Returns true when the reload was deferred.
 */
export function reloadWhenOnline(
  reload: () => void,
  env: Pick<StaleChunkEnv, "online" | "whenOnline"> = {},
): boolean {
  const online = env.online ?? browserOnline
  if (online()) {
    reload()
    return false
  }
  if (reloadWaitingForOnline) return true
  reloadWaitingForOnline = true
  ;(env.whenOnline ?? onNextOnline)(() => {
    reloadWaitingForOnline = false
    reload()
  })
  return true
}

/**
 * If `err` is a stale chunk and we have not already reloaded for one very
 * recently, reload the page and return true (the caller's fallback UI will be
 * torn down with the document). Returns false when the caller must render
 * something — either because the error is unrelated, or because a reload has
 * already been tried and did not help.
 */
export function recoverFromStaleChunk(err: unknown, env: StaleChunkEnv = {}): boolean {
  if (!isStaleChunkError(err)) return false
  const storage =
    env.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined)
  const reload =
    env.reload ?? (typeof location !== "undefined" ? () => location.reload() : undefined)
  if (!reload) return false
  const now = env.now ?? (() => Date.now())
  if (storage) {
    const last = readSentinel(storage)
    if (last !== null && now() - last < RETRY_WINDOW_MS) return false
  }
  reloadWhenOnline(() => {
    try {
      storage?.setItem(RELOAD_SENTINEL, String(now()))
    } catch {
      // Cannot remember the attempt. Reload anyway (below): a stale chunk with
      // no loop protection still beats a permanently dead tab.
    }
    reload()
  }, env)
  return true
}
