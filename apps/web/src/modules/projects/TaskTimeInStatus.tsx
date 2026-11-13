// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The task page's time pieces (owner decision D11): "for 6 d · SLA passed
 * yesterday" beside the status pill, the "Where the time went" strip (one
 * segment per status in the status's own colour, labels below), and
 * "Automations on this task" (the recent flow runs fired on it, a state dot
 * each). Calm: only a deadline an automation keeps tints its words, in the
 * warning or error colour; with no such deadline nothing is said about one.
 */
import { type Component, For, Show } from "solid-js"
import { formatDateTime, relativeTime } from "~/lib/relative-time"
import { runStatusDot } from "~/modules/agent/flow/FlowRunTimeline"
import { runStatusLabel } from "~/modules/agent/routine-status-copy"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ProjectStatus } from "./project-store"
import { statusDot } from "./StatusPill"
import { prettyStatus } from "./status-label"
import type { TaskTransition } from "./TaskStatusHistory"
import { type EntityRun, shortDuration, type TaskDeadline, timeInStatuses } from "./task-time"

/** "for 6 d", then the automation deadline when one applies. */
export const TaskStatusSince: Component<{
  since: string | null | undefined
  deadline: TaskDeadline | null
}> = (props) => {
  const i18n = useI18n()
  const time = () => {
    if (!props.since) return ""
    const ms = Date.now() - new Date(props.since).getTime()
    return Number.isFinite(ms) ? shortDuration(Math.max(0, ms), i18n.t, i18n.locale()) : ""
  }
  /** The deadline as it stands now: one still "ahead" whose time is past has passed (the
   *  automation's resume may not have run yet), so it reads as passed, in the error tone. */
  const kind = () => {
    const d = props.deadline
    if (!d) return null
    if (d.kind === "ahead" && new Date(d.at).getTime() <= Date.now()) return "passed"
    return d.kind
  }
  const deadlineWords = () => {
    const d = props.deadline
    if (!d) return ""
    const when = relativeTime(d.at, i18n.locale(), { style: "long" })
    return kind() === "passed"
      ? i18n.t("projects.taskTime.slaPassed", { when })
      : i18n.t("projects.taskTime.slaAhead", { when })
  }
  // Near: the words stay in the text colour (the warning tone fails AA on small text) with a
  // warning dot beside them.
  const soon = () =>
    kind() === "ahead" && new Date(props.deadline?.at ?? 0).getTime() - Date.now() < 86_400_000
  return (
    <Show when={time()}>
      <span
        data-testid="task-detail.status-since"
        class="text-[12.5px]"
        classList={{
          "text-error": kind() === "passed",
          "text-text-primary": soon(),
          "text-text-secondary": kind() === null || (kind() === "ahead" && !soon()),
        }}
        title={formatDateTime(props.since, i18n.locale())}
      >
        {i18n.t("projects.taskTime.for", { time: time() })}
        <Show when={deadlineWords()}>
          {(w) => (
            <span
              data-testid="task-detail.sla"
              data-sla={kind()}
              title={props.deadline?.routineTitle}
            >
              {" · "}
              <Show when={soon()}>
                <span
                  aria-hidden="true"
                  data-testid="task-detail.sla-soon"
                  class="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle"
                />
              </Show>
              {w()}
            </span>
          )}
        </Show>
      </span>
    </Show>
  )
}

/** "Where the time went": a segment per status the task has been in. */
export const TaskTimeStrip: Component<{
  transitions: TaskTransition[] | undefined
  statuses: readonly ProjectStatus[]
}> = (props) => {
  const i18n = useI18n()
  const segments = () => timeInStatuses(props.transitions).filter((s) => s.ms > 0)
  const total = () => segments().reduce((n, s) => n + s.ms, 0)
  const status = (id: string) => props.statuses.find((s) => s.id === id)
  const label = (s: { statusId: string; label: string | null }) =>
    prettyStatus(
      status(s.statusId)?.label ?? s.label ?? i18n.t("projects.statusHistory.unknownStatus"),
    )
  return (
    <Show when={segments().length > 0 && total() > 0}>
      <section data-testid="task-time-strip" class="flex min-w-0 flex-col gap-1.5">
        <h3 class="text-[12px] text-text-secondary">{i18n.t("projects.taskTime.whereTitle")}</h3>
        <div class="flex h-2 min-w-0 gap-0.5 overflow-hidden rounded" aria-hidden="true">
          <For each={segments()}>
            {(s) => (
              <span
                data-testid={`task-time-strip.segment-${s.statusId}`}
                class="h-2 min-w-[3px]"
                style={{
                  flex: `${s.ms} 1 0`,
                  background: statusDot(status(s.statusId)?.color),
                }}
              />
            )}
          </For>
        </div>
        <div class="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-0.5 text-[12px] text-text-secondary">
          <For each={segments()}>
            {(s) => (
              <span data-testid={`task-time-strip.label-${s.statusId}`}>
                {label(s)} {shortDuration(s.ms, i18n.t, i18n.locale())}
              </span>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

/** "Automations on this task": the recent flow runs fired on it. */
export const TaskAutomationRuns: Component<{ runs: EntityRun[] | undefined }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={(props.runs ?? []).length > 0}>
      <section
        data-testid="task-detail.automations"
        class="flex min-w-0 flex-col gap-2 rounded-lg border border-border-subtle bg-surface-sunken p-3"
      >
        <h3 class="text-[12px] text-text-secondary">
          {i18n.t("projects.taskTime.automationsTitle")}
        </h3>
        <ul class="flex min-w-0 flex-col gap-1.5">
          <For each={props.runs}>
            {(run) => (
              <li
                data-testid={`task-detail.automation-run-${run.id}`}
                data-status={run.status}
                class="flex min-w-0 items-center gap-2 text-[12.5px] text-text"
              >
                <span
                  aria-hidden="true"
                  class={`h-[7px] w-[7px] shrink-0 rounded-full ${runStatusDot(run.status)}`}
                />
                <span class="min-w-0 truncate">{run.routineTitle}</span>
                <span class="shrink-0 text-text-tertiary">
                  {runStatusLabel(i18n.t, run.status)} · {relativeTime(run.ranAt, i18n.locale())}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
