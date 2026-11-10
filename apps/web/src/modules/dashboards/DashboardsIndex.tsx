// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARDS PAGE (`/dashboards`), the rail's Dashboards entry: every
// dashboard the viewer can see, their own first, then the org's. With none it
// says what a dashboard is and that the agent builds them. The list is the
// store's, so it stays live (a dashboard shared, renamed or deleted elsewhere
// shows here without a reload).
import { LayoutGrid } from "lucide-solid"
import { type Component, For, Match, onMount, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"
import { dashboardsList, dashboardsLoaded, loadDashboards, openDashboard } from "./dashboards-store"

export const DashboardsIndex: Component = () => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  onMount(() => void loadDashboards(api))

  return (
    <section data-testid="dashboards-index" class="flex h-full min-h-0 min-w-0 flex-col">
      <header
        data-testid="dashboards-index-header"
        class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5"
      >
        <h1 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">
          {t("kernel.nav.dashboards")}
        </h1>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Switch>
          <Match when={dashboardsList().length > 0}>
            <ul data-testid="dashboards-index-list" class="mx-auto max-w-2xl space-y-1">
              <For each={dashboardsList()}>
                {(d) => (
                  <li>
                    <button
                      type="button"
                      data-testid={`dashboards-index-row-${d.id}`}
                      title={d.title}
                      onClick={() => openDashboard(d)}
                      class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-text-secondary transition-colors hover:bg-surface-hover"
                    >
                      <span class="flex w-4 shrink-0 justify-center text-text-tertiary">
                        <LayoutGrid size={14} />
                      </span>
                      <span class="min-w-0 flex-1 truncate">{d.title}</span>
                      <span
                        data-testid={`dashboards-index-row-${d.id}-visibility`}
                        class="shrink-0 text-[11px] text-text-tertiary"
                      >
                        {d.visibility === "org"
                          ? t("kernel.dashboards.visibilityOrg")
                          : t("kernel.dashboards.visibilityPersonal")}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Match>
          <Match when={!dashboardsLoaded()}>
            <div data-testid="dashboards-index-loading" class="mx-auto max-w-2xl space-y-2">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
          </Match>
          <Match when={true}>
            <div data-testid="dashboards-index-empty" class="mx-auto max-w-md py-10 text-center">
              <p class="text-[13px] font-medium text-text-secondary">
                {t("kernel.dashboards.indexEmptyTitle")}
              </p>
              <p class="mt-2 text-[12.5px] text-text-tertiary">
                {t("kernel.dashboards.indexEmptyBody")}
              </p>
              <p
                data-testid="dashboards-index-empty-hint"
                class="mt-2 text-[12.5px] text-text-tertiary"
              >
                {t("kernel.dashboards.indexEmptyHint")}
              </p>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  )
}

export default DashboardsIndex
