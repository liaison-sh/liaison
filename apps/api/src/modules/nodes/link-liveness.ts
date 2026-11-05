// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Walk D9: how fast a dead node socket is noticed. A peer that vanished
 * without a close (Wi-Fi off, a sleeping laptop) sends nothing; Bun reaps it
 * only at its 120 s idle timeout, and the node's sessions then showed
 * `paused` after more than two minutes. A node connection is pinged every
 * 10 s (the webview answers pings on its own), and cut once nothing at all,
 * pong or message, was heard for 35 s: its close then pauses the sessions.
 * The deadline stays over the client's 30 s heartbeat, so a peer whose pongs
 * a proxy swallowed still holds on its heartbeat alone.
 */

export const NODE_LINK_PING_MS = 10_000
export const NODE_LINK_DEADLINE_MS = 35_000

export interface PingableSocket {
  ping(): void
  terminate(): void
}

/** Watch one node socket; returns the function that ends the watch. */
export function watchNodeLink(
  ws: PingableSocket,
  lastHeardAt: () => number,
  opts: { intervalMs?: number; deadlineMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? NODE_LINK_PING_MS
  const deadlineMs = opts.deadlineMs ?? NODE_LINK_DEADLINE_MS
  const timer = setInterval(() => {
    try {
      if (Date.now() - lastHeardAt() > deadlineMs) {
        clearInterval(timer)
        ws.terminate()
        return
      }
      ws.ping()
    } catch {
      // The socket is already torn down: its close clears this watch.
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
