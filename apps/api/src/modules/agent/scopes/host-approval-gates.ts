// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host rules that make an otherwise ungated agent call a gated one: it goes through the normal
// approval flow, which a person decides or an auto-approve policy the org set for the tool
// answers. These rules are the host's, never a manifest's: an app cannot exempt itself. All of
// them are off when an org admin switched the outside-content approvals off (scopes/taint.ts).
//
//   - A calendar event that invites an address nobody in the organisation has dealt with
//     (known-guests.ts), whatever the turn read: Google shows a guest the event, its title and
//     description, even when no invitation mail is sent.
//   - A write to the agent's memory (the memory verbs, user_memory_set/_delete) after the turn
//     read outside text. Memory is re-read by every later turn as the agent's own notes, so an
//     instruction planted there outlives the turn that read it; a person decides whether it is
//     kept. A clean turn writes directly: memory is the agent's working notebook.
//
// An agent's write to a Knowledge document after reading outside text is NOT gated: a Knowledge
// write from such a turn lands in the review queue unverified instead (bridge/knowledge.ts).

import { unknownInvitedGuests } from "~/modules/agent/scopes/known-guests"
import { SINK_KERNEL_AGENT_MEMORY } from "~/modules/agent/scopes/scope-taint"
import { getWebContentProtection, untrustedTurnNeedsApproval } from "~/modules/agent/scopes/taint"

const CALENDAR_GUEST_WRITES: ReadonlySet<string> = new Set([
  "calendar:create_event",
  "calendar:update_event",
])

export function hostGatesUnknownGuests(toolName: string): boolean {
  return CALENDAR_GUEST_WRITES.has(toolName)
}

/** Does this agent call need an approval under a host rule? (See the top of this file.) */
export async function hostRequiresApproval(a: {
  toolName: string
  params: unknown
  orgId: string
  threadId?: string | null
  /** The tool's declared write target (`writesToTable`). */
  writesToTable?: string
}): Promise<boolean> {
  if (a.writesToTable === SINK_KERNEL_AGENT_MEMORY) {
    // No thread, no turn to judge: a call outside a conversation is not an agent turn's write.
    return a.threadId ? untrustedTurnNeedsApproval(a.threadId, a.orgId) : false
  }
  if (hostGatesUnknownGuests(a.toolName)) {
    if ((await getWebContentProtection(a.orgId)) === "off") return false
    const unknown = await unknownInvitedGuests(a.toolName, a.params, a.orgId)
    // A malformed guest list (null) cannot be checked: a person decides.
    return unknown === null || unknown.length > 0
  }
  return false
}
