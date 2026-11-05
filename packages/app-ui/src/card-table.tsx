// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CardTable — the one responsive list primitive every bundled app shares.
//
// A bundled app cannot import `apps/web/src/**` (the purity guard), so none of
// the nine first-party apps had a phone story: each shipped a fixed-width
// `<table>` that a 390 px viewport can only scroll sideways. CardTable is that
// story, in the shared kit: ONE column declaration renders a dense table from
// 640 px up and a stack of cards below it.
//
// The variant is chosen in JS (`matchMedia("(max-width: 639px)")`), not by
// `hidden sm:table` classes, on purpose: a class-toggled pair renders BOTH
// trees, so every row testid exists twice and a Playwright `getByTestId` hits
// a strict-mode violation. One variant in the DOM at a time keeps every
// existing per-row testid unambiguous. 639 px is the kernel shell's own phone
// tier, so an app switches to cards exactly when the shell switches to the
// phone surface.
//
// Card anatomy (the approved design):
//   line 1  anchor cell (bold) + the first `numeric` meta cell, right aligned
//   line 2  the secondary cells
//   line 3  the remaining meta cells as inline pills, last one right aligned
//           and muted
//   fold    hidden behind a chevron; expands into a label/value grid, with the
//           row's actions as small buttons underneath
//
// Bundling rule (see kit.tsx): explicit props only, NO `{...rest}` spread — a
// spread makes Solid's compiler emit a `mergeProps` import the freeze bundler
// cannot resolve.
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { Button, type ButtonVariant, cx, Th } from "./kit"

/** What a column is FOR, which is what decides where it lands on a card. */
export type CardTableRole = "anchor" | "secondary" | "meta" | "fold"

export interface CardTableColumn<T> {
  key: string
  header: string
  cell: (row: T) => JSX.Element
  role: CardTableRole
  align?: "right"
  /** Tabular figures, and (for the first such meta column) the card's line-1 value. */
  numeric?: boolean
  /**
   * The column takes its CONTENT width in the table variant and never wraps,
   * so the anchor column absorbs whatever is left. A numeric column is always
   * fitted: an amount cut to "918.0" is not a smaller amount, it is a wrong
   * one. Set it on any column whose cell is an atom (a badge, a status pill)
   * that reads as blank once it is squeezed.
   */
  fit?: boolean
}

export interface CardTableAction {
  label: string
  onSelect: () => void
  tone?: ButtonVariant
}

const PHONE_QUERY = "(max-width: 639px)"
/** THE TABLET TIER. Between the phone card stack and a desktop the whole table
 *  fits on, a fixed `<table>` had nowhere to go: at 820 px it squeezed every
 *  column until the words broke mid-letter ("PAYMEN", "Unp") and the last
 *  column left the window. The table variant drops its LOWEST priority columns
 *  here (the `fold` role, which is already what the card hides behind its
 *  chevron) and keeps a per-column floor under the rest, so the container
 *  scrolls as a last resort rather than clipping a word. */
const NARROW_QUERY = "(max-width: 1023px)"
/** Every visible column keeps at least this much width before the container
 *  starts scrolling. Below it a header and its cells break mid-word. */
const MIN_COLUMN_REM = 7.5

/** Reactive `true` while `query` matches. Falls back to `false` wherever
 *  `matchMedia` is absent, so a non-DOM render is never blank. */
function createMediaMatch(query: string): () => boolean {
  const mm = typeof window !== "undefined" && typeof window.matchMedia === "function"
  if (!mm) return () => false
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange)
    onCleanup(() => list.removeEventListener("change", onChange))
  }
  return matches
}

/** Apply a row's arbitrary attributes through a `ref`, never a `{...spread}`:
 *  a spread makes Solid's compiler emit `mergeProps`, which the freeze bundler
 *  cannot resolve (see the bundling rule above). Reactive, and it REMOVES an
 *  attribute the row no longer carries so a stale marker cannot survive a
 *  refetch. */
function attrsRef(get: () => Record<string, string> | undefined) {
  return (el: Element) => {
    let previous: string[] = []
    createEffect(() => {
      const next = get() ?? {}
      for (const key of previous) {
        if (!Object.hasOwn(next, key)) el.removeAttribute(key)
      }
      for (const [key, value] of Object.entries(next)) el.setAttribute(key, value)
      previous = Object.keys(next)
    })
  }
}

/** Up or down, drawn as two glyphs rather than one rotated by 180 degrees: an
 *  `<svg>` element's CSS transform origin is its top left corner, not its
 *  centre, so `rotate-180` swung the chevron out of its own 16 px box and the
 *  open state rendered as a clipped corner. */
function ChevronIcon(props: { open: boolean }): JSX.Element {
  return (
    <svg
      class="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        data-chevron={props.open ? "up" : "down"}
        d={props.open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"}
      />
    </svg>
  )
}

export function CardTable<T>(props: {
  rows: T[]
  rowKey: (row: T) => string
  columns: Array<CardTableColumn<T>>
  actions?: (row: T) => CardTableAction[]
  onRowClick?: (row: T, e: MouseEvent) => void
  emptyState?: JSX.Element
  /** Default true. False keeps the fold columns out of the card entirely. */
  expandable?: boolean
  /** Per-row test hook, applied to the row OR the card (only one exists). */
  rowTestid?: (row: T) => string
  /** Arbitrary per-row attributes (state markers such as `data-invalid`),
   *  applied to the `<tr>` in the table variant and to the card root below it.
   *  The old hand written tables carried these on the row element and the
   *  oracles that read them are variant blind, so both variants get them. */
  rowAttrs?: (row: T) => Record<string, string>
  /** An accordion panel for the row, rendered DIRECTLY under it: a full width
   *  `<tr>` in the table variant, inside the card below it. Return nothing for
   *  a row that is not expanded. The kit's own fold is a label/value grid, so
   *  an app with a rich panel used to paint it after the whole table, which put
   *  a campaign's detail nowhere near the campaign. */
  renderDetail?: (row: T) => JSX.Element
  /** Extra classes for one row: on the `<tr>` in the table variant and on the
   *  card root below it. For a visual state that spans several rows (a tint
   *  shared by a group, a divider suppressed between its members). */
  rowClass?: (row: T) => string | undefined
  /** A decoration drawn at the row's LEADING EDGE (a bracket joining grouped
   *  rows, say), positioned against the row itself: inside the first cell,
   *  which becomes the containing block, in the table variant (a `<tr>` is not
   *  a reliable one across browsers), and inside the card root below it. The
   *  element positions itself (`absolute ...`). Return nothing for a plain row. */
  rowMarker?: (row: T) => JSX.Element
  /** Which table columns keep the 7.5rem floor. Default `"all"`: every column
   *  and the actions column. `"flexible"` floors only the columns that wrap
   *  (neither `fit` nor `numeric`): a fitted column and the actions column
   *  already hold their content width, so in a narrow container (a settings
   *  pane) their floor only pushed the row's actions out of view. */
  floor?: "all" | "flexible"
}): JSX.Element {
  const isPhone = createMediaMatch(PHONE_QUERY)
  const isNarrow = createMediaMatch(NARROW_QUERY)
  /** The tablet tier: too wide for cards, too narrow for every column. */
  const isTablet = () => isNarrow() && !isPhone()
  const expandable = () => props.expandable !== false
  const cols = () => props.columns
  const anchor = () => cols().find((c) => c.role === "anchor")
  const secondaries = () => cols().filter((c) => c.role === "secondary")
  const metas = () => cols().filter((c) => c.role === "meta")
  const leadMeta = () => metas().find((c) => c.numeric) ?? null
  // Compared by KEY, never by object identity: an app whose `columns` prop is a
  // function rebuilding the array on every read hands out fresh objects, so an
  // identity filter drops nothing and the headline number is painted twice.
  const trailingMetas = () => {
    const lead = leadMeta()?.key
    return metas().filter((c) => c.key !== lead)
  }
  const folds = () => (expandable() ? cols().filter((c) => c.role === "fold") : [])
  /** What the TABLE variant draws. On a tablet the `fold` columns are dropped:
   *  they are the ones the column author already marked as the first to go. */
  const tableCols = () => (isTablet() ? cols().filter((c) => c.role !== "fold") : cols())
  const flooredColumnCount = () =>
    props.floor === "flexible"
      ? tableCols().filter((c) => !c.fit && !c.numeric).length
      : tableCols().length + (props.actions ? 1 : 0)
  // Which cards are expanded, keyed by `rowKey` and held HERE rather than in a
  // per-row signal. `<For>` is keyed by object identity, so a refetch that
  // returns the same rows as fresh objects rebuilds every CardRow: a per-row
  // signal is thrown away with it and every open card silently snaps shut
  // under the operator mid read.
  const [openKeys, setOpenKeys] = createSignal<ReadonlySet<string>>(new Set<string>())
  const isOpen = (row: T) => openKeys().has(props.rowKey(row))
  const toggleOpen = (row: T) => {
    const key = props.rowKey(row)
    const next = new Set(openKeys())
    if (!next.delete(key)) next.add(key)
    setOpenKeys(next)
  }
  const actionsFor = (row: T): CardTableAction[] => props.actions?.(row) ?? []

  function ActionButtons(p: { row: T; class?: string }): JSX.Element {
    return (
      <div class={cx("flex flex-wrap items-center gap-1.5", p.class)}>
        <For each={actionsFor(p.row)}>
          {(a) => (
            <Button
              variant={a.tone ?? "secondary"}
              class="min-h-11 sm:min-h-0"
              onClick={(e) => {
                e.stopPropagation()
                a.onSelect()
              }}
            >
              {a.label}
            </Button>
          )}
        </For>
      </div>
    )
  }

  function CardRow(p: { row: T }): JSX.Element {
    const open = () => isOpen(p.row)
    const hasFold = () => folds().length > 0
    const hasActions = () => actionsFor(p.row).length > 0
    const canExpand = () => hasFold() || hasActions()
    return (
      <div
        ref={attrsRef(() => props.rowAttrs?.(p.row))}
        data-testid={props.rowTestid?.(p.row) ?? "card-table-card"}
        data-row-key={props.rowKey(p.row)}
        class={cx(
          "flex flex-col px-4 py-3 text-[12.5px] text-text",
          props.onRowClick && "cursor-pointer",
          props.rowMarker && "relative",
          props.rowClass?.(p.row),
        )}
        onClick={(e) => props.onRowClick?.(p.row, e)}
      >
        <Show when={props.rowMarker?.(p.row)}>{(marker) => marker()}</Show>
        {/* The app's per-row testid OWNS the card root, because every per-row
            oracle written against the old `<tr>` addresses the row by it. The
            kit's own `card-table-card` handle then moves one level in, so both
            keep resolving and each still matches exactly once per row. */}
        <div
          data-testid={props.rowTestid ? "card-table-card" : undefined}
          data-card-table-body="true"
          class="flex flex-col gap-1.5"
        >
          {/* line 1 — anchor, and the numeric meta value it is judged by */}
          <div class="flex min-h-11 items-center justify-between gap-3">
            <span class="truncate text-[13px] font-semibold text-text">
              {anchor()?.cell(p.row)}
            </span>
            <div class="flex shrink-0 items-center gap-1">
              <Show when={leadMeta()}>
                {(m) => (
                  <span class="font-mono text-[13px] tabular-nums text-text">
                    {m().cell(p.row)}
                  </span>
                )}
              </Show>
              <Show when={canExpand()}>
                <button
                  type="button"
                  data-testid="card-table-expand"
                  aria-expanded={open()}
                  aria-label={open() ? "Hide details" : "Show details"}
                  class="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-tertiary outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-tint"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleOpen(p.row)
                  }}
                >
                  <ChevronIcon open={open()} />
                </button>
              </Show>
            </div>
          </div>

          {/* line 2 — the secondary identity of the row */}
          <Show when={secondaries().length > 0}>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-secondary">
              <For each={secondaries()}>{(c) => <span class="truncate">{c.cell(p.row)}</span>}</For>
            </div>
          </Show>

          {/* line 3 — the rest of the meta, last one right aligned and muted */}
          <Show when={trailingMetas().length > 0}>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
              <For each={trailingMetas()}>
                {(c, i) => (
                  <span
                    class={cx(
                      "inline-flex items-center gap-1",
                      c.numeric && "font-mono tabular-nums",
                      i() === trailingMetas().length - 1 && "ml-auto text-text-tertiary",
                    )}
                  >
                    {c.cell(p.row)}
                  </span>
                )}
              </For>
            </div>
          </Show>

          {/* fold — label/value grid, then the row's actions */}
          <Show when={open()}>
            <div data-testid="card-table-fold" class="mt-1 flex flex-col gap-2">
              <Show when={hasFold()}>
                <dl class="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border-subtle pt-2 text-[12px]">
                  <For each={folds()}>
                    {(c) => (
                      <>
                        <dt class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
                          {c.header}
                        </dt>
                        <dd
                          class={cx("text-text-secondary", c.numeric && "font-mono tabular-nums")}
                        >
                          {c.cell(p.row)}
                        </dd>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
              <Show when={hasActions()}>
                <ActionButtons row={p.row} />
              </Show>
            </div>
          </Show>

          {/* the app's own accordion panel, under the card it belongs to */}
          <Show when={props.renderDetail?.(p.row)}>
            {(detail) => (
              <div data-testid="card-table-detail" class="mt-2 border-t border-border-subtle pt-2">
                {detail()}
              </div>
            )}
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="card-table" class="w-full">
      <Show when={props.rows.length > 0} fallback={props.emptyState}>
        <Show
          when={isPhone()}
          fallback={
            <div class="w-full overflow-x-auto">
              <table
                class="w-full text-left text-xs"
                style={{ "min-width": `${flooredColumnCount() * MIN_COLUMN_REM}rem` }}
              >
                <thead class="bg-bg/40">
                  <tr>
                    <For each={tableCols()}>
                      {(c) => (
                        <Th
                          pad="tight"
                          right={c.align === "right"}
                          class={cx("px-4 py-2", (c.fit || c.numeric) && "w-px whitespace-nowrap")}
                        >
                          {c.header}
                        </Th>
                      )}
                    </For>
                    <Show when={props.actions}>
                      <Th pad="tight" right class="px-4 py-2">
                        Actions
                      </Th>
                    </Show>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border-subtle">
                  <For each={props.rows}>
                    {(row) => (
                      <>
                        <tr
                          ref={attrsRef(() => props.rowAttrs?.(row))}
                          data-testid={props.rowTestid?.(row) ?? "card-table-row"}
                          data-row-key={props.rowKey(row)}
                          class={cx(
                            "text-text transition-colors hover:bg-surface-hover",
                            props.onRowClick && "cursor-pointer",
                            props.rowClass?.(row),
                          )}
                          onClick={(e) => props.onRowClick?.(row, e)}
                        >
                          <For each={tableCols()}>
                            {(c, ci) => (
                              <td
                                class={cx(
                                  "px-4 py-2.5 align-middle",
                                  ci() === 0 && props.rowMarker && "relative",
                                  c.align === "right" && "text-right",
                                  // `w-px` is the shrink-to-fit idiom for an
                                  // auto layout table: the column asks for its
                                  // content width and the anchor takes the
                                  // remainder, instead of every column being
                                  // squeezed alike until a number reads "918.0"
                                  // and a badge reads as an empty cell.
                                  (c.fit || c.numeric) && "w-px whitespace-nowrap",
                                  c.numeric && "font-mono tabular-nums",
                                )}
                              >
                                <Show when={ci() === 0 && props.rowMarker?.(row)}>
                                  {(marker) => marker()}
                                </Show>
                                {c.cell(row)}
                              </td>
                            )}
                          </For>
                          <Show when={props.actions}>
                            <td class="px-4 py-2.5 text-right align-middle">
                              <ActionButtons row={row} class="justify-end" />
                            </td>
                          </Show>
                        </tr>
                        {/* the app's accordion panel, as a full width row directly
                        under the row it belongs to */}
                        <Show when={props.renderDetail?.(row)}>
                          {(detail) => (
                            <tr data-testid="card-table-detail" data-row-key={props.rowKey(row)}>
                              <td
                                colSpan={tableCols().length + (props.actions ? 1 : 0)}
                                class="p-0"
                              >
                                {detail()}
                              </td>
                            </tr>
                          )}
                        </Show>
                      </>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          }
        >
          <div class="flex flex-col divide-y divide-border-subtle">
            <For each={props.rows}>{(row) => <CardRow row={row} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
