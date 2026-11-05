// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NODE JOBS, THE PAGE'S PART (P4 N-D T5). The shell claims and runs the jobs
// (apps/desktop/src/node-jobs/runner.ts); the page only hands it what the
// socket hears, and starts it once this computer is an enabled node. Outside
// the desktop app, or on a computer that is not an enabled node, both are no-ops.

import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { nodeCredentialForHello } from "./node-session"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_-]+$/

/**
 * A `node_job_offer` frame: the shell queues the job (one at a time, FIFO).
 * The frame names the job's agent, so the shell needs no queue read (L24).
 */
export function forwardNodeJobOffer(frame: unknown): void {
  const offer = frame as { jobId?: unknown; agentId?: unknown } | null
  const jobId = offer?.jobId
  if (typeof jobId !== "string" || jobId.length === 0) return
  if (!nodeCredentialForHello()) return
  const agentId = offer?.agentId
  const bridge = getDesktopBridge()
  if (typeof agentId === "string" && agentId.length > 0) bridge?.nodeJobOffered?.(jobId, agentId)
  else bridge?.nodeJobOffered?.(jobId)
}

/**
 * This computer is an enabled node: the shell starts its job runner and asks
 * about backlog jobs once per launch. Answers whether it was started.
 */
export function startNodeJobsIfNode(onReview: () => void): boolean {
  if (!nodeCredentialForHello()) return false
  const bridge = getDesktopBridge()
  if (!bridge?.startNodeJobs) return false
  bridge.startNodeJobs({ onReview })
  return true
}

/**
 * P3 (C5): a `node_session_command` frame. The shell pulls this node's
 * commands and delivers them to its live sessions. Only a session id that is
 * a uuid, and only on an enabled node.
 */
export function forwardNodeSessionCommand(frame: unknown): void {
  const sessionId = (frame as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return
  if (!nodeCredentialForHello()) return
  getDesktopBridge()?.nodeSessionCommand?.(sessionId)
}

/**
 * P3-T22 (S7): a `node_session_full_output` frame: the shell sends the cut
 * output's full text from this computer. Well formed ids, enabled node only.
 */
export function forwardNodeFullOutput(frame: unknown): void {
  const f = frame as { sessionId?: unknown; toolUseId?: unknown } | null
  const sessionId = f?.sessionId
  const toolUseId = f?.toolUseId
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return
  if (typeof toolUseId !== "string" || !TOOL_USE_ID_RE.test(toolUseId)) return
  if (!nodeCredentialForHello()) return
  getDesktopBridge()?.nodeFullOutputRequested?.(sessionId, toolUseId)
}

/**
 * A `node_folder_request` frame: the owner asked about this node's folders
 * from any client; the shell pulls the request and answers it. Uuid only,
 * enabled node only.
 */
export function forwardNodeFolderRequest(frame: unknown): void {
  const requestId = (frame as { requestId?: unknown } | null)?.requestId
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) return
  if (!nodeCredentialForHello()) return
  getDesktopBridge()?.nodeFolderRequest?.(requestId)
}

/**
 * S40: a `node_import_request` frame: the owner asked this node for the
 * Claude Code sessions in its shared folders (or to check one); the shell
 * pulls the request and answers it. Uuid only, enabled node only.
 */
export function forwardNodeImportRequest(frame: unknown): void {
  const requestId = (frame as { requestId?: unknown } | null)?.requestId
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) return
  if (!nodeCredentialForHello()) return
  getDesktopBridge()?.nodeImportRequest?.(requestId)
}

/** P3 (D36): the socket is back; the shell reports its live runs, on an enabled node only. */
export function forwardNodeReconnected(): void {
  if (!nodeCredentialForHello()) return
  getDesktopBridge()?.nodeReconnected?.()
}

/**
 * The socket's reconnect edge for the node (D36): every transition into
 * `connected` after the first one. Feed it each status; it forwards the edge.
 */
export function nodeReconnectEdge(forward: () => void = forwardNodeReconnected) {
  let connectedOnce = false
  let previous: string | null = null
  return (status: string): void => {
    const was = previous
    previous = status
    if (status !== "connected" || was === "connected") return
    if (connectedOnce) forward()
    connectedOnce = true
  }
}
