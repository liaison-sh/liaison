// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One block on a grid: its title, its own refresh, and its data or the calm
// reason it has none. A block's failure is its own: the rest of the grid draws.
// Under the data: when it was read ("Updated 4 min ago"), and rows the server
// left out. A block that keeps its own window while the dashboard has a range
// shows that window as a chip beside its title.
import { RefreshCw, Rows3 } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Skeleton } from "~/ui/Skeleton"
import type {
  BlockData,
  BlockErrorKind,
  BlockReadInfo,
  BlockResult,
  BlockWindow,
  DashboardBlockSpec,
  DrillTarget,
} from "../dashboards-client"
import { formatDay, formatWindow } from "../time-range"
import { BlockRenderer } from "./BlockRenderer"

export interface BlockCardProps {
  block: DashboardBlockSpec
  /** Reads the block's data; `refresh` asks the server to skip its cache. */
  load: (refresh: boolean) => Promise<BlockResult>
  /** Bumped by the page's Refresh all: each change re-reads the block past the cache. */
  refreshTick?: number
  /** The dashboard range the block reads (a key): a change re-reads it. */
  rangeKey?: string
  /** The filter values the block reads (a key): a change re-reads it. */
  filtersKey?: string
  /** Opens the rows behind a figure of this block (the dashboard's side panel). */
  onDrill?: (target: DrillTarget) => void
  /** The dashboard shows a range picker: a block keeping its own window then says which. */
  showOwnWindow?: boolean
  /** The page's clock (ms), ticking slowly: "Updated N min ago" follows it. */
  now?: number
  /** The page is on screen: a block with its own `refreshSec` re-reads on that cadence only then. */
  visible?: boolean
  /** Each read's context (window, comparison), for the page's range label. */
  onRead?: (info: BlockReadInfo | undefined) => void
  locale?: string
  class?: string
}

export type BlockStatus = "loading" | "ready" | "error"

const ERROR_KEYS: Record<BlockErrorKind, string> = {
  no_access: "kernel.dashboards.blockNoAccess",
  not_allowed: "kernel.dashboards.blockNotAllowed",
  unknown_tool: "kernel.dashboards.blockSourceGone",
  invalid_map: "kernel.dashboards.blockMapInvalid",
  rate_limited: "kernel.dashboards.blockRateLimited",
  source_error: "kernel.dashboards.blockSourceError",
  not_found: "kernel.dashboards.blockNotFound",
  network: "kernel.dashboards.blockNetwork",
}

type T = (key: string, params?: Record<string, string | number>) => string

/** "Updated just now" / "Updated 4 minutes ago", from when the data was read. */
export function updatedAgo(computedAt: string, now: number, t: T, locale: string): string | null {
  const at = Date.parse(computedAt)
  if (!Number.isFinite(at)) return null
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return t("kernel.dashboards.updatedJustNow")
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" })
  const ago =
    sec < 3600
      ? rtf.format(-Math.floor(sec / 60), "minute")
      : sec < 86_400
        ? rtf.format(-Math.floor(sec / 3600), "hour")
        : rtf.format(-Math.floor(sec / 86_400), "day")
  return t("kernel.dashboards.blockUpdatedAgo", { ago })
}

/** A fixed block's own window as a chip: its days, "Since 13 Aug 2026", or "Own period". */
export function ownWindowText(
  window: BlockWindow | undefined,
  t: T,
  locale: string,
): string | null {
  if (window?.mode !== "fixed") return null
  const days = [...new Set(window.dates.map((d) => d.date.slice(0, 10)))].sort()
  if (days.length === 0) return t("kernel.dashboards.ownPeriod")
  if (days.length === 1) return t("kernel.dashboards.since", { date: formatDay(days[0], locale) })
  return formatWindow({ from: days[0], to: days[days.length - 1] }, locale)
}

/** The copy key a block's refusal reads as. */
export function blockErrorKey(kind: BlockErrorKind): string {
  return ERROR_KEYS[kind] ?? ERROR_KEYS.source_error
}

export const BlockCard: Component<BlockCardProps> = (props) => {
  const i18n = useI18n()
  const [data, setData] = createSignal<BlockData | null>(null)
  const [error, setError] = createSignal<Extract<BlockResult, { ok: false }> | null>(null)
  const [busy, setBusy] = createSignal(true)
  const [info, setInfo] = createSignal<BlockReadInfo | undefined>(undefined)
  let seq = 0

  async function read(refresh: boolean): Promise<void> {
    const mine = ++seq
    setBusy(true)
    const result = await props.load(refresh)
    if (mine !== seq) return
    setBusy(false)
    // A refused refresh keeps the figures on screen, and with them when they were read.
    if (result.ok || result.error !== "rate_limited") setInfo(result.info)
    props.onRead?.(result.info)
    if (result.ok) {
      setData(result.data)
      setError(null)
    } else {
      setError(result)
    }
  }

  onMount(() => void read(false))
  createEffect(
    on(
      () => props.refreshTick,
      (tick) => {
        if (tick) void read(true)
      },
      { defer: true },
    ),
  )
  // Another range: the block reads it (from the cache when the server has it).
  createEffect(
    on(
      () => props.rangeKey,
      () => void read(false),
      { defer: true },
    ),
  )
  // Other filter values: the block reads them (a refusal keeps the figures shown).
  createEffect(
    on(
      () => props.filtersKey,
      () => void read(false),
      { defer: true },
    ),
  )
  // A block that asks to stay fresh (`refreshSec`) re-reads on that cadence while the page is
  // on screen; the server's cache lives no longer than that, so a plain read is a new one.
  createEffect(() => {
    const sec = props.block.refreshSec
    if (!props.visible || !sec || sec <= 0) return
    const timer = setInterval(() => {
      if (!busy()) void read(false)
    }, sec * 1000)
    onCleanup(() => clearInterval(timer))
  })

  const locale = () => props.locale ?? i18n.locale()
  const t: T = (key, params) => i18n.t(key, params)
  const ownWindow = () => (props.showOwnWindow ? ownWindowText(info()?.window, t, locale()) : null)
  const compareMode = () => info()?.compareWindow?.mode
  const emptyText = () => {
    const w = info()?.window
    if (w?.mode !== "dashboard") return undefined
    const sameYear = w.from.slice(0, 4) === w.to.slice(0, 4)
    const thisYear = w.to.slice(0, 4) === String(new Date(props.now ?? Date.now()).getFullYear())
    return i18n.t("kernel.dashboards.noDataBetween", {
      from: formatDay(w.from, locale(), !sameYear),
      to: formatDay(w.to, locale(), !thisYear || !sameYear),
    })
  }
  const freshness = () => {
    const at = info()?.computedAt
    return at ? updatedAgo(at, props.now ?? Date.now(), t, locale()) : null
  }

  // A refusal to refresh again so soon keeps the figures already on screen.
  const keepsData = () => error()?.error === "rate_limited" && data() !== null
  const status = (): BlockStatus =>
    error() && !keepsData() ? "error" : data() ? "ready" : busy() ? "loading" : "error"

  return (
    <section
      data-testid={`dashboard-block-${props.block.id}`}
      data-block-type={props.block.type}
      data-state={status()}
      data-error={error()?.error}
      aria-busy={busy() ? "true" : undefined}
      class={cn(
        "flex min-w-0 flex-col rounded-lg border border-border-subtle bg-surface p-3",
        props.class,
      )}
    >
      <header class="mb-1 flex items-center gap-2">
        <h2
          data-testid="dashboard-block-title"
          class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-secondary"
          title={props.block.title}
        >
          {props.block.title}
        </h2>
        <Show when={ownWindow()}>
          {(text) => (
            <span
              data-testid={`dashboard-block-window-${props.block.id}`}
              title={i18n.t("kernel.dashboards.ownWindowHint")}
              class="max-w-[50%] shrink-0 truncate rounded-full border border-border-subtle px-2 py-0.5 text-[11px] tabular-nums text-text-tertiary"
            >
              {text()}
            </span>
          )}
        </Show>
        <Show when={props.onDrill && props.block.type !== "text"}>
          <button
            type="button"
            data-testid={`dashboard-block-rows-${props.block.id}`}
            aria-label={i18n.t("kernel.dashboards.drillShowAll")}
            title={i18n.t("kernel.dashboards.drillShowAll")}
            onClick={() => props.onDrill?.({})}
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <Rows3 size={13} />
          </button>
        </Show>
        <button
          type="button"
          data-testid={`dashboard-block-refresh-${props.block.id}`}
          aria-label={i18n.t("kernel.dashboards.refreshBlock")}
          title={i18n.t("kernel.dashboards.refreshBlock")}
          disabled={busy()}
          onClick={() => void read(true)}
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary disabled:opacity-50"
        >
          <RefreshCw size={13} class={busy() ? "animate-spin" : undefined} />
        </button>
      </header>
      <Switch>
        <Match when={status() === "loading"}>
          <div data-testid="dashboard-block-skeleton" class="space-y-2 py-2">
            <Skeleton class="h-6 w-1/2" />
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-3/4" />
          </div>
        </Match>
        <Match when={status() === "error"}>
          <p
            data-testid="dashboard-block-error"
            data-error={error()?.error ?? "source_error"}
            title={error()?.message}
            class="py-4 text-[13px] text-text-tertiary"
          >
            {i18n.t(blockErrorKey(error()?.error ?? "source_error"))}
          </p>
        </Match>
        <Match when={status() === "ready" && data()}>
          {(d) => (
            <>
              <BlockRenderer
                data={d()}
                map={props.block.map}
                title={props.block.title}
                locale={props.locale}
                compareMode={compareMode()}
                emptyText={emptyText()}
                onDrill={props.block.type === "text" ? undefined : props.onDrill}
              />
              <Show when={d().truncated}>
                <p
                  data-testid="dashboard-block-truncated"
                  class="mt-1 text-[11.5px] text-text-tertiary"
                >
                  {i18n.t("kernel.dashboards.blockTruncated")}
                </p>
              </Show>
              <Show when={info()?.skippedRows}>
                {(count) => (
                  <p
                    data-testid="dashboard-block-skipped"
                    class="mt-1 text-[11.5px] text-text-tertiary"
                  >
                    {count() === 1
                      ? i18n.t("kernel.dashboards.skippedRowsOne")
                      : i18n.t("kernel.dashboards.skippedRowsMany", { count: count() })}
                  </p>
                )}
              </Show>
              <Show when={info()?.previousError}>
                <p
                  data-testid="dashboard-block-compare-failed"
                  title={info()?.previousError?.message}
                  class="mt-1 text-[11.5px] text-text-tertiary"
                >
                  {i18n.t("kernel.dashboards.compareFailed")}
                </p>
              </Show>
              <Show when={keepsData()}>
                <p data-testid="dashboard-block-note" class="mt-1 text-[11.5px] text-text-tertiary">
                  {i18n.t("kernel.dashboards.blockRateLimited")}
                </p>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <Show when={status() !== "loading" && freshness()}>
        {(text) => (
          <p
            data-testid={`dashboard-block-updated-${props.block.id}`}
            title={info()?.computedAt}
            class="mt-auto pt-2 text-[11px] text-text-tertiary"
          >
            {text()}
          </p>
        )}
      </Show>
    </section>
  )
}
