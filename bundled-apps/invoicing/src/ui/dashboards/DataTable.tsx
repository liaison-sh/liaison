// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Generic, dashboard-shared table shell over a `DashboardColumn[]` + row list.
// A thin wrapper over the shared `CardTable` (`@liaison/app-ui/card-table`):
// this file maps each `DashboardColumn`'s `kind` + `survivesPhone` hints onto
// CardTable's role model (anchor/secondary/meta/fold) so every dashboard gets
// the phone card story for free, while CSV export keeps using the plain `get`
// accessor untouched (columns.ts).
import { tr } from "../i18n"
import { Show, type Component, type JSX } from "solid-js"
import { navigate } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { Badge, cx, StatusBadge, TypeLabel } from "../kit"
import type { DashboardColumn } from "./columns"

interface DataTableProps<R> {
  columns: DashboardColumn<R>[]
  rows: R[]
  emptyState: string
  testid: string
  /** Optional rollup footer — rendered below the table when non-null. */
  footer?: () => string
  /** Optional per-row link target. When it returns a string the row becomes
   *  clickable (cursor-pointer + navigate); returning `null` keeps the row
   *  inert. Mirrors the shopify app's row-click idiom (lists.tsx). */
  rowHref?: (row: R) => string | null
  /**
   * Per-row decoration for a pair/group (split-order halves, or a credit note
   * with the invoice it credits). Returns the row's position in the group
   * ("first"/"middle"/"last") plus a group key. Absent = an ordinary row.
   */
  pairing?: (row: R) => { position: "first" | "middle" | "last" | null; key: string } | null
  /** Rendered on the FIRST row of a group, next to its identity cell. */
  pairAction?: (key: string) => ReturnType<Component>
  /** Human-readable text naming the link ("Credits INV-2026-0042" /
   *  "Credited by CN-2026-0007"), rendered under the row's identity cell.
   *  Null/absent = nothing shown. */
  pairLabel?: (row: R) => string | null | undefined
  /** Per-row testid (each row's card on a phone too); absent = the table's own. */
  rowTestid?: (row: R) => string
  /** Per-row `data-*` attributes naming what the row is (a guided tour points at one row). */
  rowData?: (row: R) => Record<string, string>
}

/** Exported for unit testing (bun:test, no jsdom) — mirrors the shopify app's
 *  row-click idiom (lists.tsx onRowClick): cmd/ctrl-click opens a genuine new
 *  tab, otherwise SPA-navigates via the host's `navigate`. */
export function onRowClick(href: string, e: MouseEvent): void {
  if (e.metaKey || e.ctrlKey) {
    // Cmd/Ctrl-click opens a genuine new browser tab — that is a deliberate
    // browser-level action, not in-app SPA navigation.
    window.open(href, "_blank", "noopener,noreferrer")
  } else {
    navigate(href)
  }
}

/** The column CardTable's card treats as the row's identity. Preferring these
 *  well-known keys keeps every existing dashboard's card line 1 reading the
 *  same as its old "number"/"customer"/"country" first column; falling back
 *  to the first declared column keeps an unknown shape from rendering blank. */
function chooseAnchorKey<R>(columns: DashboardColumn<R>[]): string | undefined {
  for (const key of ["number", "customer", "country"]) {
    if (columns.some((c) => c.key === key)) return key
  }
  return columns[0]?.key
}

function renderCell<R>(col: DashboardColumn<R>, row: R): JSX.Element {
  const raw = col.get(row)
  if (raw === "" && col.kind !== "status") {
    return <span class="text-text-tertiary">-</span>
  }
  switch (col.kind) {
    case "status":
      return <StatusBadge status={raw} />
    case "type":
      return <TypeLabel type={raw} />
    case "channel":
      return (
        <Badge tone="muted" class="capitalize">
          {raw}
        </Badge>
      )
    case "money":
      return <span class="font-mono tabular-nums text-text">{raw}</span>
    case "num":
      return <span class="font-mono tabular-nums text-text-secondary">{raw}</span>
    default:
      return (
        <span class={col.key === "number" || col.key === "customer" ? "text-text" : undefined}>{raw}</span>
      )
  }
}

type PairInfo = { position: "first" | "middle" | "last" | null; key: string } | null

/**
 * A pair/group reads as ONE thing: tinted together, with the divider between
 * its members suppressed so the bracket spans an unbroken block. Only the
 * LAST member keeps its bottom divider, the real boundary to the next row.
 * The tint is an explicit alpha: `bg-accent-glow/20` computed to 0.022 on
 * prod, present in the class string and invisible on screen.
 */
export function pairRowClass(pair: PairInfo): string | undefined {
  if (!pair) return undefined
  return cx("bg-accent/[0.055]", pair.position !== "last" && "border-b-transparent")
}

/**
 * The bracket joining every member of a group: a left edge spanning them all,
 * turning in at the top of the first row and the bottom of the last, straight
 * through any middle row.
 */
export function pairBracketClass(pair: PairInfo): string | undefined {
  if (!pair?.position) return undefined
  return cx(
    "pointer-events-none absolute left-1 w-1.5 border-l-2 border-accent/70",
    pair.position === "first"
      ? "bottom-0 top-1/2 rounded-tl border-t-2"
      : pair.position === "last"
        ? "bottom-1/2 top-0 rounded-bl border-b-2"
        : "bottom-0 top-0",
  )
}

/** Maps a `DashboardColumn[]` onto CardTable's role model. A column array in
 *  which no column declares `survivesPhone` keeps every column visible on the
 *  card (no fold) — the same "nothing collapses" behavior the grouped
 *  dashboards (B2B, by-market) had before; an array that DOES declare
 *  survivors folds the rest behind the card's chevron, same as the old
 *  per-row phone-expand button did for the documents list. */
function toCardColumns<R>(
  columns: DashboardColumn<R>[],
  opts: {
    pairing?: (row: R) => { position: "first" | "middle" | "last" | null; key: string } | null
    pairAction?: (key: string) => ReturnType<Component>
    pairLabel?: (row: R) => string | null | undefined
  },
): Array<CardTableColumn<R>> {
  const anchorKey = chooseAnchorKey(columns)
  const anyDeclaresSurvival = columns.some((c) => c.survivesPhone)
  return columns.map((c) => {
    const isAnchor = c.key === anchorKey
    const isNumeric = c.kind === "money" || c.kind === "num"
    const role: CardTableColumn<R>["role"] = isAnchor
      ? "anchor"
      : c.key === "customer"
        ? "secondary"
        : isNumeric || c.kind === "status" || c.kind === "type" || c.kind === "channel"
          ? "meta"
          : anyDeclaresSurvival && !c.survivesPhone
            ? "fold"
            : "meta"
    return {
      key: c.key,
      header: tr(c.label),
      role,
      align: c.align,
      numeric: isNumeric,
      fit: c.fit,
      cell: (row: R) => {
        const body = renderCell(c, row)
        if (!isAnchor) return body
        const pair = opts.pairing?.(row) ?? null
        const label = opts.pairLabel?.(row)
        return (
          <span class="flex flex-col gap-0.5">
            <span class="flex items-center gap-2">
              {body}
              <Show when={pair?.position === "first" && opts.pairAction}>
                {(action) => <span class="text-[11px] text-text-secondary">{action()(pair!.key)}</span>}
              </Show>
            </span>
            <Show when={label}>
              <span class="text-[10.5px] text-text-tertiary">{label}</span>
            </Show>
          </span>
        )
      },
    }
  })
}

export function DataTable<R>(props: DataTableProps<R>): ReturnType<Component> {
  return (
    <div data-testid={props.testid} class="flex h-full min-h-0 flex-col">
      <Show
        when={props.rows.length > 0}
        fallback={
          <div
            data-testid={`${props.testid}-empty`}
            class="flex flex-1 items-center justify-center px-6 py-12 text-center text-[12.5px] text-text-tertiary"
          >
            {tr(props.emptyState)}
          </div>
        }
      >
        <div class="flex-1 overflow-auto">
          <CardTable
            rows={props.rows}
            rowKey={(row) => String(props.rows.indexOf(row))}
            columns={toCardColumns(props.columns, {
              pairing: props.pairing,
              pairAction: props.pairAction,
              pairLabel: props.pairLabel,
            })}
            rowClass={props.pairing ? (row) => pairRowClass(props.pairing?.(row) ?? null) : undefined}
            rowMarker={
              props.pairing
                ? (row) => {
                    const pair = props.pairing?.(row) ?? null
                    const cls = pairBracketClass(pair)
                    return cls ? (
                      <span aria-hidden="true" data-testid="invoicing-pair-bracket" class={cls} />
                    ) : undefined
                  }
                : undefined
            }
            rowTestid={props.rowTestid}
            rowAttrs={
              props.pairing || props.rowData
                ? (row): Record<string, string> => {
                    const own = props.rowData?.(row) ?? {}
                    const pair = props.pairing?.(row) ?? null
                    if (!pair) return own
                    return {
                      ...own,
                      "data-pair-key": pair.key,
                      ...(pair.position ? { "data-pair-position": pair.position } : {}),
                    }
                  }
                : undefined
            }
            onRowClick={
              props.rowHref
                ? (row, e) => {
                    const href = props.rowHref?.(row) ?? null
                    if (href) onRowClick(href, e)
                  }
                : undefined
            }
          />
        </div>
        <Show when={props.footer}>
          <div
            data-testid={`${props.testid}-footer`}
            class="border-t border-border bg-bg px-4 py-2.5 text-[11.5px] font-medium text-text-secondary"
          >
            {props.footer?.()}
          </div>
        </Show>
      </Show>
    </div>
  )
}
