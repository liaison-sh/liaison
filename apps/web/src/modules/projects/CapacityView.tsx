// SPDX-License-Identifier: FSL-1.1-ALv2
// The capacity tab: this week's planned time against available time per person, in name order,
// on the projects that use time and budgets. Calm: no sort, no colour by load, no percent, and a
// colleague's day off shows only as a smaller available figure.
import { formatDuration } from "@liaison/shared"
import { type Component, createResource, For, Match, Show, Switch } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface CapacityData {
  week: string
  title: string
  people: Array<{
    userId: string
    name: string
    availableMinutes: number
    plannedMinutes: number
    note: string | null
  }>
  left: Array<{ key: string | null; title: string; minutes: number }>
}

const hours = (minutes: number) => formatDuration(minutes, "h")

export const CapacityView: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [data] = createResource(() =>
    runTool<CapacityData>(api, "projects:capacity_get", {}, { suppressGlobalError: true }),
  )
  return (
    <div class="h-full overflow-y-auto px-6 py-5" data-testid="capacity-view">
      <Switch>
        <Match when={data.loading}>
          <p class="text-[13px] text-text-secondary" data-testid="capacity-view.loading">
            {i18n.t("projects.capacity.loading")}
          </p>
        </Match>
        <Match when={data.error || !data()?.people}>
          <p class="text-[13px] text-text-secondary" data-testid="capacity-view.error">
            {i18n.t("projects.capacity.error")}
          </p>
        </Match>
        <Match when={data()}>
          {(d) => (
            <>
              <h2 class="mb-4 text-[15px] font-medium text-text">{d().title}</h2>
              <Show
                when={d().people.length > 0}
                fallback={
                  <p class="text-[13px] text-text-secondary" data-testid="capacity-view.empty">
                    {i18n.t("projects.capacity.empty")}
                  </p>
                }
              >
                <ul class="divide-y divide-border">
                  <For each={d().people}>
                    {(p) => (
                      <li
                        class="flex items-baseline justify-between gap-4 py-2"
                        data-testid="capacity-view.person"
                      >
                        <span class="text-[13.5px] text-text">{p.name}</span>
                        <span class="text-[13px] text-text-secondary">
                          {i18n.t("projects.capacity.of", {
                            planned: hours(p.plannedMinutes),
                            available: hours(p.availableMinutes),
                          })}
                          <Show when={p.note}>{(n) => <span class="ml-3">{n()}</span>}</Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={d().left.length > 0}>
                <div class="mt-4 text-[13px] text-text-secondary" data-testid="capacity-view.left">
                  {i18n.t("projects.capacity.left")}:{" "}
                  {d()
                    .left.map((t) => `${t.key ?? t.title} ${hours(t.minutes)}`)
                    .join(", ")}
                </div>
              </Show>
              <p class="mt-6 text-[12px] text-text-tertiary">
                {i18n.t("projects.capacity.footnote")}
              </p>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
