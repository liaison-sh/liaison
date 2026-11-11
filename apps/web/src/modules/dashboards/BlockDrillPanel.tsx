// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ROWS BEHIND A FIGURE, in a panel on the right of the dashboard (not a
// modal: the dashboard and the chat stay at hand). It opens when a bar, a
// slice, a stage, a table row or a metric is picked, and lists the source's
// rows behind it, a page at a time, with the paging and Close at its top. A row
// that leads to a record opens it: an app path in place, a record through its
// app's own opener. Its bottom keeps clear of the chat dock's bar.
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-solid"
import { type Component, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openEntity } from "~/modules/shell/entity-opener"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Skeleton } from "~/ui/Skeleton"
import { blockErrorKey } from "./blocks/BlockCard"
import { formatValue } from "./blocks/format"
import {
  type BlockRowsPage,
  type BlockRowsResult,
  type DashboardColumn,
  type DrillTarget,
  isAppPath,
  type RecordLink,
} from "./dashboards-client"

/** Opens a row's record: an in-app path in place, an entity through its app's opener. */
export function openRecordLink(api: ApiClient, link: RecordLink): void {
  if (link.kind === "path") {
    if (isAppPath(link.href)) spaNavigate(link.href)
    return
  }
  void openEntity(api, link.app, link.entityType, link.id)
}

export interface BlockDrillPanelProps {
  blockId: string
  blockTitle: string
  target: DrillTarget
  /** Reads one page of rows from `offset`. */
  load: (offset: number) => Promise<BlockRowsResult>
  /** Opens a row's record. */
  open: (link: RecordLink) => void
  onClose: () => void
  locale?: string
}

interface KeyedRow {
  key: string
  index: number
  row: Record<string, unknown>
}

const NUMERIC = new Set(["number", "currency", "percent"])

export const BlockDrillPanel: Component<BlockDrillPanelProps> = (props) => {
  const i18n = useI18n()
  const locale = () => props.locale ?? i18n.locale()
  const [offset, setOffset] = createSignal(0)
  const [page, setPage] = createSignal<BlockRowsPage | null>(null)
  const [error, setError] = createSignal<Extract<BlockRowsResult, { ok: false }> | null>(null)
  const [busy, setBusy] = createSignal(true)
  let closeButton: HTMLButtonElement | undefined
  let seq = 0

  async function read(from: number): Promise<void> {
    const mine = ++seq
    setBusy(true)
    const result = await props.load(from)
    if (mine !== seq) return
    setBusy(false)
    if (result.ok) {
      setPage(result.page)
      setOffset(result.page.offset)
      setError(null)
    } else {
      setError(result)
    }
  }

  // Another figure picked while the panel is open: back to its first page.
  createEffect(
    on(
      () => [props.blockId, props.target.category, props.target.series, props.target.row] as const,
      () => {
        setPage(null)
        setError(null)
        void read(0)
      },
    ),
  )
  onMount(() => closeButton?.focus())
  onCleanup(() => {
    seq++
  })

  /** A refusal to read again so soon keeps the rows already shown. */
  const keepsRows = () => error()?.error === "rate_limited" && page() !== null
  const subtitle = () => {
    const t = props.target
    if (t.row !== undefined) return i18n.t("kernel.dashboards.drillRow", { n: t.row + 1 })
    if (t.category !== undefined) {
      const label = t.category === "" ? i18n.t("kernel.dashboards.drillNone") : t.category
      return t.series ? `${label} · ${t.series}` : label
    }
    return i18n.t("kernel.dashboards.drillAllRows")
  }
  const rangeText = () => {
    const p = page()
    if (!p || p.total === 0) return ""
    return i18n.t("kernel.dashboards.drillRange", {
      from: p.offset + 1,
      to: Math.min(p.offset + p.rows.length, p.total),
      total: p.total,
    })
  }
  const columns = (): Array<CardTableColumn<KeyedRow>> => {
    const p = page()
    if (!p) return []
    const cols: Array<CardTableColumn<KeyedRow>> = p.columns.map(
      (c: DashboardColumn, i: number) => {
        const numeric = c.format !== undefined && NUMERIC.has(c.format)
        return {
          key: c.field,
          header: c.label,
          cell: (r: KeyedRow) =>
            formatValue(r.row[c.field], { format: c.format, locale: locale() }),
          role: i === 0 ? "anchor" : i >= 4 ? "fold" : numeric ? "meta" : "secondary",
          align: numeric ? "right" : undefined,
          numeric: numeric || undefined,
        }
      },
    )
    if (p.links) {
      cols.push({
        key: "__open",
        header: "",
        role: "meta",
        cell: (r: KeyedRow) => {
          const link = page()?.links?.[r.index] ?? null
          return link ? (
            <button
              type="button"
              data-testid={`dashboard-drill-open-${r.index}`}
              data-link-kind={link.kind}
              onClick={(e) => {
                e.stopPropagation()
                props.open(link)
              }}
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-accent hover:bg-surface-hover"
            >
              <ExternalLink size={12} aria-hidden="true" />
              {i18n.t("kernel.dashboards.drillOpen")}
            </button>
          ) : (
            ""
          )
        },
      })
    }
    return cols
  }
  const rows = (): KeyedRow[] =>
    (page()?.rows ?? []).map((row, i) => ({ key: String(i), index: i, row }))

  return (
    <aside
      data-testid="dashboard-drill-panel"
      data-block-id={props.blockId}
      aria-label={i18n.t("kernel.dashboards.drillTitle", { title: props.blockTitle })}
      style={{ "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD }}
      class="absolute inset-0 z-10 flex min-h-0 flex-col bg-bg @2xl:static @2xl:inset-auto @2xl:z-auto @2xl:w-[420px] @2xl:shrink-0 @2xl:border-l @2xl:border-border-subtle"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          props.onClose()
        }
      }}
    >
      <header class="flex flex-col gap-2 border-b border-border-subtle px-4 py-2.5">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h2
              data-testid="dashboard-drill-title"
              class="truncate text-[13.5px] font-semibold text-text"
              title={props.blockTitle}
            >
              {props.blockTitle}
            </h2>
            <p
              data-testid="dashboard-drill-subtitle"
              class="truncate text-[12px] text-text-tertiary"
            >
              {subtitle()}
            </p>
          </div>
          <button
            type="button"
            ref={closeButton}
            data-testid="dashboard-drill-close"
            aria-label={i18n.t("kernel.dashboards.drillClose")}
            title={i18n.t("kernel.dashboards.drillClose")}
            onClick={() => props.onClose()}
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <X size={15} />
          </button>
        </div>
        <Show when={page() && page()!.total > 0}>
          <div class="flex items-center gap-2">
            <span
              data-testid="dashboard-drill-count"
              class="min-w-0 flex-1 truncate text-[12px] tabular-nums text-text-secondary"
            >
              {rangeText()}
            </span>
            <button
              type="button"
              data-testid="dashboard-drill-prev"
              aria-label={i18n.t("kernel.dashboards.drillPrevious")}
              title={i18n.t("kernel.dashboards.drillPrevious")}
              disabled={busy() || offset() === 0}
              onClick={() => void read(Math.max(0, offset() - (page()?.limit ?? 50)))}
              class="flex h-7 w-7 items-center justify-center rounded border border-border-subtle text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              data-testid="dashboard-drill-next"
              aria-label={i18n.t("kernel.dashboards.drillNext")}
              title={i18n.t("kernel.dashboards.drillNext")}
              disabled={busy() || page()?.nextOffset == null}
              onClick={() => {
                const next = page()?.nextOffset
                if (next != null) void read(next)
              }}
              class="flex h-7 w-7 items-center justify-center rounded border border-border-subtle text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Show
          when={page() && (!error() || keepsRows())}
          fallback={
            <Show
              when={error()}
              fallback={
                <div data-testid="dashboard-drill-loading" class="space-y-2">
                  <Skeleton class="h-4 w-full" />
                  <Skeleton class="h-4 w-5/6" />
                  <Skeleton class="h-4 w-2/3" />
                </div>
              }
            >
              {(err) => (
                <p
                  data-testid="dashboard-drill-error"
                  data-error={err().error}
                  title={err().message}
                  class="py-4 text-[13px] text-text-tertiary"
                >
                  {i18n.t(blockErrorKey(err().error))}
                </p>
              )}
            </Show>
          }
        >
          <Show when={keepsRows()}>
            <p data-testid="dashboard-drill-note" class="mb-2 text-[11.5px] text-text-tertiary">
              {i18n.t("kernel.dashboards.blockRateLimited")}
            </p>
          </Show>
          <div
            data-testid="dashboard-drill-rows"
            aria-busy={busy() ? "true" : undefined}
            class="min-w-0 overflow-x-auto"
          >
            <CardTable
              rows={rows()}
              rowKey={(r) => r.key}
              columns={columns()}
              floor="flexible"
              rowTestid={(r) => `dashboard-drill-row-${r.index}`}
              emptyState={
                <p data-testid="dashboard-drill-empty" class="py-4 text-[13px] text-text-tertiary">
                  {i18n.t("kernel.dashboards.drillEmpty")}
                </p>
              }
            />
          </div>
          <Show when={page()?.truncated}>
            <p
              data-testid="dashboard-drill-truncated"
              class="mt-2 text-[11.5px] text-text-tertiary"
            >
              {i18n.t("kernel.dashboards.drillTruncated")}
            </p>
          </Show>
        </Show>
      </div>
    </aside>
  )
}
