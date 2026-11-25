// SPDX-License-Identifier: FSL-1.1-ALv2
// The page picker under the caret while `@` or `[[` is typed in a page. Like the
// emoji list it never takes focus: the editor keeps the caret, routes the arrows,
// Enter and Escape here, and points screen readers at the active option
// (aria-activedescendant on the text field).
import { FileText } from "lucide-solid"
import { For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"

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
  anchor: { left: number; top: number; bottom: number }
  onPick: (item: PickedPage) => void
}

const ROW_PX = 32
const LIST_HEIGHT_PX = 9 * ROW_PX + 8
const WIDTH_PX = 320

export function pageOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

export function PageSuggest(props: PageSuggestProps) {
  const i18n = useI18n()
  const style = () => {
    const width = Math.min(WIDTH_PX, window.innerWidth - 16)
    const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - width - 8))
    const above = props.anchor.bottom + LIST_HEIGHT_PX > window.innerHeight
    return above
      ? {
          left: `${left}px`,
          width: `${width}px`,
          bottom: `${window.innerHeight - props.anchor.top + 4}px`,
        }
      : { left: `${left}px`, width: `${width}px`, top: `${props.anchor.bottom + 4}px` }
  }
  return (
    <Portal>
      <div
        data-testid="page-suggest"
        class="fixed z-50 max-h-[296px] overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-xl"
        style={style()}
        // Keep the caret in the text: a click must not blur the editor.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div
          aria-hidden="true"
          class="px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"
        >
          {i18n.t("kernel.editor.linkToPage")}
        </div>
        <div id={props.id} role="listbox" aria-label={i18n.t("kernel.editor.linkToPage")}>
          <For each={props.items}>
            {(item, i) => (
              <button
                type="button"
                id={pageOptionId(props.id, i())}
                role="option"
                tabIndex={-1}
                aria-selected={i() === props.active}
                data-testid="page-suggest-item"
                class={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] [@media(pointer:coarse)]:min-h-11",
                  i() === props.active
                    ? "bg-surface-hover text-text"
                    : "text-text-secondary hover:bg-surface-hover/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault()
                  props.onPick(item)
                }}
              >
                <FileText size={14} class="shrink-0 text-text-tertiary" />
                <span class="truncate">{item.title || i18n.t("kernel.editor.untitledPage")}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={props.items.length === 0}>
          <div
            data-testid="page-suggest-empty"
            role="status"
            class="px-3 py-1.5 text-[13px] text-text-tertiary"
          >
            {props.loading ? i18n.t("kernel.editor.pagesLoading") : i18n.t("kernel.editor.noPage")}
          </div>
        </Show>
      </div>
    </Portal>
  )
}
