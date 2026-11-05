// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Did an agent turn ask to read personal mail while the mailbox was locked?
// The mailbox broker answers such a read with `mailbox.status: MAILBOX_LOCKED`,
// and the persisted (redacted) tool result keeps that status and nothing else.
// The chat puts an Unlock button under the turn when it sees it, so the owner
// unlocks right there instead of hunting for the mail view.

interface ToolCallLike {
  result?: unknown
}

export const MAILBOX_LOCKED_STATUS = "MAILBOX_LOCKED"

export function turnHitLockedMailbox(toolCalls: readonly ToolCallLike[] | undefined): boolean {
  return (toolCalls ?? []).some((call) => {
    const result = call.result
    if (!result || typeof result !== "object") return false
    const status = (result as { mailbox?: { status?: unknown } }).mailbox?.status
    return status === MAILBOX_LOCKED_STATUS
  })
}
