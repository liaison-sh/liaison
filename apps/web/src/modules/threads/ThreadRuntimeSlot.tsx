// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T19: WHERE THIS CONVERSATION'S TURNS RUN, asked once for every surface
// that holds a conversation.
//
// The thread header asked it (P6d-T07) and the dock tab now holds the same
// conversation in the same app, so it has to ask it too. Two copies of the
// predicate is how the header and the sidebar classifier drifted apart once
// already (P6d-FX7, SK-8), so the predicate lives here, in one place, and both
// hosts mount this slot instead of restating it.
//
// It renders NOTHING when this conversation is not a DM with exactly one
// agent, and nothing at all in a browser (RuntimeControl's own gate), so a
// host that mounts it unconditionally is byte identical to one that never had
// it until both conditions hold.

import { type Component, Show } from "solid-js"
import RuntimeControl from "~/modules/desktop/RuntimeControl"
import { dmAgentSeat, type RuntimeSlotParticipant } from "~/modules/threads/dm-agent-seat"

export { dmAgentSeat, type RuntimeSlotParticipant }

export interface ThreadRuntimeSlotProps {
  threadId: string
  title: string | null
  /** `kernel.threads.type`, so a titled channel never offers "This machine". */
  threadType?: string
  currentUserId: string
  participants: RuntimeSlotParticipant[]
  /** Icon only, for a header too narrow to spend words on this (the dock tab). */
  compact?: boolean
}

/**
 * The runtime control for one conversation, on the surface that holds it. The
 * thread id it passes is the HOST'S OWN thread id: a local session claims a
 * (thread, agent) pair (A32), so a dock tab starts a session bound to the
 * conversation in that tab and not to whatever Home has open behind it.
 */
const ThreadRuntimeSlot: Component<ThreadRuntimeSlotProps> = (props) => (
  <Show
    when={dmAgentSeat({
      threadId: props.threadId,
      title: props.title,
      threadType: props.threadType,
      currentUserId: props.currentUserId,
      participants: props.participants,
    })}
  >
    {(agent) => (
      <RuntimeControl
        agentId={agent().id}
        agentName={agent().name}
        threadId={props.threadId}
        compact={props.compact}
      />
    )}
  </Show>
)

export default ThreadRuntimeSlot
