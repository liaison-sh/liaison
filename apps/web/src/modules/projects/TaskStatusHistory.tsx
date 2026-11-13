// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A task's status history (newest first, collapsed until asked for): each change as
// "From → To", who made it and when. One quiet line under the task's meta row, plain tertiary text: the history is a record, not an alarm.
import { ChevronDown, ChevronRight } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { formatDateTime, relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"

/** One status change, as GET task returns it (service/transitions.ts, TaskTransition). */
export interface TaskTransition {
  id: string
  fromStatusId: string | null
  fromStatusLabel: string | null
  toStatusId: string
  toStatusLabel: string | null
  actorType: "user" | "agent" | "routine" | "system"
  actorId: string | null
  actorName: string | null
  agentId: string | null
  routineId: string | null
  at: string
}

export const TaskStatusHistory: Component<{
  transitions: TaskTransition[] | undefined
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const label = (l: string | null) => l ?? i18n.t("projects.statusHistory.unknownStatus")
  const who = (x: TaskTransition) => {
    if (x.actorType === "agent") return x.actorName ?? i18n.t("projects.statusHistory.byAgent")
    if (x.actorType === "routine") return i18n.t("projects.statusHistory.byRoutine")
    if (x.actorType === "system") return i18n.t("projects.statusHistory.bySystem")
    return x.actorName ?? ""
  }
  return (
    <section data-testid="task-status-history" class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-testid="task-status-history.toggle"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
          class="flex items-center gap-1 self-start text-[11px] uppercase tracking-[0.04em] text-text-tertiary hover:text-text-secondary"
        >
          <Show when={open()} fallback={<ChevronRight class="h-3 w-3" />}>
            <ChevronDown class="h-3 w-3" />
          </Show>
          {i18n.t("projects.statusHistory.title")}
        </button>
      </div>
      <Show when={open()}>
        <Show
          when={(props.transitions ?? []).length > 0}
          fallback={
            <p data-testid="task-status-history.empty" class="text-[12px] text-text-tertiary">
              {i18n.t("projects.statusHistory.empty")}
            </p>
          }
        >
          <ol class="flex flex-col gap-0.5 text-[12px]">
            <For each={props.transitions}>
              {(x) => (
                <li
                  data-testid="task-status-history.item"
                  class="flex flex-wrap items-baseline gap-x-2 text-text-secondary"
                >
                  <span class="text-text">
                    {x.fromStatusId === null
                      ? i18n.t("projects.statusHistory.created", {
                          status: label(x.toStatusLabel),
                        })
                      : i18n.t("projects.statusHistory.moved", {
                          from: label(x.fromStatusLabel),
                          to: label(x.toStatusLabel),
                        })}
                  </span>
                  <Show when={who(x)}>
                    <span class="text-text-tertiary">{who(x)}</span>
                  </Show>
                  <span class="text-text-tertiary" title={formatDateTime(x.at, i18n.locale())}>
                    {relativeTime(x.at, i18n.locale())}
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </section>
  )
}
