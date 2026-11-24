// SPDX-License-Identifier: FSL-1.1-ALv2
// The page picker under the caret while `@` or `[[` is typed in a page (on SuggestList).
import { FileText } from "lucide-solid"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SuggestList } from "./SuggestList"
import { type SuggestAnchor, suggestOptionId } from "./suggest"

/** A page the writer may link to. */
export interface PickedPage {
  id: string
  title: string
}

export interface PageSuggestProps {
  /** The listbox's id (the text field's aria-controls). */
  id: string
  items: PickedPage[]
  active: number
  /** Still asking the server, nothing to show yet. */
  loading: boolean
  anchor: SuggestAnchor
  onPick: (item: PickedPage) => void
}

export const pageOptionId = suggestOptionId

export function PageSuggest(props: PageSuggestProps) {
  const i18n = useI18n()
  return (
    <SuggestList
      id={props.id}
      testid="page-suggest"
      itemTestid="page-suggest-item"
      label={i18n.t("kernel.editor.linkToPage")}
      heading={i18n.t("kernel.editor.linkToPage")}
      items={props.items}
      active={props.active}
      anchor={props.anchor}
      width={320}
      rows={9}
      touchRows
      onPick={props.onPick}
      option={(item) => (
        <>
          <FileText size={14} class="shrink-0 text-text-tertiary" />
          <span class="truncate">{item.title || i18n.t("kernel.editor.untitledPage")}</span>
        </>
      )}
      empty={
        <div
          data-testid="page-suggest-empty"
          role="status"
          class="px-3 py-1.5 text-[13px] text-text-tertiary"
        >
          {props.loading ? i18n.t("kernel.editor.pagesLoading") : i18n.t("kernel.editor.noPage")}
        </div>
      }
    />
  )
}
