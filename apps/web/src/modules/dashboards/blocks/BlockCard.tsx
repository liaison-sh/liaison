// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One block on a grid: its title, its own refresh, and its data or the calm
// reason it has none. A block's failure is its own: the rest of the grid draws.
// Under the data: when it was read ("Updated 4 min ago"), and rows the server
// left out. A block that keeps its own window while the dashboard has a range
// shows that window as a chip beside its title.
//
// Its menu (the dots) downloads its data or the rows behind it as CSV. In the dashboard's edit
// mode the block can also be renamed in place, moved (drag it, or the arrow buttons from the
// keyboard), resized, duplicated and deleted (after a light confirm).
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  GripVertical,
  MoreHorizontal,
  RefreshCw,
  Rows3,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { PopupMenu } from "~/ui/PopupMenu"
import { Skeleton } from "~/ui/Skeleton"
import type {
  BlockData,
  BlockErrorKind,
  BlockHeight,
  BlockReadInfo,
  BlockResult,
  BlockWidth,
  BlockWindow,
  DashboardBlockSpec,
  DrillTarget,
} from "../dashboards-client"
import type { MoveDirection } from "../edit-mode"
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
  /** Today in the org's time zone (YYYY-MM-DD): "this year" in the empty state follows it. */
  today?: string
  /** The org's time zone: timestamps read in it. */
  timeZone?: string
  /** Downloads the block's mapped data or the rows behind it as CSV. */
  onExport?: (kind: "data" | "rows") => void
  /** The dashboard is in edit mode: these change the block. */
  edit?: BlockEditActions
}

/** What edit mode can do to a block; each is one operation sent to the server. */
export interface BlockEditActions {
  rename: (title: string) => void
  /** False when the block cannot move that way (first, last, top or bottom row). */
  canMove: (direction: MoveDirection) => boolean
  move: (direction: MoveDirection) => void
  resize: (size: { width?: BlockWidth; height?: BlockHeight }) => void
  duplicate: () => void
  remove: () => void
  /** Drag and drop: this block is picked up, or another one is dropped on it. */
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: () => void
  /** A change is being saved: the controls wait. */
  busy?: boolean
}

const MOVES: { dir: MoveDirection; key: string; icon: typeof ArrowUp }[] = [
  { dir: "left", key: "kernel.dashboards.moveLeft", icon: ArrowLeft },
  { dir: "up", key: "kernel.dashboards.moveUp", icon: ArrowUp },
  { dir: "down", key: "kernel.dashboards.moveDown", icon: ArrowDown },
  { dir: "right", key: "kernel.dashboards.moveRight", icon: ArrowRight },
]

/** The card's minimum height for its grid rows: a two-row block is about twice as tall. */
export function blockHeightClass(height: BlockHeight | undefined): string {
  return height === 2 ? "@2xl:row-span-2 min-h-[30rem]" : ""
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
    const year = props.today?.slice(0, 4) ?? String(new Date(props.now ?? Date.now()).getFullYear())
    const thisYear = w.to.slice(0, 4) === year
    return i18n.t("kernel.dashboards.noDataBetween", {
      from: formatDay(w.from, locale(), !sameYear),
      to: formatDay(w.to, locale(), !thisYear || !sameYear),
    })
  }
  const freshness = () => {
    const at = info()?.computedAt
    return at ? updatedAgo(at, props.now ?? Date.now(), t, locale()) : null
  }

  // A metric read from one object (not a list) has no rows behind it: nothing to drill into.
  const drillable = () =>
    !!props.onDrill &&
    props.block.type !== "text" &&
    !props.edit &&
    !(data()?.kind === "metric" && info()?.sourceRows === 0)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [dropping, setDropping] = createSignal(false)
  const hasMenu = () => !!props.edit || (!!props.onExport && props.block.type !== "text")
  let titleInput: HTMLInputElement | undefined
  const commitTitle = (raw: string) => {
    const v = raw.trim()
    if (!v) {
      if (titleInput) titleInput.value = props.block.title
      return
    }
    if (v !== props.block.title) props.edit?.rename(v)
  }

  // A refusal to refresh again so soon keeps the figures already on screen.
  const keepsData = () => error()?.error === "rate_limited" && data() !== null
  const status = (): BlockStatus =>
    error() && !keepsData() ? "error" : data() ? "ready" : busy() ? "loading" : "error"

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is the pointer path; the arrow buttons are its keyboard equivalent
    <section
      data-testid={`dashboard-block-${props.block.id}`}
      data-block-type={props.block.type}
      data-state={status()}
      data-error={error()?.error}
      data-editing={props.edit ? "true" : undefined}
      data-width={props.block.width}
      data-height={props.block.height ?? 1}
      aria-busy={busy() ? "true" : undefined}
      draggable={props.edit ? true : undefined}
      onDragStart={(e) => {
        if (!props.edit) return
        e.dataTransfer?.setData("text/plain", props.block.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
        props.edit.onDragStart()
      }}
      onDragEnd={() => {
        setDropping(false)
        props.edit?.onDragEnd()
      }}
      onDragOver={(e) => {
        if (!props.edit) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!props.edit) return
        e.preventDefault()
        setDropping(false)
        props.edit.onDrop()
      }}
      class={cn(
        "flex min-w-0 flex-col rounded-lg border border-border-subtle bg-surface p-3",
        props.edit && "border-dashed",
        dropping() && "border-accent",
        blockHeightClass(props.block.height),
        props.class,
      )}
    >
      <header class="mb-1 flex items-center gap-2">
        <Show
          when={props.edit}
          fallback={
            <h2
              data-testid="dashboard-block-title"
              class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-secondary"
              title={props.block.title}
            >
              {props.block.title}
            </h2>
          }
        >
          <span
            data-testid={`dashboard-block-grip-${props.block.id}`}
            aria-hidden="true"
            title={i18n.t("kernel.dashboards.dragHint")}
            class="flex shrink-0 cursor-grab text-text-tertiary"
          >
            <GripVertical size={14} />
          </span>
          <input
            ref={titleInput}
            data-testid={`dashboard-block-title-input-${props.block.id}`}
            aria-label={i18n.t("kernel.dashboards.blockTitleLabel")}
            value={props.block.title}
            maxLength={120}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commitTitle(e.currentTarget.value)
              } else if (e.key === "Escape") {
                e.currentTarget.value = props.block.title
                e.currentTarget.blur()
              }
            }}
            onBlur={(e) => commitTitle(e.currentTarget.value)}
            class="h-7 min-w-0 flex-1 rounded border border-border-subtle bg-bg px-2 text-[13px] font-medium text-text outline-none focus:border-accent"
          />
        </Show>
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
        <Show when={drillable()}>
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
        <Show when={props.edit}>
          {(edit) => (
            <fieldset
              aria-label={i18n.t("kernel.dashboards.moveGroup")}
              class="m-0 flex shrink-0 items-center border-0 p-0"
            >
              <For each={MOVES}>
                {(m) => (
                  <button
                    type="button"
                    data-testid={`dashboard-block-move-${m.dir}-${props.block.id}`}
                    aria-label={i18n.t(m.key)}
                    title={i18n.t(m.key)}
                    disabled={edit().busy || !edit().canMove(m.dir)}
                    onClick={() => edit().move(m.dir)}
                    class="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary disabled:opacity-30"
                  >
                    <m.icon size={13} />
                  </button>
                )}
              </For>
            </fieldset>
          )}
        </Show>
        <Show when={hasMenu()}>
          <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
            <PopupMenu.Trigger
              data-testid={`dashboard-block-menu-${props.block.id}`}
              aria-label={i18n.t("kernel.dashboards.blockMenu")}
              title={i18n.t("kernel.dashboards.blockMenu")}
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
            >
              <MoreHorizontal size={14} />
            </PopupMenu.Trigger>
            <PopupMenu.Content data-testid={`dashboard-block-menu-content-${props.block.id}`}>
              <Show when={props.onExport && props.block.type !== "text"}>
                <PopupMenu.Group>
                  <PopupMenu.Label>{i18n.t("kernel.dashboards.exportLabel")}</PopupMenu.Label>
                  <PopupMenu.Item
                    data-testid={`dashboard-block-csv-data-${props.block.id}`}
                    onSelect={() => props.onExport?.("data")}
                  >
                    {i18n.t("kernel.dashboards.exportBlockData")}
                  </PopupMenu.Item>
                  <PopupMenu.Item
                    data-testid={`dashboard-block-csv-rows-${props.block.id}`}
                    onSelect={() => props.onExport?.("rows")}
                  >
                    {i18n.t("kernel.dashboards.exportBlockRows")}
                  </PopupMenu.Item>
                </PopupMenu.Group>
              </Show>
              <Show when={props.edit}>
                {(edit) => (
                  <>
                    <Show when={props.onExport && props.block.type !== "text"}>
                      <PopupMenu.Separator />
                    </Show>
                    <PopupMenu.Group>
                      <PopupMenu.Label>{i18n.t("kernel.dashboards.widthLabel")}</PopupMenu.Label>
                      <For each={[1, 2, 3] as BlockWidth[]}>
                        {(w) => (
                          <PopupMenu.Item
                            data-testid={`dashboard-block-width-${w}-${props.block.id}`}
                            disabled={edit().busy}
                            onSelect={() => {
                              if (w !== props.block.width) edit().resize({ width: w })
                            }}
                          >
                            <Check
                              size={13}
                              aria-hidden="true"
                              class={props.block.width === w ? "" : "invisible"}
                            />
                            {i18n.t(
                              w === 1
                                ? "kernel.dashboards.widthOne"
                                : "kernel.dashboards.widthMany",
                              { count: w },
                            )}
                          </PopupMenu.Item>
                        )}
                      </For>
                    </PopupMenu.Group>
                    <PopupMenu.Group>
                      <PopupMenu.Label>{i18n.t("kernel.dashboards.heightLabel")}</PopupMenu.Label>
                      <For each={[1, 2] as BlockHeight[]}>
                        {(h) => (
                          <PopupMenu.Item
                            data-testid={`dashboard-block-height-${h}-${props.block.id}`}
                            disabled={edit().busy}
                            onSelect={() => {
                              if (h !== (props.block.height ?? 1)) edit().resize({ height: h })
                            }}
                          >
                            <Check
                              size={13}
                              aria-hidden="true"
                              class={(props.block.height ?? 1) === h ? "" : "invisible"}
                            />
                            {i18n.t(
                              h === 1
                                ? "kernel.dashboards.heightOne"
                                : "kernel.dashboards.heightTwo",
                            )}
                          </PopupMenu.Item>
                        )}
                      </For>
                    </PopupMenu.Group>
                    <PopupMenu.Separator />
                    <PopupMenu.Item
                      data-testid={`dashboard-block-duplicate-${props.block.id}`}
                      disabled={edit().busy}
                      onSelect={() => edit().duplicate()}
                    >
                      {i18n.t("kernel.dashboards.duplicateBlock")}
                    </PopupMenu.Item>
                    <PopupMenu.Item
                      data-testid={`dashboard-block-delete-${props.block.id}`}
                      variant="danger"
                      disabled={edit().busy}
                      onSelect={() => setConfirmDelete(true)}
                    >
                      {i18n.t("kernel.dashboards.deleteBlock")}
                    </PopupMenu.Item>
                  </>
                )}
              </Show>
            </PopupMenu.Content>
          </PopupMenu>
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
                onDrill={drillable() ? props.onDrill : undefined}
                timeZone={props.timeZone}
                tall={props.block.height === 2}
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
      <Dialog open={confirmDelete()} onOpenChange={setConfirmDelete}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.dashboards.deleteBlockTitle")}</Dialog.Title>
          <p data-testid="dashboard-block-delete-text" class="mt-3 text-[13px] text-text-secondary">
            {i18n.t("kernel.dashboards.deleteBlockBody", { title: props.block.title })}
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="dashboard-block-delete-cancel"
              onClick={() => setConfirmDelete(false)}
            >
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="dashboard-block-delete-confirm"
              onClick={() => {
                setConfirmDelete(false)
                props.edit?.remove()
              }}
            >
              {i18n.t("kernel.common.delete")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </section>
  )
}
