// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARDS PAGE (`/dashboards`), the rail's Dashboards entry: every
// dashboard the viewer can see as a card (who sees it, its blocks, when it
// changed), their own first, then the ones others share with the team. With none it
// says what a dashboard is and that the agent builds them. The list is the
// store's, so it stays live (a dashboard shared, renamed or deleted elsewhere
// shows here without a reload).
import { LayoutGrid } from "lucide-solid"
import { type Component, For, Match, onMount, Show, Switch } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"
import type { DashboardSummary } from "./dashboards-client"
import {
  dashboardsList,
  dashboardsLoaded,
  loadDashboards,
  openDashboard,
  splitDashboards,
} from "./dashboards-store"

export const DashboardsIndex: Component = () => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  onMount(() => void loadDashboards(api))
  const groups = () => splitDashboards(dashboardsList(), userFromToken()?.userId ?? "")

  /** Who sees it, how many blocks, when it last changed: one line under the title. */
  const meta = (d: DashboardSummary) => {
    const who =
      d.visibility === "personal"
        ? t("kernel.dashboards.onlyYou")
        : d.ownerUserId === userFromToken()?.userId
          ? t("kernel.dashboards.sharedWithTeam")
          : d.ownerName
            ? t("kernel.dashboards.byOwner", { name: d.ownerName })
            : t("kernel.dashboards.sharedWithTeam")
    const parts = [who]
    if (d.blockCount !== undefined)
      parts.push(
        t(
          d.blockCount === 1
            ? "kernel.dashboards.blockCountOne"
            : "kernel.dashboards.blockCountMany",
          {
            count: d.blockCount,
          },
        ),
      )
    const age = d.updatedAt ? relativeTime(d.updatedAt, i18n.locale()) : ""
    if (age) parts.push(t("kernel.dashboards.updatedAgo", { age }))
    return parts.join(" · ")
  }

  const Group: Component<{ testid: string; label: string; rows: DashboardSummary[] }> = (props) => (
    <Show when={props.rows.length > 0}>
      <section data-testid={props.testid}>
        <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
          {props.label}
        </h2>
        <ul class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          <For each={props.rows}>
            {(d) => (
              <li>
                <button
                  type="button"
                  data-testid={`dashboards-index-row-${d.id}`}
                  title={d.title}
                  onClick={() => openDashboard(d)}
                  class="flex h-full w-full flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover"
                >
                  <span class="flex items-center gap-2">
                    <span class="flex w-4 shrink-0 justify-center text-text-tertiary">
                      <LayoutGrid size={14} />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
                      {d.title}
                    </span>
                  </span>
                  <span
                    data-testid={`dashboards-index-row-${d.id}-meta`}
                    class="pl-6 text-[11.5px] text-text-tertiary"
                  >
                    {meta(d)}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )

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
            <div data-testid="dashboards-index-list" class="mx-auto max-w-5xl space-y-6">
              <Group
                testid="dashboards-index-yours"
                label={t("kernel.dashboards.sectionYours")}
                rows={groups().yours}
              />
              <Group
                testid="dashboards-index-team"
                label={t("kernel.dashboards.sectionTeam")}
                rows={groups().team}
              />
            </div>
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
