// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * ResponsiveList: one list, two markups.
 *
 * A desktop table-row / list-item pattern renders as a stacked card at phone
 * width. Both markups are emitted for every item and Tailwind's `md:`
 * breakpoint decides which one paints, so no JS tier branching is involved and
 * the choice survives a resize with no re-render.
 *
 * DOUBLE MARKUP TESTID RULE. Both markups are in the document at the same
 * time; only CSS decides which one paints. So a `data-testid` emitted from
 * both `renderRow` and `renderCard` exists TWICE, and a bare
 * `getByTestId("ticket-3")` is ambiguous: jsdom has no layout, so it cannot
 * tell you which one a user would see, and the query either throws on the
 * duplicate or silently answers about the wrong breakpoint. Callers and their
 * tests must therefore scope by the wrapper this component stamps:
 * `[data-responsive="row"]` for the desktop markup and
 * `[data-responsive="card"]` for the phone markup, or give the card copy its
 * own suffixed testid (the convention `BottomSheetActions` follows with
 * `<testid>-sheet`). Never assert on an unscoped duplicate.
 *
 * TABLE LAYOUT IS FIXED, and that is load-bearing. `md:table-row` makes each
 * row's content an anonymous table CELL, and a table laid out automatically
 * sizes that cell to its content: a row whose inner flex items all say
 * `min-width: 0` still could not shrink, because the cell it sat in had no
 * width to shrink against. Measured at 820px on a ticket row, the row came out
 * 2633px wide with the timestamp at x=2621, far past the window, while the
 * list itself reported no overflow at all (its own box is `w-full`), so
 * nothing scrolled and nothing folded. With `table-fixed` the cell is the
 * table's width, the row is 820px, the timestamp ends at 808px and the preview
 * truncates inside its own track.
 *
 * Usage agreement (spec-responsive.md, "lists become cards"): the caller MUST
 * put the most identifying field (name, ticket subject, order number) first in
 * `renderCard`'s JSX, so the card has a visual anchor. That is a documented
 * contract, not something this component can enforce.
 */
import { For, type JSX, Show } from "solid-js"
import { cn } from "~/lib/cn"

export interface ResponsiveListProps<T> {
  items: readonly T[]
  renderRow: (item: T, index: number) => JSX.Element
  renderCard: (item: T, index: number) => JSX.Element
  /** Extra classes for the row wrapper (desktop). */
  rowClass?: string
  /** Extra classes for the card wrapper (phone). */
  cardClass?: string
  /**
   * Optional desktop header row (column titles). It lives inside the same
   * `md:table` root as the rows, so the columns line up; it is hidden at phone
   * width, where the cards carry their own labels.
   */
  header?: JSX.Element
  class?: string
}

export function ResponsiveList<T>(props: ResponsiveListProps<T>): JSX.Element {
  return (
    <div
      class={cn("contents md:table md:w-full md:table-fixed", props.class)}
      data-responsive="list"
    >
      <Show when={props.header}>
        <div class="hidden md:table-row" data-responsive="header">
          {props.header}
        </div>
      </Show>
      <For each={props.items}>
        {(item, index) => (
          <>
            <div class={cn("hidden md:table-row", props.rowClass)} data-responsive="row">
              {props.renderRow(item, index())}
            </div>
            <div
              class={cn("block md:hidden rounded-lg border border-border p-3", props.cardClass)}
              data-responsive="card"
            >
              {props.renderCard(item, index())}
            </div>
          </>
        )}
      </For>
    </div>
  )
}
