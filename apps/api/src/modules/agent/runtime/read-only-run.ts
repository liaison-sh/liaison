// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A READ-ONLY RUN: a turn that may read whatever its scope allows and write
// nothing. The "Share anyway" rerun (spec-security.md D4) is the only one today.
//
// D4 says the disclosure "re-runs the turn". Re-executing that turn's tool calls
// repeats every side effect it had: a withheld turn that sent mail, opened a
// ticket or posted to a supplier would do it a SECOND time, silently, because
// the requester asked to SEE the answer they were denied. Nothing in the turn
// records which calls were effectful, so there is no safe way to replay some and
// not others. A duplicate side effect is worse than a narrower rerun, so the
// rerun answers from reads alone, and a write it attempts is refused rather than
// performed.
//
// What counts as a write is the T29/X3 marker, read exactly the way scope taint
// reads it (modules/agent/scopes/scope-taint.ts):
//   - a declared `writesToTable` is a write, whatever else the tool says;
//   - an explicit `readOnly` is a read;
//   - a tool declaring NEITHER is a write to an unknown table.
// The last rule is what makes this fail closed: an unmarked tool is never
// admitted to a rerun, so a newly added tool cannot quietly become replayable by
// forgetting its marker.

import {
  type ToolTaintDeclaration,
  UNDECLARED_WRITE_TARGET,
} from "~/modules/agent/scopes/scope-taint"

/**
 * What a tool call refused by a read-only run returns in place of the tool's
 * normal result. Mirrors `ScopeTaintBlockedError` in shape so the bridge, the
 * model and the UI treat a refused write identically however it was refused.
 */
export const READ_ONLY_RUN_BLOCKED_CODE = "E_READ_ONLY_RUN_BLOCKED"

export type ReadOnlyRunBlockedError = {
  ok: false
  code: "E_READ_ONLY_RUN_BLOCKED"
  writeTargetTable: string
  reason: "read_only_run_blocked"
  /** What the model must tell the user: the refusal rides on the result, where it is read. */
  message: string
}

export function toReadOnlyRunBlockedError(writeTargetTable: string): ReadOnlyRunBlockedError {
  return {
    ok: false,
    code: "E_READ_ONLY_RUN_BLOCKED",
    writeTargetTable,
    reason: "read_only_run_blocked",
    message: `NOT EXECUTED: this run may only read, so it may not write to ${writeTargetTable}. Nothing was sent, created or changed. Report the write as blocked, never as done, and finish with the answer you can give from reads.`,
  }
}

/**
 * The same refusal for a write boundary that reports failure by THROWING: the
 * sandbox bridge's write RPCs, whose sandbox contract is an error envelope built
 * from `.code`. The code is the one above, so a refused write reads identically
 * however it was refused, and `retryable: false` stops the caller re-issuing it.
 *
 * A boundary refuses because of what the RUN is, never because of what the tool
 * claims to be: the `readOnly` marker is supplied by the app's own manifest, so
 * a manifest that lies about a write tool must not be able to buy itself a write.
 */
export function readOnlyRunBlockedError(
  writeTargetTable: string,
  what = "this call",
): Error & { code: string; writeTargetTable: string; retryable: boolean } {
  const err = new Error(
    `${READ_ONLY_RUN_BLOCKED_CODE}: ${what} would write (${writeTargetTable}) and this run may only read`,
  ) as Error & { code: string; writeTargetTable: string; retryable: boolean }
  err.code = READ_ONLY_RUN_BLOCKED_CODE
  err.writeTargetTable = writeTargetTable
  err.retryable = false
  return err
}

/**
 * The write-boundary guard. `readOnlyRun` is the RUN's own mark, read from the
 * run frame or from the frame captured before a hop that loses it (the sandbox
 * bridge), never from a tool's `readOnly` declaration.
 */
export function assertWritableRun(
  readOnlyRun: boolean,
  writeTargetTable: string,
  what?: string,
): void {
  if (readOnlyRun) throw readOnlyRunBlockedError(writeTargetTable, what)
}

/**
 * May this tool run in a read-only run? Only a tool that positively declares
 * itself `readOnly` and declares no write target. An undeclared tool is a write.
 */
export function isReadOnlyTool(toolDef: ToolTaintDeclaration): boolean {
  if (typeof toolDef.writesToTable === "string") return false
  return toolDef.readOnly === true
}

/**
 * The read-only-run decision for one tool call. Returns null when the call may
 * run, else the error to return in place of the tool's result. The caller only
 * consults this on a run whose frame is marked read-only.
 */
export function checkReadOnlyRun(toolDef: ToolTaintDeclaration): ReadOnlyRunBlockedError | null {
  if (isReadOnlyTool(toolDef)) return null
  return toReadOnlyRunBlockedError(toolDef.writesToTable ?? UNDECLARED_WRITE_TARGET)
}
