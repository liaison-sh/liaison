// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The waiting hook (P3-T07, P4's seam): a session started waiting on its
 * owner. `fireSessionWaiting` is called after the commit, once per transition
 * of the session's open requests (`pending_count`) from none to some, from
 * every path that appends events (node ingest, server appends), never for a
 * re-sent batch. `request` is the oldest request still open.
 *
 * Listeners are called synchronously in subscription order; their errors,
 * thrown or rejected, are logged and never reach the caller (ingest answers
 * the node whatever a listener does), and a listener's promise is not
 * awaited by the request.
 */
import type { NodeSessionStatus } from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import type { NodeSessionRow } from "./store"

const log = rootLogger.child({ module: "node-session-waiting" })

export interface SessionWaitingRequest {
  requestId: string
  eventSeq: number
  type: "permission_request" | "question" | "plan_request"
  tool: string | null
}

export type SessionWaitingListener = (
  row: NodeSessionRow,
  request: SessionWaitingRequest,
) => void | Promise<void>

const listeners = new Set<SessionWaitingListener>()

/** Subscribe; returns the unsubscribe. */
export function onSessionWaiting(listener: SessionWaitingListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tell every listener; resolves once each settled. Never throws. */
export function fireSessionWaiting(
  row: NodeSessionRow,
  request: SessionWaitingRequest,
): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const listener of [...listeners]) {
    try {
      const out = listener(row, request)
      if (out && typeof (out as Promise<void>).then === "function") {
        pending.push(
          (out as Promise<void>).catch((err) =>
            log.warn({ err, sessionId: row.id }, "a session waiting listener failed"),
          ),
        )
      }
    } catch (err) {
      log.warn({ err, sessionId: row.id }, "a session waiting listener failed")
    }
  }
  return Promise.all(pending).then(() => undefined)
}

// ── the status hook (P4's notices, round 2) ─────────────────────────────────

/**
 * A session moved from one status to another. `cause` says who moved it: the
 * node (a run's end, a batch that opened a request), the owner (Mark done,
 * Stop, a message that resumes it), the server (sweeps, presence, a claim) or
 * a follow's end (A45: told like the owner's, never a notice or a post).
 * `becameWaiting` is set on a waiting edge (the oldest request still open).
 */
export interface SessionStatusChange {
  from: NodeSessionStatus
  to: NodeSessionStatus
  reason?: string
  cause: "node" | "owner" | "server" | "follow"
  becameWaiting?: SessionWaitingRequest
}

export type SessionStatusListener = (
  row: NodeSessionRow,
  change: SessionStatusChange,
) => void | Promise<void>

const statusListeners = new Set<SessionStatusListener>()

/** Subscribe; returns the unsubscribe. */
export function onSessionStatus(listener: SessionStatusListener): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/**
 * Tell every listener a session changed status; called after the commit,
 * once per transition, from every path that moves a session. Same rules as
 * `fireSessionWaiting`: listeners are called synchronously in subscription
 * order, their errors are logged, and this never throws.
 */
export function fireSessionStatus(row: NodeSessionRow, change: SessionStatusChange): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const listener of [...statusListeners]) {
    try {
      const out = listener(row, change)
      if (out && typeof (out as Promise<void>).then === "function") {
        pending.push(
          (out as Promise<void>).catch((err) =>
            log.warn({ err, sessionId: row.id }, "a session status listener failed"),
          ),
        )
      }
    } catch (err) {
      log.warn({ err, sessionId: row.id }, "a session status listener failed")
    }
  }
  return Promise.all(pending).then(() => undefined)
}
