// SPDX-License-Identifier: FSL-1.1-ALv2

import { Smile } from "lucide-solid"
import { type Component, createSignal, For } from "solid-js"
import { cn } from "~/lib/cn"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { FloatingPanel } from "~/ui/FloatingPanel"

// A compact, curated palette for dropping an emoji into a message. Kept small
// on purpose — this is a quick-insert affordance, not a full emoji keyboard.
const COMPOSE_EMOJIS = [
  "😀",
  "😄",
  "😅",
  "😂",
  "🙂",
  "😉",
  "😍",
  "😘",
  "🤔",
  "😎",
  "😢",
  "😭",
  "😱",
  "😡",
  "👍",
  "👎",
  "👏",
  "🙏",
  "🙌",
  "💪",
  "🔥",
  "🎉",
  "✨",
  "⭐",
  "❤️",
  "💯",
  "✅",
  "❌",
  "👀",
  "🚀",
  "☕",
  "🎁",
]

interface ComposeEmojiButtonProps {
  onSelect: (emoji: string) => void
  disabled?: boolean
  /** Merged over the trigger's default look (the composer row's 34px tile). */
  class?: string
  iconSize?: number
}

const ComposeEmojiButton: Component<ComposeEmojiButtonProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)

  return (
    <FloatingPanel open={open()} onOpenChange={setOpen}>
      <FloatingPanel.Trigger
        data-testid="compose-emoji"
        class={cn(
          "inline-flex items-center justify-center rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50",
          props.class,
        )}
        aria-label={i18n.t("kernel.addEmoji")}
        // Keep the editor's caret/selection when the picker is opened, so the
        // emoji lands where the user was typing.
        onMouseDown={(e) => e.preventDefault()}
        disabled={props.disabled}
      >
        <Smile size={props.iconSize ?? 16} aria-hidden="true" />
      </FloatingPanel.Trigger>
      <FloatingPanel.Content class="p-1.5">
        <div class="grid grid-cols-8 gap-0.5">
          <For each={COMPOSE_EMOJIS}>
            {(emoji) => (
              <button
                type="button"
                // preventDefault keeps focus/selection in the editor; the panel
                // closes and the emoji is inserted at the preserved caret.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  props.onSelect(emoji)
                  setOpen(false)
                }}
                class="flex h-8 w-8 items-center justify-center rounded-md text-[18px] transition-colors hover:bg-surface-hover"
                aria-label={tNow("kernel.threadsUi.insertEmoji", { emoji })}
              >
                {emoji}
              </button>
            )}
          </For>
        </div>
      </FloatingPanel.Content>
    </FloatingPanel>
  )
}

export default ComposeEmojiButton
