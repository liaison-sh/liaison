// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One calm line at the top of the content while the app has been waiting on
// the server for a few seconds, so a pause reads as what it is.
//
// "Liaison is updating" ONLY when the server itself said so: its socket closed
// with 1012 (Service Restart, sent by a draining process) or it answered 503
// RESTARTING (lib/server-pause.ts). That shows at once. Anything else (a socket
// that just dropped, a request stuck while the socket is down) is the
// connection, and after SHOW_AFTER_MS says so in neutral words, never naming
// an update. Nothing on first load (that is connecting, not a pause), nothing
// for a blip, and it goes the moment the socket is back: no "restored" line.
//
// It leaves to its neighbours what they already say: the offline banner on a
// phone or tablet, the "keeps dropping" notice for a VPN cutting the socket.
import { type Component, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { oldestPendingAt, restartSignalAt } from "~/lib/server-pause"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { useOptionalWs } from "~/modules/shell/WsContext"
import { createConnectivity } from "~/primitives/createConnectivity"

/** A wait shorter than this is a blip and shows nothing. */
export const SHOW_AFTER_MS = 3_000
/** After this long on an update, the text also points at the connection. */
export const STILL_UPDATING_AFTER_MS = 90_000
/**
 * A 503 RESTARTING seen while the socket stays up (the draining process still
 * holds it) counts this long; the socket's 1012 close or an answer ends it sooner.
 */
export const RESTART_SIGNAL_TTL_MS = 30_000
const TICK_MS = 500

export type PauseKind = "updating" | "stillUpdating" | "connectionLost" | "offline"

export interface PauseState {
  now: number
  /** The socket has been connected at least once in this window. */
  everConnected: boolean
  socketUp: boolean
  /** When the socket went down after having been up; null while it is up. */
  socketLostAt: number | null
  /** When the server said it is restarting (lib/server-pause.ts); null otherwise. */
  restartAt: number | null
  /** When the oldest API request in flight started; null with none. */
  oldestPendingAt: number | null
  online: boolean
}

/** What the notice says, or null for nothing. */
export function pauseKind(s: PauseState): PauseKind | null {
  if (!s.everConnected) return null
  if (s.restartAt !== null && !(s.socketUp && s.now - s.restartAt > RESTART_SIGNAL_TTL_MS)) {
    return s.now - s.restartAt >= STILL_UPDATING_AFTER_MS ? "stillUpdating" : "updating"
  }
  if (s.socketUp || s.socketLostAt === null) return null
  const since = Math.min(s.socketLostAt, s.oldestPendingAt ?? Number.POSITIVE_INFINITY)
  if (s.now - since < SHOW_AFTER_MS) return null
  return s.online ? "connectionLost" : "offline"
}

const TEXT_KEY: Record<PauseKind, string> = {
  updating: "kernel.serverPause.updating",
  stillUpdating: "kernel.serverPause.stillUpdating",
  connectionLost: "kernel.serverPause.connectionLost",
  offline: "kernel.serverPause.offline",
}

export const ServerPauseNotice: Component = () => {
  const ws = useOptionalWs()
  if (!ws) return null
  const i18n = useI18n()
  const online = createConnectivity()

  // Whether the socket was ever up, and since when it is down after that.
  const socket = createMemo<{ everConnected: boolean; lostAt: number | null }>(
    (prev) => {
      if (ws.status() === "connected") return { everConnected: true, lostAt: null }
      if (!prev.everConnected) return prev
      return { everConnected: true, lostAt: prev.lostAt ?? Date.now() }
    },
    { everConnected: false, lostAt: null },
  )

  const [now, setNow] = createSignal(Date.now())
  const waiting = () => socket().lostAt !== null || restartSignalAt() !== null
  // A clock only while something is being waited on.
  createEffect(() => {
    if (!waiting()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const kind = createMemo((): PauseKind | null => {
    const k = pauseKind({
      now: now(),
      everConnected: socket().everConnected,
      socketUp: ws.status() === "connected",
      socketLostAt: socket().lostAt,
      restartAt: restartSignalAt(),
      oldestPendingAt: oldestPendingAt(),
      online: online(),
    })
    // Already said by a neighbour: the offline banner (phone, tablet) and
    // the notice for a connection that keeps being cut.
    if (k === "offline" && (shellTier() === "phone" || shellTier() === "tablet")) return null
    if ((k === "connectionLost" || k === "offline") && ws.unstable()) return null
    return k
  })

  return (
    <Show when={kind()}>
      {(k) => (
        <div
          data-testid="server-pause-notice"
          data-pause-kind={k()}
          // A standing condition, not an interruption (see OfflineBanner.tsx).
          role="status"
          class="flex shrink-0 items-center justify-center border-b border-border-subtle bg-surface-active px-4 py-1.5 text-center text-[13px] text-text-secondary motion-safe:animate-[fade-in_200ms_ease-out]"
        >
          {i18n.t(TEXT_KEY[k()])}
        </div>
      )}
    </Show>
  )
}
