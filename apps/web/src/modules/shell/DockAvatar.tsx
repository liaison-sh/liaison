// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a dock conversation is with, at a glance: the bar item's 20px mark and
// the window header's 34px one. Same classification the Home sidebar's row
// mark uses (conversation-display.ts): a channel is its hash (or lock), a DM
// with an agent is the agent mark, a DM with people is the other person's
// photo or initials (the shared `Avatar`).
//
// The dot on it says what is live, and only what the client actually knows:
// green when a person in the conversation is online (presence-store), the
// warning colour pulsing while the agent of an agent DM is taking a turn (the
// same typing and stream signals AgentStateLabel reads).
import { Hash, Lock } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import {
  conversationKind,
  namingAgentSeat,
  resolvedParticipants,
} from "~/modules/threads/conversation-display"
import { getChannelAgentStream } from "~/modules/threads/message-store"
import { presenceStore } from "~/modules/threads/presence-store"
import { agentTypingInThread } from "~/modules/threads/thread-store"
import { threadForDock } from "~/modules/threads/thread-tab-names"
import { Avatar } from "~/ui/AvatarStack"

export type DockPresence = "online" | "working" | null

/** The dot a dock conversation wears: a person online, an agent at work, or
 *  nothing. Exported for the window header's status line. */
export function dockPresence(threadId: string): DockPresence {
  const thread = threadForDock(threadId)
  if (!thread) return null
  const me = userFromToken()?.userId ?? ""
  const kind = conversationKind(thread, me)
  if (kind.group === "dm" && namingAgentSeat(thread, me)) {
    const streaming = getChannelAgentStream(threadId).state === "streaming"
    return streaming || agentTypingInThread(threadId) ? "working" : null
  }
  if (kind.group === "channel") return null
  return thread.participants.some((p) => p.id !== me && presenceStore.users[p.id] === "online")
    ? "online"
    : null
}

interface DockAvatarProps {
  threadId: string
  /** Diameter in px: 20 on the bar, 34 in the window header. */
  size: number
}

export const DockAvatar: Component<DockAvatarProps> = (props) => {
  const me = () => userFromToken()?.userId ?? ""
  const thread = () => threadForDock(props.threadId)
  const kind = () => {
    const t = thread()
    return t ? conversationKind(t, me()) : null
  }
  const agent = () => {
    const t = thread()
    return t ? namingAgentSeat(t, me()) : null
  }
  const person = () => {
    const t = thread()
    if (!t) return null
    const seats = resolvedParticipants(t)
    return seats.find((p) => p.id !== me()) ?? seats[0] ?? null
  }
  const presence = () => dockPresence(props.threadId)
  const dot = () => (props.size >= 30 ? 10 : 8)
  const glyph = () => Math.round(props.size * 0.55)

  return (
    <span
      data-testid="dock-avatar"
      data-presence={presence() ?? "none"}
      class="relative flex shrink-0 items-center justify-center"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
    >
      <Show
        when={kind()?.group !== "channel"}
        fallback={
          <span class="flex h-full w-full items-center justify-center rounded-full bg-surface-hover text-text-secondary">
            <Show
              when={(() => {
                const k = kind()
                return k?.group === "channel" && k.visibility === "private"
              })()}
              fallback={<Hash size={glyph()} aria-hidden="true" />}
            >
              <Lock size={glyph()} aria-hidden="true" />
            </Show>
          </span>
        }
      >
        <Show
          when={agent() ?? person()}
          fallback={<span class="h-full w-full rounded-full bg-surface-hover" />}
        >
          {(seat) => (
            <Avatar
              user={{
                id: seat().id,
                name: seat().name,
                avatarUrl: seat().avatarUrl ?? null,
                participantType: agent() ? "agent" : seat().participantType,
              }}
              pixelSize={props.size}
            />
          )}
        </Show>
      </Show>
      <Show when={presence()}>
        {(state) => (
          <span
            data-testid="dock-presence-dot"
            data-state={state()}
            class={`absolute -right-px -bottom-px rounded-full border-elevated ${
              state() === "working" ? "animate-pulse bg-warning" : "bg-success"
            }`}
            style={{
              width: `${dot()}px`,
              height: `${dot()}px`,
              "border-width": props.size >= 30 ? "2px" : "1.5px",
              "border-style": "solid",
            }}
          />
        )}
      </Show>
    </span>
  )
}
