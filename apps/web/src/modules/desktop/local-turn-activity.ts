// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T11: A LOCAL TURN IS A TURN.
//
// The overlay drew a terminal shaped pane down the side of the window for the
// tools a local session ran, which is a second place to look, a second scroll
// region and a second visual language for the exact thing the conversation
// already renders: the agent did something, here is what.
//
// So there is no pane. The shell's tool activity is mapped, here, onto the
// state the app's own tool call rows already consume, and AgentTurnBlock
// renders it with the same component, the same grouping and the same status
// dot as a turn that ran on the server. A divergence between the two is then
// a change to one row component rather than a drift between two.
//
// This module is pure: data in, data out, no store and no component. That is
// what makes the mapping testable without rendering anything.

import type { DesktopToolActivity } from "~/lib/desktop-shell-contract"
import type { ToolCallState } from "~/modules/threads/message-store"

/**
 * The sidecar's three states onto the row's four. There is no local "pending":
 * the shell reports a tool only once it is running. A status this build does
 * not recognise (a newer shell against an older page) is pending rather than
 * done, because a row that claims a tool finished when nobody said so is the
 * one wrong answer here.
 */
function rowStatus(status: DesktopToolActivity["status"]): ToolCallState["status"] {
  switch (status) {
    case "running":
      return "running"
    case "done":
      return "completed"
    case "error":
      return "error"
    default:
      return "pending"
  }
}

/**
 * The live local session's tool calls, as the conversation's own rows.
 *
 * ORDER IS THE SHELL'S. The rows are not sorted by `startedAt` here: the shell
 * reports them in the order the sidecar emitted them, which is the order they
 * happened in, and a clock skew between two tools should never reorder what a
 * person watched happen.
 */
export function toLocalToolCalls(activity: DesktopToolActivity[]): ToolCallState[] {
  return activity.map((entry) => ({
    toolCallId: entry.id,
    toolName: entry.toolName,
    // The one line the shell already computed. Never a raw input blob, and
    // never a fabricated result: a running tool has not returned anything.
    //
    // A call the MODE CHANGE allowed rather than the user says so here
    // (P6d-FX2, SK-5): switching to Bypass answers whatever is parked, and the
    // row is where that belongs, beside what the call was.
    args: entry.allowedByBypass
      ? { summary: entry.summary, allowedByBypass: true }
      : { summary: entry.summary },
    status: rowStatus(entry.status),
  }))
}
