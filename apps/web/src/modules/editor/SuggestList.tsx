// SPDX-License-Identifier: FSL-1.1-ALv2
// The list under the caret (emoji, pages, blocks). It never takes focus: the editor
// keeps the caret, routes the arrows, Enter and Escape here, and points screen
// readers at the active option (aria-activedescendant on the text field). It opens
// under the caret, or above it when the room left on screen is too short, the room
// being what the visual viewport shows (a phone's keyboard covers the rest).
import { For, type JSX, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { cn } from "~/lib/cn"
import { createVisualViewport } from "~/primitives/createVisualViewport"
import { type SuggestAnchor, suggestOptionId } from "./suggest"

export interface SuggestListProps<T> {
  /** The listbox's id (the text field's aria-controls). */
  id?: string
  testid: string
  itemTestid: string
  /** The listbox's accessible name. */
  label: string
  /** A small heading over the options (not read: the listbox's name says it). */
  heading?: string
  items: readonly T[]
  active: number
  anchor: SuggestAnchor
  /** Width in pixels (narrowed to the screen). */
  width: number
  /** How many rows fit before the list scrolls. */
  rows: number
  onPick: (item: T) => void
  option: (item: T) => JSX.Element
  /** Shown when there is no option. */
  empty?: JSX.Element
  /** Taller rows for a finger. */
  touchRows?: boolean
}

const ROW_PX = 32

export function SuggestList<T>(props: SuggestListProps<T>) {
  const viewport = createVisualViewport()
  const height = () => props.rows * ROW_PX + 8 + (props.heading ? 24 : 0)
  const style = () => {
    const width = Math.min(props.width, window.innerWidth - 16)
    const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - width - 8))
    const visibleBottom = viewport.offsetTop() + viewport.height()
    const above = props.anchor.bottom + height() > visibleBottom
    return {
      left: `${left}px`,
      width: `${width}px`,
      "max-height": `${height()}px`,
      ...(above
        ? { bottom: `${window.innerHeight - props.anchor.top + 4}px` }
        : { top: `${props.anchor.bottom + 4}px` }),
    }
  }
  return (
    <Portal>
      <div
        data-testid={props.testid}
        class="fixed z-50 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-xl"
        style={style()}
        // Keep the caret in the text: a click must not blur the editor.
        onMouseDown={(e) => e.preventDefault()}
      >
        <Show when={props.heading}>
          <div
            aria-hidden="true"
            class="px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"
          >
            {props.heading}
          </div>
        </Show>
        <div id={props.id} role="listbox" aria-label={props.label}>
          <For each={props.items}>
            {(item, i) => (
              <button
                type="button"
                id={props.id ? suggestOptionId(props.id, i()) : undefined}
                role="option"
                tabIndex={-1}
                aria-selected={i() === props.active}
                data-testid={props.itemTestid}
                class={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]",
                  props.touchRows && "[@media(pointer:coarse)]:min-h-11",
                  i() === props.active
                    ? "bg-surface-hover text-text"
                    : "text-text-secondary hover:bg-surface-hover/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault()
                  props.onPick(item)
                }}
              >
                {props.option(item)}
              </button>
            )}
          </For>
        </div>
        <Show when={props.items.length === 0}>{props.empty}</Show>
      </div>
    </Portal>
  )
}
