// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The outside-text globe's pulse: an action of the agent just parked for approval BECAUSE the
// conversation read outside text (the approval's `heldForOutsideText`, set from the
// `taint_escalation` reason). Every globe of that conversation (the Chats header, the dock window)
// reads the same counter, so both pulse together. A counter rather than a flag: two parks in a
// row pulse twice.
import type { ApprovalRequestSummary } from "@liaison/shared"
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

const [pulses, setPulses] = createSignal<Record<string, number>>({})

/** How many times this conversation's globe has been asked to pulse (0 = never). */
export function outsideTextPulseCount(threadId: string): number {
  return pulses()[threadId] ?? 0
}

export function pulseOutsideText(threadId: string): void {
  setPulses((p) => ({ ...p, [threadId]: (p[threadId] ?? 0) + 1 }))
}

/** A new approval request from the socket: pulse its conversation's globe when it waits because
 *  of outside text. */
export function handleOutsideTextApprovalCreate(
  data: Pick<ApprovalRequestSummary, "heldForOutsideText" | "originatingThreadId"> | null,
): void {
  if (data?.heldForOutsideText === true && data.originatingThreadId) {
    pulseOutsideText(data.originatingThreadId)
  }
}

onSessionTeardown(() => setPulses({}))
