// SPDX-License-Identifier: FSL-1.1-ALv2
// Registry-layer resync bus. Zero domain imports (mirrors app-registry.ts).
//
// One global signal that any subscribed resource/store can watch to force a
// refetch-in-place. Bumped by kernel wiring on: (a) the WS `sync` frame, and
// (b) every ws status transition disconnected|reconnecting -> connected. This
// covers both the buffer-expired laptop-sleep case and the lastEventId=0
// reconnect hole without any per-entity WS plumbing.
import { type Accessor, createEffect, createSignal } from "solid-js"
import { log } from "~/lib/logger"

/** WS connection status, as reported by `createWebSocket`. */
export type WsStatus = "connecting" | "connected" | "disconnected" | "reconnecting"

const [version, setVersion] = createSignal(0)

/** Monotonic counter — bumps whenever a resync is requested. */
export const resyncVersion: Accessor<number> = version

// Imperative subscribers. Module-level kernel stores (thread, mail, contacts,
// …) live outside any reactive owner, so they cannot use an effect-based
// subscription. They register here and are invoked synchronously on each bump.
const subscribers = new Set<(version: number) => void>()

/**
 * Force every subscribed resource/store to refetch in place. `reason` is a
 * short tag for diagnostics ("ws-sync", "ws-reconnect").
 */
export function requestResync(reason: string): void {
  setVersion((v) => v + 1)
  const v = version()
  log.debug({ reason, version: v }, "resync requested")
  for (const cb of subscribers) {
    try {
      cb(v)
    } catch (err) {
      log.error({ err, reason }, "resync subscriber threw")
    }
  }
}

/**
 * Register a module-level (owner-less) resync subscriber. Returns an
 * unsubscribe. Safe to call idempotently — the same callback registers once.
 */
export function subscribeResync(cb: (version: number) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Convenience: run `cb` on every resync bump. Returns nothing special — the
 * caller owns the reactive scope (call inside a createRoot/component owner so
 * the underlying effect is disposed with it).
 */
export function onResync(cb: (version: number) => void): void {
  // createEffect is safe here because callers invoke onResync from within an
  // owner (createRoot / component body), so the effect is disposed with them.
  let seen = version()
  createEffect(() => {
    const v = version()
    if (v !== seen) {
      seen = v
      cb(v)
    }
  })
}

/**
 * Reconnect-transition -> resync wiring (A2). Any transition INTO "connected"
 * from "disconnected"/"reconnecting" is a resync trigger — it covers the
 * lastEventId=0 reconnect hole (the server can't always replay from 0) and the
 * laptop-sleep case where the buffer expired. Seeds the tracker with the
 * CURRENT status so the initial connecting->connected edge does NOT fire.
 *
 * Call from within a reactive owner (component body / createRoot) — installs
 * a createEffect that is disposed with that owner.
 */
export function installReconnectResync(status: Accessor<WsStatus>): void {
  let prevWsStatus = status()
  // A connected socket was lost since the last "connected". The socket's own
  // reconnect passes through "connecting" (reconnecting -> connecting ->
  // connected), so the edge into "connected" alone never saw the loss.
  let lost = false
  createEffect(() => {
    const next = status()
    const prev = prevWsStatus
    prevWsStatus = next
    if (prev === "connected" && next !== "connected") lost = true
    if (next === "connected" && (lost || prev === "disconnected" || prev === "reconnecting")) {
      lost = false
      requestResync("ws-reconnect")
    }
  })
}

/** How long a page must have been hidden before its return counts as a resume. */
export const RESUME_RESYNC_MIN_HIDDEN_MS = 5_000

/**
 * Resume -> resync wiring. A page that comes back after being hidden (the
 * phone app returning from the background, a laptop tab brought forward)
 * refetches every subscribed store in place.
 *
 * The socket's own reconnect covers only a socket that noticed it died. A
 * suspended iOS web view can wake with a socket that still reads "connected"
 * while everything sent to it in the meantime is gone, including the read
 * marks another device moved: the phone then showed as unread what had been
 * read on the laptop, until something else happened to reload the list. The
 * short threshold keeps a quick glance at another tab from refetching.
 *
 * Returns the uninstaller. Call once per session (Shell), inside its owner.
 */
export function installResumeResync(
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  now: () => number = () => Date.now(),
): () => void {
  let hiddenAt: number | null = doc.visibilityState === "hidden" ? now() : null
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      hiddenAt = now()
      return
    }
    if (hiddenAt === null) return
    const away = now() - hiddenAt
    hiddenAt = null
    if (away >= RESUME_RESYNC_MIN_HIDDEN_MS) requestResync("resume")
  }
  doc.addEventListener("visibilitychange", onVisibility)
  return () => doc.removeEventListener("visibilitychange", onVisibility)
}
