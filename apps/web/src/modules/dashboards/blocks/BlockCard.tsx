// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One block on a grid: its title, its own refresh, and its data or the calm
// reason it has none. A block's failure is its own: the rest of the grid draws.
import { RefreshCw } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  Match,
  on,
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
  BlockResult,
  DashboardBlockSpec,
} from "../dashboards-client"
import { BlockRenderer } from "./BlockRenderer"

export interface BlockCardProps {
  block: DashboardBlockSpec
  /** Reads the block's data; `refresh` asks the server to skip its cache. */
  load: (refresh: boolean) => Promise<BlockResult>
  /** Bumped by the page's Refresh all: each change re-reads the block past the cache. */
  refreshTick?: number
  locale?: string
  class?: string
}

export type BlockStatus = "loading" | "ready" | "error"

const ERROR_KEYS: Record<BlockErrorKind, string> = {
  no_access: "kernel.dashboards.blockNoAccess",
  not_allowed: "kernel.dashboards.blockNotAllowed",
  rate_limited: "kernel.dashboards.blockRateLimited",
  source_error: "kernel.dashboards.blockSourceError",
  not_found: "kernel.dashboards.blockNotFound",
  network: "kernel.dashboards.blockNetwork",
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
  let seq = 0

  async function read(refresh: boolean): Promise<void> {
    const mine = ++seq
    setBusy(true)
    const result = await props.load(refresh)
    if (mine !== seq) return
    setBusy(false)
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
              />
              <Show when={d().truncated}>
                <p
                  data-testid="dashboard-block-truncated"
                  class="mt-1 text-[11.5px] text-text-tertiary"
                >
                  {i18n.t("kernel.dashboards.blockTruncated")}
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
    </section>
  )
}
