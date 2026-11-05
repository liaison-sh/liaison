// SPDX-License-Identifier: FSL-1.1-ALv2
// The emoji list under the caret while a `:shortcode` is typed. It never
// takes focus: the editor keeps the caret and routes the keys here.
import type { EmojiSuggestion } from "@liaison/shared"
import { For } from "solid-js"
import { Portal } from "solid-js/web"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"

export interface EmojiSuggestProps {
  items: EmojiSuggestion[]
  active: number
  /** Viewport position of the caret: the list opens under it, or above near the bottom. */
  anchor: { left: number; top: number; bottom: number }
  onPick: (item: EmojiSuggestion) => void
}

const LIST_HEIGHT_PX = 8 * 32 + 8
const WIDTH_PX = 240

export function EmojiSuggest(props: EmojiSuggestProps) {
  const i18n = useI18n()
  const style = () => {
    const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - WIDTH_PX - 8))
    const above = props.anchor.bottom + LIST_HEIGHT_PX > window.innerHeight
    return above
      ? { left: `${left}px`, bottom: `${window.innerHeight - props.anchor.top + 4}px` }
      : { left: `${left}px`, top: `${props.anchor.bottom + 4}px` }
  }
  return (
    <Portal>
      <div
        data-testid="emoji-suggest"
        role="listbox"
        aria-label={i18n.t("kernel.editor.emojiSuggestions")}
        class="fixed z-50 w-[240px] rounded-lg border border-border bg-bg py-1 shadow-xl"
        style={style()}
        // Keep the caret in the text: a click must not blur the editor.
        onMouseDown={(e) => e.preventDefault()}
      >
        <For each={props.items}>
          {(item, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i() === props.active}
              data-testid="emoji-suggest-item"
              class={cn(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]",
                i() === props.active
                  ? "bg-surface-hover text-text"
                  : "text-text-secondary hover:bg-surface-hover/50",
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                props.onPick(item)
              }}
            >
              <span class="text-[16px] leading-none">{item.emoji}</span>
              <span class="truncate">:{item.name}:</span>
            </button>
          )}
        </For>
      </div>
    </Portal>
  )
}
