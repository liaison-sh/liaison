// SPDX-License-Identifier: FSL-1.1-ALv2
// The capacity tab: one week of planned time against available time per person, in name order,
// on the projects that use time and budgets. A person's row opens onto the tasks that make up
// their planned time, and "Who can take this?" asks the agent about one of them. Calm: no sort
// control, no colour by load, no percent, no comparison to real time, and a colleague's day off
// shows only as a smaller available figure. Nothing here moves a task.
import { formatDuration } from "@liaison/shared"
import { ChevronDown, ChevronRight } from "lucide-solid"
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { dock } from "~/modules/shell/dock-prefill"
import { Button } from "~/ui/Button"

interface CapacityTask {
  key: string | null
  title: string
  minutes: number
}

interface CapacityData {
  week: string
  title: string
  availableMinutes: number
  plannedMinutes: number
  overLine: string | null
  people: Array<{
    userId: string
    name: string
    availableMinutes: number
    plannedMinutes: number
    note: string | null
    tasks?: CapacityTask[]
  }>
  left: CapacityTask[]
}

const hours = (minutes: number) => formatDuration(minutes, "h")

export const CapacityView: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [data, { refetch }] = createResource(() =>
    runTool<CapacityData>(api, "projects:capacity_get", {}, { suppressGlobalError: true }),
  )
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const whoCanTake = (task: CapacityTask) =>
    void dock.prefill(
      i18n.t("projects.capacity.whoMessage", {
        task: task.key ? `${task.key}, ${task.title}` : task.title,
      }),
      api,
    )

  return (
    <div class="h-full overflow-y-auto px-6 py-5 pb-dock-runway" data-testid="capacity-view">
      <Switch>
        <Match when={data.loading}>
          <p class="text-[13px] text-text-secondary" data-testid="capacity-view.loading">
            {i18n.t("projects.capacity.loading")}
          </p>
        </Match>
        <Match when={data.error || !data()?.people}>
          <div class="flex flex-col items-start gap-2" data-testid="capacity-view.error">
            <p class="text-[13px] text-text-secondary">{i18n.t("projects.capacity.error")}</p>
            <Button
              variant="outline"
              size="sm"
              data-testid="capacity-view.retry"
              onClick={() => void refetch()}
            >
              {i18n.t("projects.capacity.retry")}
            </Button>
          </div>
        </Match>
        <Match when={data()}>
          {(d) => (
            <>
              <h2 class="text-[15px] font-medium text-text">{d().title}</h2>
              <Show
                when={d().people.length > 0}
                fallback={
                  <div class="mt-3 space-y-1" data-testid="capacity-view.no-timeboxes">
                    <p class="text-[13px] text-text">{i18n.t("projects.capacity.emptyTitle")}</p>
                    <p class="text-[13px] text-text-secondary">
                      {i18n.t("projects.capacity.emptyBody")}
                    </p>
                  </div>
                }
              >
                <p class="mt-1 text-[13px] text-text-secondary" data-testid="capacity-view.summary">
                  {i18n.t("projects.capacity.summary", {
                    planned: hours(d().plannedMinutes),
                    available: hours(d().availableMinutes),
                  })}
                </p>
                <Show when={d().overLine}>
                  {(line) => (
                    <p
                      class="mt-1 text-[13px] text-text-secondary"
                      data-testid="capacity-view.over-line"
                    >
                      {line()}
                    </p>
                  )}
                </Show>
                <ul class="mt-4 divide-y divide-border" data-testid="capacity-view.people">
                  <For each={d().people}>
                    {(p) => {
                      const tasks = () => p.tasks ?? []
                      return (
                        <li data-testid="capacity-view.person">
                          <div class="flex items-baseline justify-between gap-4 py-2">
                            <Show
                              when={tasks().length > 0}
                              fallback={<span class="text-[13.5px] text-text">{p.name}</span>}
                            >
                              <button
                                type="button"
                                class="flex items-center gap-1.5 text-left text-[13.5px] text-text"
                                aria-expanded={open().has(p.userId)}
                                data-testid="capacity-view.person-toggle"
                                onClick={() => toggle(p.userId)}
                              >
                                <Show
                                  when={open().has(p.userId)}
                                  fallback={<ChevronRight aria-hidden="true" class="h-3 w-3" />}
                                >
                                  <ChevronDown aria-hidden="true" class="h-3 w-3" />
                                </Show>
                                {p.name}
                              </button>
                            </Show>
                            <span
                              class="text-[13px] text-text-secondary"
                              data-testid="capacity-view.figures"
                            >
                              {i18n.t("projects.capacity.of", {
                                planned: hours(p.plannedMinutes),
                                available: hours(p.availableMinutes),
                              })}
                              <Show when={p.note}>
                                {(n) => (
                                  <span class="ml-3" data-testid="capacity-view.note">
                                    {n()}
                                  </span>
                                )}
                              </Show>
                            </span>
                          </div>
                          <Show when={open().has(p.userId)}>
                            <ul class="mb-2 ml-5 space-y-1" data-testid="capacity-view.tasks">
                              <For each={tasks()}>
                                {(t) => (
                                  <li
                                    class="flex items-baseline justify-between gap-3 text-[12.5px]"
                                    data-testid="capacity-view.task"
                                  >
                                    <span class="min-w-0 truncate text-text-secondary">
                                      <Show when={t.key}>
                                        <span class="mr-1.5 font-mono text-[11px] text-text-tertiary">
                                          {t.key}
                                        </span>
                                      </Show>
                                      {t.title}
                                    </span>
                                    <span class="flex shrink-0 items-baseline gap-3">
                                      <span class="text-text-secondary">{hours(t.minutes)}</span>
                                      <button
                                        type="button"
                                        class="text-[12px] text-text-secondary underline-offset-2 hover:text-text hover:underline"
                                        data-testid="capacity-view.who-can-take"
                                        onClick={() => whoCanTake(t)}
                                      >
                                        {i18n.t("projects.capacity.whoCanTake")}
                                      </button>
                                    </span>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </li>
                      )
                    }}
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
              <div class="mt-6 space-y-1 text-[12px] text-text-tertiary">
                <p data-testid="capacity-view.footnote">{i18n.t("projects.capacity.footnote")}</p>
                <p data-testid="capacity-view.footnote-days">
                  {i18n.t("projects.capacity.footnoteDays")}
                </p>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
