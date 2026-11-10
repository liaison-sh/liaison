// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD TAB (`/dashboard/:id`). A toolbar at the top (title, who sees
// it, Refresh all), then the blocks on a grid by their width: one column on a
// phone, up to three on a wide panel. Each block reads its own data as the
// viewer and fails alone.
import { RefreshCw } from "lucide-solid"
import {
  type Component,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Switch,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { BlockCard } from "./blocks/BlockCard"
import {
  type Dashboard,
  type DashboardBlockSpec,
  getBlockData,
  getDashboard,
} from "./dashboards-client"
import { dashboardRevision, reloadDashboard, rememberDashboard } from "./dashboards-store"

/** The grid span of a block's width, against the panel's own width (container queries). */
export function blockSpanClass(width: DashboardBlockSpec["width"]): string {
  if (width === 3) return "@2xl:col-span-2 @5xl:col-span-3"
  if (width === 2) return "@2xl:col-span-2"
  return ""
}

export const DashboardView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [tick, setTick] = createSignal(0)
  // Closing the tab cancels its block reads, queued or running, here and on the server.
  const reads = new AbortController()
  onCleanup(() => reads.abort())
  let shown: Dashboard | null = null

  // Keyed on the read revision too: an agent's open after a change, or Refresh all, reads the
  // spec again, and blocks added, removed or remapped show at once.
  const [dashboard] = createResource(
    () => [props.entityId, dashboardRevision(props.entityId)] as const,
    async ([id]) => {
      try {
        const d = await getDashboard(api, id)
        rememberDashboard(d)
        // The same version keeps the same object, so its blocks stay mounted (Refresh all then
        // refreshes them in place); a new version remounts them on the new spec.
        if (shown?.id !== d.id || shown.version !== d.version) shown = d
        return { ok: true as const, dashboard: shown }
      } catch (err) {
        const missing = err instanceof ApiError && (err.status === 404 || err.status === 403)
        return { ok: false as const, missing }
      }
    },
  )
  const loaded = () => {
    const r = dashboard()
    return r?.ok ? r.dashboard : null
  }

  return (
    <section data-testid="dashboard-view" class="flex h-full min-h-0 min-w-0 flex-col">
      <header
        data-testid="dashboard-toolbar"
        class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5"
      >
        <h1
          data-testid="dashboard-title"
          class="min-w-0 flex-1 truncate text-[14px] font-semibold text-text"
        >
          {loaded()?.title ?? ""}
        </h1>
        <Switch>
          <Match when={loaded()}>
            {(d) => (
              <>
                <span
                  data-testid="dashboard-visibility"
                  data-visibility={d().visibility}
                  class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-tertiary"
                >
                  {d().visibility === "org"
                    ? i18n.t("kernel.dashboards.visibilityOrg")
                    : i18n.t("kernel.dashboards.visibilityPersonal")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="dashboard-refresh-all"
                  disabled={d().spec.blocks.length === 0}
                  onClick={() => {
                    reloadDashboard(d().id)
                    setTick((t) => t + 1)
                  }}
                >
                  <RefreshCw size={13} />
                  {i18n.t("kernel.dashboards.refreshAll")}
                </Button>
              </>
            )}
          </Match>
        </Switch>
      </header>
      <div class="@container min-h-0 flex-1 overflow-y-auto p-4">
        <Switch>
          <Match when={dashboard.loading && !dashboard()}>
            <div data-testid="dashboard-loading" class="space-y-3">
              <Skeleton class="h-24 w-full" />
              <Skeleton class="h-24 w-full" />
            </div>
          </Match>
          <Match when={dashboard() && !dashboard()?.ok}>
            <p
              data-testid="dashboard-not-found"
              class="py-8 text-center text-[13px] text-text-tertiary"
            >
              {(dashboard() as { missing?: boolean })?.missing
                ? i18n.t("kernel.dashboards.notFound")
                : i18n.t("kernel.dashboards.loadFailed")}
            </p>
          </Match>
          <Match when={loaded() && loaded()?.spec.blocks.length === 0}>
            <div data-testid="dashboard-empty" class="py-10 text-center">
              <p class="text-[13px] text-text-secondary">
                {i18n.t("kernel.dashboards.emptyTitle")}
              </p>
              <p class="mt-1 text-[12.5px] text-text-tertiary">
                {i18n.t("kernel.dashboards.emptyHint")}
              </p>
            </div>
          </Match>
          <Match when={loaded()}>
            {(d) => (
              <div
                data-testid="dashboard-grid"
                class="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3"
              >
                <For each={d().spec.blocks}>
                  {(block) => (
                    <BlockCard
                      block={block}
                      class={cn(blockSpanClass(block.width))}
                      refreshTick={tick()}
                      load={(refresh) =>
                        getBlockData(api, d().id, block.id, { refresh, signal: reads.signal })
                      }
                    />
                  )}
                </For>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </section>
  )
}

export default DashboardView
