// SPDX-License-Identifier: FSL-1.1-ALv2
import { MessageSquare } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { conversationKind, resolvedParticipants } from "~/modules/threads/conversation-display"
import { threadForTab } from "~/modules/threads/thread-tab-names"
import { Avatar } from "~/ui/AvatarStack"

/**
 * A conversation tab's mark: the face of the person or agent on the other side
 * of a DM, the same seat the chat list's row shows; a channel, or a
 * conversation not loaded yet, keeps the message glyph.
 */
export const ThreadTabIcon: Component<{ entityId: string; size: number }> = (props) => {
  const counterpart = () => {
    const thread = threadForTab(props.entityId)
    if (!thread) return null
    const viewerId = userFromToken()?.userId ?? ""
    if (conversationKind(thread, viewerId).group === "channel") return null
    const seats = resolvedParticipants(thread)
    return seats.find((p) => p.id !== viewerId) ?? seats[0] ?? null
  }
  return (
    <Show when={counterpart()} fallback={<MessageSquare size={props.size} />}>
      {(seat) => (
        <span data-testid="tab-avatar" data-participant-id={seat().id}>
          <Avatar
            user={{
              id: seat().id,
              name: seat().name,
              avatarUrl: seat().avatarUrl,
              participantType: seat().participantType,
            }}
            pixelSize={props.size + 2}
          />
        </span>
      )}
    </Show>
  )
}
