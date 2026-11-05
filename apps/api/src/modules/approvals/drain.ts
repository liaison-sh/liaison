// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approval-execution drain: stop deploys from wedging approvals.
//
// THE MECHANISM THIS KILLS. `executeApprovedStep` (cascade.ts) claims
// `pending -> approving` in one committed transaction, THEN runs the handler
// outside any transaction, THEN terminalizes to `approved`. Everything between
// the claim and the terminalize is a window in which killing the process leaves
// the row stuck at `approving` forever: the reaper cannot tell whether the side
// effect landed (no protocol row, or one stuck at `started`), so by design it
// parks the row for a human instead of guessing.
//
// `deploy-liaison.sh` force-recreates the active container. Docker sends
// SIGTERM and, with no handler and no `stop_grace_period`, SIGKILLs 10s later.
// Any approval mid-handler at that moment wedges. This is not hypothetical: 8
// rows wedged across the 2026-07-16 / 07-20 / 07-22 deploys and sat unresolved
// for 12-19 days -- a role grant, a bought-but-unrecorded shipping label, five
// HS-code updates, one task. Every deploy rolls the dice again.
//
// THE FIX, in two halves:
//
//   1. NEVER OPEN A NEW WINDOW WHILE SHUTTING DOWN. On SIGTERM we set the
//      draining flag. `executeApprovedStep` checks it BEFORE the claim and
//      refuses -- the row stays `pending`, fully decidable, and the human just
//      retries. Refusing before the claim is the whole point: a refusal after
//      it would itself be a wedge.
//   2. FINISH THE WINDOWS ALREADY OPEN. Shutdown waits for every in-flight
//      execution to reach its terminal state before exiting, bounded so a
//      genuinely hung handler cannot block a deploy forever.
//
// The registry is per-process and in-memory ON PURPOSE. It guards THIS
// process's shutdown, and only this process can finish the handlers it started.
// A second app node draining is a separate, independent concern.

import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "approval-drain" })

/** Approval ids whose claim->handler->terminalize window is currently open. */
const inFlight = new Set<string>()

let draining = false

/** True once shutdown has begun; new approval executions are refused. */
export function isDraining(): boolean {
  return draining
}

/**
 * Refuse new approval executions from here on. Idempotent, and deliberately
 * NOT reversible: a process that has begun shutting down never goes back to
 * serving, and a resettable flag would be a foot-gun in tests that leaked it.
 * Tests use `ApprovalDrainTestAccess.reset`.
 */
export function beginDraining(): void {
  draining = true
}

/** Open the critical section for `approvalId`. */
export function enterApprovalExecution(approvalId: string): void {
  inFlight.add(approvalId)
}

/** Close it. Safe to call for an id that was never entered. */
export function leaveApprovalExecution(approvalId: string): void {
  inFlight.delete(approvalId)
}

/** Approval ids currently mid-execution in THIS process. */
export function inFlightApprovalIds(): string[] {
  return [...inFlight]
}

export interface DrainResult {
  drained: boolean
  /** Ids still mid-execution when the wait gave up (empty when drained). */
  remaining: string[]
  waitedMs: number
}

/**
 * Wait until no approval execution is in flight, or `timeoutMs` elapses.
 *
 * Returns rather than throws on timeout: the caller is a shutdown path, and a
 * hung handler must not prevent the process from exiting (Docker would SIGKILL
 * it anyway). The remaining ids are returned so the caller can log exactly
 * which approvals are about to be orphaned -- that log line is the operator's
 * only breadcrumb if a wedge does happen.
 */
export async function waitForApprovalDrain(timeoutMs: number, pollMs = 100): Promise<DrainResult> {
  const started = Date.now()
  while (inFlight.size > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return {
    drained: inFlight.size === 0,
    remaining: [...inFlight],
    waitedMs: Date.now() - started,
  }
}

/**
 * Full shutdown drain: refuse new executions, then let the open ones finish.
 * Exported as one call so every shutdown path (SIGTERM, SIGINT, a test) gets
 * the same ordering -- flag first, THEN wait. Waiting before flagging would
 * race a fresh claim into the window we just measured as empty.
 */
export async function drainApprovalsForShutdown(timeoutMs: number): Promise<DrainResult> {
  beginDraining()
  const openCount = inFlight.size
  if (openCount > 0) {
    log.info({ inFlight: [...inFlight] }, "draining: waiting for in-flight approval executions")
  }
  const result = await waitForApprovalDrain(timeoutMs)
  if (result.drained) {
    if (openCount > 0) {
      log.info({ waitedMs: result.waitedMs, count: openCount }, "draining: approvals drained")
    }
  } else {
    // ERROR level: the watchdog watches >= 50, and this is the exact condition
    // that produces a wedged approval a human then has to reconcile by hand.
    log.error(
      { remaining: result.remaining, waitedMs: result.waitedMs },
      "draining: TIMED OUT with approval executions still in flight -- these may wedge at 'approving' and need operator review",
    )
  }
  return result
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ApprovalDrainTestAccess = {
  /** Test-only: clear the flag + registry between cases. */
  reset(): void {
    draining = false
    inFlight.clear()
  },
}
