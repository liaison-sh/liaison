// SPDX-License-Identifier: FSL-1.1-ALv2
// The block menu under the caret while `/` is typed in a page (on SuggestList).
import {
  AtSign,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Lightbulb,
  List,
  ListOrdered,
  ListTodo,
  type LucideProps,
  Minus,
  Paperclip,
  Pilcrow,
  Quote,
  SquareCode,
  Table,
} from "lucide-solid"
import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SuggestList } from "./SuggestList"
import type { SlashBlock, SlashKey } from "./slash"
import type { SuggestAnchor } from "./suggest"

const ICONS: Record<SlashKey, (props: LucideProps) => JSX.Element> = {
  text: Pilcrow,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  taskList: ListTodo,
  bulletList: List,
  orderedList: ListOrdered,
  quote: Quote,
  callout: Lightbulb,
  codeBlock: SquareCode,
  table: Table,
  divider: Minus,
  image: Image,
  file: Paperclip,
  linkToPage: AtSign,
}

export interface SlashSuggestProps {
  /** The listbox's id (the text field's aria-controls). */
  id: string
  items: SlashBlock[]
  active: number
  anchor: SuggestAnchor
  onPick: (item: SlashBlock) => void
}

export function SlashSuggest(props: SlashSuggestProps) {
  const i18n = useI18n()
  return (
    <SuggestList
      id={props.id}
      testid="slash-suggest"
      itemTestid="slash-suggest-item"
      label={i18n.t("kernel.editor.blocks")}
      heading={i18n.t("kernel.editor.addBlock")}
      items={props.items}
      active={props.active}
      anchor={props.anchor}
      width={260}
      rows={9}
      touchRows
      onPick={props.onPick}
      option={(item) => (
        <>
          <Dynamic component={ICONS[item.key]} size={14} class="shrink-0 text-text-tertiary" />
          <span class="truncate" data-block={item.key}>
            {i18n.t(`kernel.editor.${item.key}`)}
          </span>
          <span
            aria-hidden="true"
            class="ml-auto shrink-0 pl-2 font-mono text-[12px] text-text-tertiary"
          >
            {item.hint}
          </span>
        </>
      )}
    />
  )
}
