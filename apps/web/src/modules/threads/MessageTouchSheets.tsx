// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A MOUSE REACHES BY HOVERING, A FINGER REACHES BY TAPPING.
//
// On a message, the action toolbar (reply in thread, react, edit, delete) and
// the "who reacted" hint only ever appear on hover, and a touch screen has no
// hover: on a phone none of them could be reached. The same actions live in
// two bottom sheets a tap or a long press opens, the shape the chat list
// already uses for its own long-press actions:
//
// - tapping or holding a message opens its action sheet, which also carries
//   the two things a finger cannot do by selecting text: quote it and copy it;
// - tapping or holding a reaction chip opens the reactions card: who reacted
//   with what, the viewer's own reactions removable, and a way to add one. A
//   tap on a chip never toggles a reaction by itself (a mouse click still does).

import { X } from "lucide-solid"
import { type Component, createSignal, For, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { favoriteEmoji } from "~/modules/threads/favorite-emoji"
import { ReactionPickerBody } from "~/modules/threads/ReactionPicker"
import { OverlaySheet } from "~/ui/OverlaySheet"

export interface MessageSheetAction {
  id: string
  label: string
  icon: JSX.Element
  tone?: "danger"
  onSelect: () => void
}

const rowClass =
  "flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-[15px] hover:bg-surface-hover"

export const MessageActionSheet: Component<{
  open: boolean
  onClose: () => void
  messageId: string
  actions: MessageSheetAction[]
  /** Present on rows that take reactions: draws the favourites strip and the
   *  way into the full picker. */
  onReact?: (emoji: string) => void
}> = (props) => {
  const i18n = useI18n()
  // The full picker replaces the actions in the same sheet rather than
  // stacking a second layer over it.
  const [picking, setPicking] = createSignal(false)
  const close = () => {
    setPicking(false)
    props.onClose()
  }
  const react = (emoji: string) => {
    props.onReact?.(emoji)
    close()
  }
  const run = (action: MessageSheetAction) => {
    close()
    action.onSelect()
  }

  return (
    <OverlaySheet
      open={props.open}
      onClose={close}
      variant="bottom"
      title={picking() ? i18n.t("kernel.addReaction") : i18n.t("kernel.messageActions")}
      closeLabel={i18n.t("kernel.close")}
    >
      <div data-testid={`message-sheet-${props.messageId}`} class="flex flex-col pb-2">
        <Show
          when={!picking()}
          fallback={
            <div data-testid="message-sheet-picker" class="p-2">
              <ReactionPickerBody onReact={react} />
            </div>
          }
        >
          <Show when={props.onReact}>
            <div
              data-testid="message-sheet-reactions"
              class="flex items-center gap-1 overflow-x-auto border-b border-border-subtle px-3 py-2"
            >
              <For each={favoriteEmoji()}>
                {(emoji) => (
                  <button
                    type="button"
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[22px] hover:bg-surface-hover"
                    aria-label={i18n.t("kernel.threadsUi.reactWith", { emoji })}
                    onClick={() => react(emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
              <button
                type="button"
                data-testid="message-sheet-more-emoji"
                class="flex h-11 shrink-0 items-center justify-center rounded-full px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-hover"
                onClick={() => setPicking(true)}
              >
                {i18n.t("kernel.threadsUi.moreEmoji")}
              </button>
            </div>
          </Show>
          <For each={props.actions}>
            {(action) => (
              <button
                type="button"
                data-testid={`message-sheet-${action.id}`}
                class={`${rowClass} ${action.tone === "danger" ? "text-danger" : "text-text"}`}
                onClick={() => run(action)}
              >
                <span
                  class={`shrink-0 ${action.tone === "danger" ? "text-danger" : "text-text-secondary"}`}
                >
                  {action.icon}
                </span>
                {action.label}
              </button>
            )}
          </For>
        </Show>
      </div>
    </OverlaySheet>
  )
}

/** A name list the way the hover hint reads: the viewer first as You, then
 *  everyone else, and a count of the ones the server did not name. */
function reactorNames(
  reaction: MessageReactionSummary,
  currentUserId: string,
  you: string,
): { names: string[]; rest: number } {
  const names = [
    ...(reaction.users.some((u) => u.id === currentUserId) ? [you] : []),
    ...reaction.users.filter((u) => u.id !== currentUserId).map((u) => u.name),
  ]
  return { names, rest: Math.max(0, reaction.count - names.length) }
}

export interface MessageReactionSummary {
  emoji: string
  count: number
  reacted: boolean
  users: ReadonlyArray<{ id: string; name: string }>
}

/**
 * The reactions card a finger opens by tapping (or holding) a reaction chip:
 * every reaction on the message with who reacted, the viewer's own marked and
 * removable, and a way to add one. A tap on a chip never toggles anything: it
 * used to, and a tap on someone else's reaction added the viewer's own.
 *
 * Only the viewer's reaction carries a remove button. Nothing on another
 * person's reaction suggests it can be taken away, because it cannot.
 */
export const ReactionsCard: Component<{
  open: boolean
  onClose: () => void
  messageId: string
  reactions: ReadonlyArray<MessageReactionSummary>
  currentUserId: string
  /** The chip that opened the card, drawn highlighted. */
  focusEmoji?: string | null
  onReact: (emoji: string) => void
  onRemove: (emoji: string) => void
}> = (props) => {
  const i18n = useI18n()
  const [picking, setPicking] = createSignal(false)
  const close = () => {
    setPicking(false)
    props.onClose()
  }
  // Adding closes the card, as reacting from the message sheet does: one tap,
  // one reaction, and nothing left under the finger to tap twice.
  const react = (emoji: string) => {
    props.onReact(emoji)
    close()
  }
  const alreadyMine = (emoji: string) => props.reactions.some((r) => r.emoji === emoji && r.reacted)

  return (
    <OverlaySheet
      open={props.open}
      onClose={close}
      variant="bottom"
      title={picking() ? i18n.t("kernel.addReaction") : i18n.t("kernel.threadsUi.reactionsTitle")}
      closeLabel={i18n.t("kernel.close")}
    >
      <div data-testid={`reactions-card-${props.messageId}`} class="flex flex-col pb-2">
        <Show
          when={!picking()}
          fallback={
            <div data-testid="reactions-card-picker" class="p-2">
              <ReactionPickerBody onReact={react} />
            </div>
          }
        >
          <ul class="flex flex-col">
            <For each={props.reactions}>
              {(reaction) => {
                const who = () =>
                  reactorNames(
                    reaction,
                    props.currentUserId,
                    i18n.t("kernel.threadsUi.reactorsYou"),
                  )
                return (
                  <li
                    data-testid={`reactions-card-group-${reaction.emoji}`}
                    data-mine={reaction.reacted ? "true" : undefined}
                    aria-label={i18n.t("kernel.threadsUi.reactedWith", { emoji: reaction.emoji })}
                    class={`flex items-start gap-3 border-b border-border-subtle px-4 py-3 ${
                      props.focusEmoji === reaction.emoji ? "bg-surface-hover/60" : ""
                    }`}
                  >
                    <span
                      class={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-full border px-2 text-[20px] ${
                        reaction.reacted
                          ? "border-accent/40 bg-accent/10"
                          : "border-border-subtle bg-surface"
                      }`}
                    >
                      {reaction.emoji}
                      <span class="text-[12px] font-medium text-text-secondary">
                        {reaction.count}
                      </span>
                    </span>
                    <div class="min-w-0 flex-1 pt-0.5 text-[15px] leading-snug text-text">
                      <For each={who().names}>
                        {(name, index) => (
                          <span
                            class={
                              reaction.reacted && index() === 0 ? "font-semibold text-accent" : ""
                            }
                          >
                            {index() > 0 ? ", " : ""}
                            {name}
                          </span>
                        )}
                      </For>
                      <Show when={who().rest > 0}>
                        <span class="text-text-tertiary">
                          {" "}
                          {who().rest === 1
                            ? i18n.t("kernel.threadsUi.reactorsMoreOne")
                            : i18n.t("kernel.threadsUi.reactorsMoreMany", { count: who().rest })}
                        </span>
                      </Show>
                    </div>
                    <Show when={reaction.reacted}>
                      <button
                        type="button"
                        data-testid={`reactions-card-remove-${reaction.emoji}`}
                        aria-label={i18n.t("kernel.threadsUi.removeYourReaction", {
                          emoji: reaction.emoji,
                        })}
                        class="flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-danger hover:bg-surface-hover"
                        onClick={() => props.onRemove(reaction.emoji)}
                      >
                        <X size={14} />
                        {i18n.t("kernel.threadsUi.removeMine")}
                      </button>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
          <div
            data-testid="reactions-card-add"
            class="flex items-center gap-1 overflow-x-auto px-3 py-2"
          >
            <For each={favoriteEmoji()}>
              {(emoji) => (
                <button
                  type="button"
                  disabled={alreadyMine(emoji)}
                  class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[22px] hover:bg-surface-hover disabled:opacity-40"
                  aria-label={i18n.t("kernel.threadsUi.reactWith", { emoji })}
                  onClick={() => react(emoji)}
                >
                  {emoji}
                </button>
              )}
            </For>
            <button
              type="button"
              data-testid="reactions-card-more-emoji"
              class="flex h-11 shrink-0 items-center justify-center rounded-full px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-hover"
              onClick={() => setPicking(true)}
            >
              {i18n.t("kernel.threadsUi.moreEmoji")}
            </button>
          </div>
        </Show>
      </div>
    </OverlaySheet>
  )
}
