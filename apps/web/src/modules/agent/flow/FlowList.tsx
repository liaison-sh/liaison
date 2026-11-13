// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A routine's flow as a vertical list (owner decision D4): the trigger card,
 * then one card per step. Consecutive steps that share the same `if` sit
 * indented under one small "If <condition>" line; an agent step's required
 * outcomes are badges. The same component serves three modes:
 *   - view: read only (the routine's Flow tab, a template's preview);
 *   - edit: each card opens a small inline form, steps can be added, removed
 *     and moved up or down (no drag), the trigger's statuses picked;
 *   - run: one run laid over the list, a state chip, note and time per step.
 * Calm by design: one muted chip treatment, no colour per step type.
 */
import type { RoutineFlow, RoutineFlowStep } from "@liaison/shared"
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-solid"
import { type Component, createSignal, For, Index, Show } from "solid-js"
import { formatDateTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import Chip, { type ChipTone } from "../Chip"
import { FlowStepForm, fieldClass } from "./FlowStepForm"
import {
  appendStep,
  conditionKey,
  describeCondition,
  describeOutcome,
  describeStep,
  describeTrigger,
  type FlowEventFilter,
  type FlowNames,
  type FlowPerson,
  type FlowProject,
  type FlowRunStep,
  moveStep,
  newStep,
  removeStep,
  replaceStep,
  runStateFor,
  stepText,
} from "./flow-model"

export type FlowListMode = "view" | "edit" | "run"

interface Props {
  flow: RoutineFlow
  event: string | null
  eventFilter: FlowEventFilter | null
  project?: FlowProject | null
  people?: ReadonlyArray<FlowPerson>
  mode: FlowListMode
  /** Run mode: the run's per-step state (routine_runs.steps). */
  runSteps?: ReadonlyArray<FlowRunStep> | null
  onChange?: (flow: RoutineFlow) => void
  onFilterChange?: (filter: FlowEventFilter) => void
  /** The trigger's words when it is not a projects task event. */
  triggerFallback?: string
  /** Prefix of every test id (several lists can share a page). */
  testid?: string
}

const STATE_TONE: Record<FlowRunStep["state"], ChipTone> = {
  pending: "default",
  running: "accent",
  done: "done",
  skipped: "default",
  failed: "warn",
  flagged: "warn",
  waiting: "accent",
  awaiting_approval: "accent",
}

const iconButton =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-secondary disabled:opacity-40"

const FlowList: Component<Props> = (props) => {
  const i18n = useI18n()
  const tid = () => props.testid ?? "routine-flow"
  const [openId, setOpenId] = createSignal<string | null>(null)
  const names = (): FlowNames => ({
    project: props.project,
    people: props.people ?? [],
    t: i18n.t,
    locale: i18n.locale(),
  })
  const ctx = () => ({ project: props.project, people: props.people ?? [], names: names() })
  const editing = () => props.mode === "edit"
  const steps = () => props.flow.steps

  const change = (flow: RoutineFlow) => props.onChange?.(flow)
  const add = (type: RoutineFlowStep["type"]) => {
    const s = newStep(steps(), type)
    change(appendStep(props.flow, s))
    setOpenId(s.id)
  }

  /** The step opens a new "If" branch line: it has an `if` the previous step does not share. */
  const opensBranch = (i: number) => {
    const s = steps()[i]
    if (!s?.if) return false
    const prev = i > 0 ? steps()[i - 1] : undefined
    return conditionKey(prev?.if) !== conditionKey(s.if)
  }

  const isProjectStatusTrigger = () => props.event === "projects:task:status_changed"
  const setFilter = (patch: Partial<FlowEventFilter>) => {
    const next: FlowEventFilter = { ...(props.eventFilter ?? {}), ...patch }
    for (const k of Object.keys(next) as Array<keyof FlowEventFilter>) {
      if (next[k] === undefined) delete next[k]
    }
    props.onFilterChange?.(next)
  }
  const fromValue = () => {
    const f = props.eventFilter?.fromStatusId
    if (f === null) return "__new"
    return f ?? ""
  }

  return (
    <div data-testid={tid()} data-mode={props.mode} class="flex min-w-0 flex-col gap-2">
      {/* Trigger */}
      <section
        data-testid={`${tid()}-trigger`}
        class="min-w-0 rounded-md border border-border-subtle bg-surface px-3 py-2"
      >
        <p class="text-[11px] uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.routineFlow.triggerHeading")}
        </p>
        <p data-testid={`${tid()}-trigger-text`} class="break-words text-[13px] text-text">
          {describeTrigger(names(), props.event, props.eventFilter, props.triggerFallback ?? "")}
        </p>
        <Show when={editing() && isProjectStatusTrigger() && props.onFilterChange}>
          <div class="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[12px] font-medium text-text-secondary">
                {i18n.t("kernel.routineFlow.fromStatus")}
              </span>
              <select
                data-testid={`${tid()}-trigger-from`}
                class={fieldClass}
                value={fromValue()}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  setFilter({ fromStatusId: v === "__new" ? null : v === "" ? undefined : v })
                }}
              >
                <option value="">{i18n.t("kernel.routineFlow.anyStatus")}</option>
                <option value="__new">{i18n.t("kernel.routineFlow.newTask")}</option>
                <For each={props.project?.statuses ?? []}>
                  {(s) => <option value={s.id}>{s.label}</option>}
                </For>
              </select>
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[12px] font-medium text-text-secondary">
                {i18n.t("kernel.routineFlow.toStatus")}
              </span>
              <select
                data-testid={`${tid()}-trigger-to`}
                class={fieldClass}
                value={props.eventFilter?.toStatusId ?? ""}
                onChange={(e) => setFilter({ toStatusId: e.currentTarget.value || undefined })}
              >
                <option value="">{i18n.t("kernel.routineFlow.pickStatus")}</option>
                <For each={props.project?.statuses ?? []}>
                  {(s) => <option value={s.id}>{s.label}</option>}
                </For>
              </select>
            </label>
          </div>
        </Show>
      </section>

      {/* Steps: Index keeps each card mounted while its step changes, so a form keeps focus. */}
      <ol data-testid={`${tid()}-steps`} class="flex min-w-0 flex-col gap-2">
        <Index each={steps()}>
          {(step, i) => {
            const run = () => runStateFor(props.runSteps, step().id)
            const open = () => editing() && openId() === step().id
            return (
              <li
                data-testid={`${tid()}-step-${step().id}`}
                data-step-type={step().type}
                data-indented={step().if ? "true" : "false"}
                class="flex min-w-0 flex-col gap-1"
                classList={{ "ml-4 border-l border-border-subtle pl-3": !!step().if }}
              >
                <Show when={opensBranch(i)}>
                  <p
                    data-testid={`${tid()}-if-${step().id}`}
                    class="break-words text-[12px] text-text-tertiary"
                  >
                    {i18n.t("kernel.routineFlow.ifLine", {
                      condition: describeCondition(
                        names(),
                        step().if ?? { op: "status_unchanged_since_trigger" },
                      ),
                    })}
                  </p>
                </Show>
                <div class="min-w-0 rounded-md border border-border-subtle bg-surface px-3 py-2">
                  <div class="flex min-w-0 items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <p class="text-[11px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t(`kernel.routineFlow.type_${step().type}`)}
                      </p>
                      <p
                        data-testid={`${tid()}-step-${step().id}-title`}
                        class="break-words text-[13px] text-text"
                      >
                        {describeStep(names(), step())}
                      </p>
                      <Show when={stepText(step())}>
                        {(text) => (
                          <p class="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-text-secondary">
                            {text()}
                          </p>
                        )}
                      </Show>
                      <Show when={step().type === "wait" ? step() : null}>
                        {(w) => (
                          <p class="mt-0.5 break-words text-[12px] text-text-secondary">
                            {i18n.t("kernel.routineFlow.waitThen", {
                              condition: describeCondition(
                                names(),
                                (w() as Extract<RoutineFlowStep, { type: "wait" }>).until,
                              ),
                            })}
                          </p>
                        )}
                      </Show>
                      <Show
                        when={
                          step().type === "agent"
                            ? ((step() as Extract<RoutineFlowStep, { type: "agent" }>).outcomes ??
                              [])
                            : null
                        }
                      >
                        {(outcomes) => (
                          <Show when={outcomes().length > 0}>
                            <div class="mt-1 flex min-w-0 flex-wrap gap-1">
                              <For each={outcomes()}>
                                {(o, j) => (
                                  <Chip data-testid={`${tid()}-step-${step().id}-outcome-${j()}`}>
                                    {describeOutcome(names(), o)}
                                  </Chip>
                                )}
                              </For>
                            </div>
                          </Show>
                        )}
                      </Show>
                    </div>
                    <Show when={props.mode === "run"}>
                      <Chip
                        tone={STATE_TONE[run()?.state ?? "pending"]}
                        data-testid={`${tid()}-step-${step().id}-state`}
                        class="shrink-0"
                      >
                        {i18n.t(`kernel.routineFlow.state_${run()?.state ?? "pending"}`)}
                      </Chip>
                    </Show>
                    <Show when={editing()}>
                      <div class="flex shrink-0 items-center">
                        <button
                          type="button"
                          data-testid={`${tid()}-step-${step().id}-edit`}
                          aria-label={i18n.t("kernel.routineFlow.editStep")}
                          aria-pressed={open()}
                          class={iconButton}
                          onClick={() => setOpenId(open() ? null : step().id)}
                        >
                          <Pencil class="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`${tid()}-step-${step().id}-up`}
                          aria-label={i18n.t("kernel.routineFlow.moveUp")}
                          disabled={i === 0}
                          class={iconButton}
                          onClick={() => change(moveStep(props.flow, i, -1))}
                        >
                          <ArrowUp class="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`${tid()}-step-${step().id}-down`}
                          aria-label={i18n.t("kernel.routineFlow.moveDown")}
                          disabled={i === steps().length - 1}
                          class={iconButton}
                          onClick={() => change(moveStep(props.flow, i, 1))}
                        >
                          <ArrowDown class="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`${tid()}-step-${step().id}-remove`}
                          aria-label={i18n.t("kernel.routineFlow.removeStep")}
                          disabled={steps().length <= 1}
                          class={iconButton}
                          onClick={() => change(removeStep(props.flow, i))}
                        >
                          <Trash2 class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Show when={props.mode === "run" && run()}>
                    {(r) => (
                      <div class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] text-text-secondary">
                        <Show when={r().note}>
                          <span
                            data-testid={`${tid()}-step-${step().id}-note`}
                            class="min-w-0 break-words"
                          >
                            {r().note}
                          </span>
                        </Show>
                        <Show when={r().endedAt ?? r().startedAt}>
                          {(at) => (
                            <span
                              data-testid={`${tid()}-step-${step().id}-time`}
                              class="text-[11px] text-text-tertiary"
                            >
                              {formatDateTime(at(), i18n.locale())}
                            </span>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={open()}>
                    <div class="mt-2 border-t border-border-subtle pt-2">
                      <FlowStepForm
                        step={step()}
                        ctx={ctx()}
                        onChange={(s) => change(replaceStep(props.flow, i, s))}
                      />
                    </div>
                  </Show>
                </div>
              </li>
            )
          }}
        </Index>
      </ol>

      <Show when={editing() && steps().length < 20}>
        <div class="flex min-w-0 flex-wrap gap-1">
          <For each={["action", "wait", "agent"] as const}>
            {(type) => (
              <button
                type="button"
                data-testid={`${tid()}-add-${type}`}
                class="rounded-md border border-border-subtle px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-hover"
                onClick={() => add(type)}
              >
                {i18n.t(`kernel.routineFlow.add_${type}`)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default FlowList
