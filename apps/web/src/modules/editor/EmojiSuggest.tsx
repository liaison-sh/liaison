// SPDX-License-Identifier: FSL-1.1-ALv2
// The emoji list under the caret while a `:shortcode` is typed (on SuggestList).
import type { EmojiSuggestion } from "@liaison/shared"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SuggestList } from "./SuggestList"
import type { SuggestAnchor } from "./suggest"

export interface EmojiSuggestProps {
  /** The listbox's id (the text field's aria-controls). */
  id?: string
  items: EmojiSuggestion[]
  active: number
  /** Viewport position of the caret: the list opens under it, or above near the bottom. */
  anchor: SuggestAnchor
  onPick: (item: EmojiSuggestion) => void
}

export function EmojiSuggest(props: EmojiSuggestProps) {
  const i18n = useI18n()
  return (
    <SuggestList
      id={props.id}
      testid="emoji-suggest"
      itemTestid="emoji-suggest-item"
      label={i18n.t("kernel.editor.emojiSuggestions")}
      items={props.items}
      active={props.active}
      anchor={props.anchor}
      width={240}
      rows={8}
      onPick={props.onPick}
      option={(item) => (
        <>
          <span class="text-[16px] leading-none">{item.emoji}</span>
          <span class="truncate">:{item.name}:</span>
        </>
      )}
    />
  )
}
