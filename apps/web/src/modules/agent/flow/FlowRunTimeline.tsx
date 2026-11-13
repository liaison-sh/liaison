// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One flow run as a timeline (owner decision D11): the run's state chip
 * ("waiting · resumes Mon 10:12" in a warning wash), a segmented progress strip
 * (one segment per step), then the trigger and every step with a state dot:
 * done in the success colour, waiting as a hollow warning ring, failed in the
 * error colour, flagged as an error ring, skipped and not reached muted. An
 * agent step's note (a nudge, a missed outcome) sits in a note box under the
 * timeline, so the line it explains reads as one sentence.
 */
import type { RoutineFlow, RoutineFlowStep } from "@liaison/shared"
import { type Component, For, Show } from "solid-js"
import { formatDateTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  describeStep,
  type FlowNames,
  type FlowRunStep,
  runStateFor,
  runSummary,
} from "./flow-model"
import { StatusText } from "./StatusText"

type State = FlowRunStep["state"]

/** A middle dot before an item, drawn by CSS so the item's own text stays clean. */
const SEP = "before:mr-1.5 before:content-['·']"

/** The dot of one state: a fill, or a ring on the surface. */
export const STATE_DOT: Record<State, string> = {
  done: "bg-success",
  running: "bg-accent",
  awaiting_approval: "bg-accent",
  waiting: "bg-surface shadow-[inset_0_0_0_2px_var(--color-warning)]",
  failed: "bg-error",
  flagged: "bg-surface shadow-[inset_0_0_0_2px_var(--color-error)]",
  skipped: "bg-border-strong",
  pending: "bg-border",
}

/** A progress segment of one state. */
export const STATE_SEGMENT: Record<State, string> = {
  done: "bg-success",
  running: "bg-accent",
  awaiting_approval: "bg-accent",
  waiting: "bg-warning",
  failed: "bg-error",
  flagged: "bg-error",
  skipped: "bg-border-strong",
  pending: "bg-border",
}

interface Props {
  flow: RoutineFlow
  names: FlowNames
  runSteps: ReadonlyArray<FlowRunStep>
  triggerWords: string
  testid: string
}

export const FlowRunTimeline: Component<Props> = (props) => {
  const i18n = useI18n()
  const tid = () => props.testid
  const at = (iso: string) =>
    formatDateTime(iso, i18n.locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" })
  const summary = () => runSummary(props.flow, props.runSteps)
  const stateOf = (s: RoutineFlowStep): State =>
    runStateFor(props.runSteps, s.id)?.state ?? "pending"
  const started = () => props.runSteps.find((s) => s.startedAt)?.startedAt ?? null
  const agentNotes = () =>
    props.flow.steps.flatMap((s) => {
      const r = runStateFor(props.runSteps, s.id)
      return s.type === "agent" && r?.note ? [{ id: s.id, note: r.note }] : []
    })

  const chipClass = () => {
    switch (summary().kind) {
      case "waiting":
        return "bg-warning/15 text-warning"
      case "failed":
      case "flagged":
        return "bg-error/15 text-error"
      case "done":
        return "bg-success/15 text-success"
      default:
        return "bg-surface-hover text-text-secondary"
    }
  }
  const chipDot = () => {
    switch (summary().kind) {
      case "waiting":
        return "bg-warning"
      case "failed":
      case "flagged":
        return "bg-error"
      case "done":
        return "bg-success"
      case "running":
        return "bg-accent"
      default:
        return "bg-border-strong"
    }
  }
  const chipWords = () => {
    const s = summary()
    if (s.kind === "waiting") {
      return s.resumesAt
        ? i18n.t("kernel.routineFlow.runWaitingResumes", { when: at(s.resumesAt) })
        : i18n.t("kernel.routineFlow.state_waiting")
    }
    return i18n.t(`kernel.routineFlow.run_${s.kind}`)
  }

  return (
    <div data-testid={`${tid()}-run`} class="flex min-w-0 flex-col gap-3">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span
          data-testid={`${tid()}-run-chip`}
          data-run-state={summary().kind}
          class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] ${chipClass()}`}
        >
          <span aria-hidden="true" class={`h-[7px] w-[7px] rounded-full ${chipDot()}`} />
          {chipWords()}
        </span>
      </div>
      <div data-testid={`${tid()}-run-progress`} class="flex min-w-0 gap-1" aria-hidden="true">
        <For each={props.flow.steps}>
          {(s) => (
            <span
              data-state={stateOf(s)}
              class={`h-1 flex-1 rounded-sm ${STATE_SEGMENT[stateOf(s)]}`}
            />
          )}
        </For>
      </div>
      <ol data-testid={`${tid()}-steps`} class="flex min-w-0 flex-col">
        <li data-testid={`${tid()}-run-trigger`} class="flex min-w-0 gap-3">
          <div class="flex w-3.5 flex-none flex-col items-center" aria-hidden="true">
            <span
              class={`mt-[5px] h-2.5 w-2.5 rounded-full ${props.runSteps.length > 0 ? "bg-success" : "bg-border"}`}
            />
            <span class="w-0.5 flex-1 bg-border-subtle" />
          </div>
          <div class="flex min-w-0 flex-col gap-0.5 pb-3.5">
            <span class="break-words text-[13px] text-text">
              <StatusText names={props.names} text={props.triggerWords} />
            </span>
            <Show when={started()}>
              {(t) => <span class="text-[12px] text-text-secondary">{at(t())}</span>}
            </Show>
          </div>
        </li>
        <For each={props.flow.steps}>
          {(step, i) => {
            const run = () => runStateFor(props.runSteps, step.id)
            const state = () => stateOf(step)
            const muted = () => state() === "pending" || state() === "skipped"
            const deadline = () => {
              const d = run()?.output?.deadline
              return state() === "waiting" && typeof d === "string" ? d : null
            }
            const last = () => i() === props.flow.steps.length - 1
            return (
              <li
                data-testid={`${tid()}-step-${step.id}`}
                data-step-type={step.type}
                data-state={state()}
                class="flex min-w-0 gap-3"
              >
                <div class="flex w-3.5 flex-none flex-col items-center" aria-hidden="true">
                  <span
                    data-testid={`${tid()}-step-${step.id}-dot`}
                    class={`mt-[5px] h-2.5 w-2.5 rounded-full ${STATE_DOT[state()]}`}
                  />
                  <Show when={!last()}>
                    <span class="w-0.5 flex-1 bg-border-subtle" />
                  </Show>
                </div>
                <div class="flex min-w-0 flex-col gap-0.5 pb-3.5">
                  <span
                    data-testid={`${tid()}-step-${step.id}-title`}
                    class="break-words text-[13px]"
                    classList={{ "text-text": !muted(), "text-text-secondary": muted() }}
                  >
                    <StatusText names={props.names} text={describeStep(props.names, step)} />
                  </span>
                  <span
                    class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px]"
                    classList={{
                      "text-warning": state() === "waiting",
                      "text-error": state() === "failed" || state() === "flagged",
                      "text-text-secondary": !["waiting", "failed", "flagged"].includes(state()),
                    }}
                  >
                    <span data-testid={`${tid()}-step-${step.id}-state`}>
                      {i18n.t(`kernel.routineFlow.state_${state()}`)}
                    </span>
                    <Show when={deadline()}>
                      {(d) => (
                        <span data-testid={`${tid()}-step-${step.id}-resumes`} class={SEP}>
                          {i18n.t("kernel.routineFlow.resumesAt", { when: at(d()) })}
                        </span>
                      )}
                    </Show>
                    <Show when={step.type !== "agent" && !deadline() && run()?.note}>
                      {(note) => (
                        <span
                          data-testid={`${tid()}-step-${step.id}-note`}
                          class={`min-w-0 break-words ${SEP}`}
                        >
                          {note()}
                        </span>
                      )}
                    </Show>
                    <Show when={run()?.endedAt ?? (deadline() ? null : run()?.startedAt)}>
                      {(t) => (
                        <span
                          data-testid={`${tid()}-step-${step.id}-time`}
                          class={`text-text-tertiary ${SEP}`}
                        >
                          {at(t())}
                        </span>
                      )}
                    </Show>
                  </span>
                </div>
              </li>
            )
          }}
        </For>
      </ol>
      <For each={agentNotes()}>
        {(n) => (
          <div class="flex min-w-0 flex-col gap-1 rounded-lg border border-border-subtle bg-surface-sunken p-3">
            <span class="text-[12px] text-text-secondary">
              {i18n.t("kernel.routineFlow.agentNoteHeading")}
            </span>
            <span
              data-testid={`${tid()}-step-${n.id}-note`}
              class="break-words text-[12.5px] leading-relaxed text-text"
            >
              {n.note}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

export default FlowRunTimeline
