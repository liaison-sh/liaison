// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A routine's flow as a vertical spine (owner decisions D4, D11): the trigger
 * node (accent, a bolt), then one typed node per step: an action wears its
 * action's icon on an accent tint, a wait is a warning-tinted clock with a
 * dashed connector below it, an agent step wears its owner agent's avatar
 * gradient and lists its required outcomes as badges. Two consecutive "if"
 * groups that split on one field sit side by side as lanes ("is X" /
 * "otherwise"); any other "if" indents its steps under one line. Status names
 * in the copy are status pills in the project's own colours.
 *   - view: read only (the routine's Flow tab, a template's preview);
 *   - edit: the same spine, no lanes; each card opens its inline form, steps
 *     can be added, removed and moved (no drag), the trigger's statuses picked;
 *   - run: one run as a timeline (FlowRunTimeline): a state dot per step, a
 *     progress strip and the run's state chip.
 */
import type { RoutineFlow, RoutineFlowStep } from "@liaison/shared"
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  Clock,
  MessageSquare,
  MessageSquareText,
  Pencil,
  PencilLine,
  Split,
  Tag,
  Trash2,
  UserPlus,
  Zap,
} from "lucide-solid"
import { type Component, createSignal, For, Index, type JSX, Match, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { prettyStatus } from "~/modules/projects/status-label"
import { agentAvatarStyle, avatarColors } from "~/ui/avatar-palette"
import { FlowRunTimeline } from "./FlowRunTimeline"
import { FlowStepForm, fieldClass } from "./FlowStepForm"
import {
  appendStep,
  conditionKey,
  describeCondition,
  describeOutcome,
  describeStep,
  type FlowEventFilter,
  type FlowNames,
  type FlowPerson,
  type FlowProject,
  type FlowRunStep,
  flowSegments,
  markedNames,
  moveStep,
  newStep,
  personName,
  removeStep,
  replaceStep,
  type StepIconKind,
  stepIconKind,
  stepPeople,
  stepText,
  textParts,
  triggerParts,
} from "./flow-model"
import { StatusText } from "./StatusText"

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
  /** The agent the routine runs as: an agent step's node wears its avatar colour. */
  agentId?: string | null
  agentColor?: number | null
  /** Prefix of every test id (several lists can share a page). */
  testid?: string
}

const iconButton =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-secondary disabled:opacity-40"

const STEP_ICON: Record<Exclude<StepIconKind, "wait" | "agent">, Component<{ class?: string }>> = {
  assign: UserPlus,
  message: MessageSquare,
  notify: Bell,
  set_status: Tag,
  set_field: PencilLine,
  comment: MessageSquareText,
}

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

  /** The trigger's words, one line (run mode's timeline names it). */
  const triggerWords = () => {
    const parts = triggerParts(markedNames(names()), props.event, props.eventFilter)
    return parts ? parts.head : (props.triggerFallback ?? "")
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────

  const Node: Component<{ step: RoutineFlowStep }> = (p) => {
    const kind = () => stepIconKind(p.step)
    return (
      <Switch>
        <Match when={kind() === "wait"}>
          <span
            data-node="wait"
            class="flex h-9 w-9 items-center justify-center rounded-full bg-warning/15 text-warning"
          >
            <Clock class="h-4 w-4" />
          </span>
        </Match>
        <Match when={kind() === "agent"}>
          <span
            data-node="agent"
            class="flex h-9 w-9 items-center justify-center rounded-full"
            style={agentAvatarStyle(props.agentId ?? null, props.agentColor ?? null)}
          >
            <Zap class="h-4 w-4" />
          </span>
        </Match>
        <Match when={kind() !== "wait" && kind() !== "agent"}>
          {(() => {
            const Icon = STEP_ICON[kind() as Exclude<StepIconKind, "wait" | "agent">]
            return (
              <span
                data-node={`action-${kind()}`}
                class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-tint text-text"
              >
                <Icon class="h-4 w-4" />
              </span>
            )
          })()}
        </Match>
      </Switch>
    )
  }

  /** A small node for a step inside a lane. */
  const LaneIcon: Component<{ step: RoutineFlowStep }> = (p) => {
    const kind = () => stepIconKind(p.step)
    return (
      <Show
        when={kind() !== "wait" && kind() !== "agent"}
        fallback={
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            classList={{ "bg-warning/15 text-warning": kind() === "wait" }}
            style={
              kind() === "agent"
                ? agentAvatarStyle(props.agentId ?? null, props.agentColor ?? null)
                : undefined
            }
          >
            <Show when={kind() === "wait"} fallback={<Zap class="h-3.5 w-3.5" />}>
              <Clock class="h-3.5 w-3.5" />
            </Show>
          </span>
        }
      >
        {(() => {
          const Icon = STEP_ICON[kind() as Exclude<StepIconKind, "wait" | "agent">]
          return (
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-text">
              <Icon class="h-3.5 w-3.5" />
            </span>
          )
        })()}
      </Show>
    )
  }

  // ── A step's body (shared by the spine and the lanes) ──────────────────────

  const StepBody: Component<{ step: RoutineFlowStep; index: number }> = (p) => {
    const step = () => p.step
    const people = () => stepPeople(step())
    return (
      <div class="min-w-0 flex-1">
        <Show when={step().type === "agent"}>
          <p class="text-[11px] uppercase tracking-wide text-text-tertiary">
            {i18n.t("kernel.routineFlow.type_agent")}
          </p>
        </Show>
        <p
          data-testid={`${tid()}-step-${step().id}-title`}
          class="break-words text-[13px] leading-relaxed text-text"
          classList={{ "text-[14px]": step().type === "wait" }}
        >
          <StatusText names={names()} text={describeStep(markedNames(names()), step())} />
        </p>
        <Show when={people().length > 0 && !editing()}>
          <div
            data-testid={`${tid()}-step-${step().id}-people`}
            class="mt-1 flex min-w-0 flex-wrap items-center gap-1"
          >
            <For each={people()}>
              {(ref) => {
                const isRef = ref.startsWith("{{")
                const c = avatarColors(ref)
                const name = personName(names(), ref)
                return (
                  <span
                    title={name}
                    class="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold"
                    classList={{ "border border-border bg-surface text-text-secondary": isRef }}
                    style={isRef ? undefined : { background: c.bg, color: c.text }}
                  >
                    {initialsOf(name)}
                  </span>
                )
              }}
            </For>
          </div>
        </Show>
        <Show when={stepText(step())}>
          {(text) => (
            <p
              data-testid={`${tid()}-step-${step().id}-text`}
              class="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-text-secondary"
            >
              <Show when={!editing()} fallback={text()}>
                <For each={textParts(names(), text())}>
                  {(part) =>
                    part.kind === "token" ? (
                      <span
                        data-testid={`${tid()}-step-${step().id}-token`}
                        data-token={part.token}
                        title={part.token}
                        class="mx-px inline-block rounded border border-border bg-surface-sunken px-1.5 text-[11.5px] leading-[18px] text-text"
                      >
                        {part.label}
                      </span>
                    ) : (
                      part.text
                    )
                  }
                </For>
              </Show>
            </p>
          )}
        </Show>
        <Show
          when={
            step().type === "wait" ? (step() as Extract<RoutineFlowStep, { type: "wait" }>) : null
          }
        >
          {(w) => (
            <p class="mt-0.5 break-words text-[12.5px] text-text-secondary">
              <StatusText
                names={names()}
                text={i18n.t("kernel.routineFlow.waitThen", {
                  condition: describeCondition(markedNames(names()), w().until),
                })}
              />
            </p>
          )}
        </Show>
        <Show
          when={
            step().type === "agent"
              ? ((step() as Extract<RoutineFlowStep, { type: "agent" }>).outcomes ?? [])
              : null
          }
        >
          {(outcomes) => (
            <Show when={outcomes().length > 0}>
              <div class="mt-2 flex min-w-0 flex-wrap gap-1.5">
                <For each={outcomes()}>
                  {(o, j) => (
                    <span
                      data-testid={`${tid()}-step-${step().id}-outcome-${j()}`}
                      class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-2.5 py-0.5 text-[12px] text-text"
                    >
                      <Check aria-hidden="true" class="h-3 w-3 shrink-0" />
                      {describeOutcome(names(), o)}
                    </span>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    )
  }

  const EditButtons: Component<{ step: RoutineFlowStep; index: number }> = (p) => {
    const open = () => openId() === p.step.id
    return (
      <div class="flex shrink-0 items-center">
        <button
          type="button"
          data-testid={`${tid()}-step-${p.step.id}-edit`}
          aria-label={i18n.t("kernel.routineFlow.editStep")}
          aria-pressed={open()}
          class={iconButton}
          onClick={() => setOpenId(open() ? null : p.step.id)}
        >
          <Pencil class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid={`${tid()}-step-${p.step.id}-up`}
          aria-label={i18n.t("kernel.routineFlow.moveUp")}
          disabled={p.index === 0}
          class={iconButton}
          onClick={() => change(moveStep(props.flow, p.index, -1))}
        >
          <ArrowUp class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid={`${tid()}-step-${p.step.id}-down`}
          aria-label={i18n.t("kernel.routineFlow.moveDown")}
          disabled={p.index === steps().length - 1}
          class={iconButton}
          onClick={() => change(moveStep(props.flow, p.index, 1))}
        >
          <ArrowDown class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid={`${tid()}-step-${p.step.id}-remove`}
          aria-label={i18n.t("kernel.routineFlow.removeStep")}
          disabled={steps().length <= 1}
          class={iconButton}
          onClick={() => change(removeStep(props.flow, p.index))}
        >
          <Trash2 class="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  /** One spine row: the node and its connector on the left, the step on the right. */
  const SpineRow: Component<{
    step: RoutineFlowStep
    index: number
    last: boolean
    indented: boolean
  }> = (p) => {
    const step = () => p.step
    const isWait = () => step().type === "wait"
    const open = () => editing() && openId() === step().id
    return (
      <li
        data-testid={`${tid()}-step-${step().id}`}
        data-step-type={step().type}
        data-indented={step().if ? "true" : "false"}
        class="flex min-w-0 gap-3.5"
      >
        <div class="flex w-9 flex-none flex-col items-center" aria-hidden="true">
          <Node step={step()} />
          <Show when={!p.last}>
            <span
              data-connector={isWait() ? "dashed" : "solid"}
              class="min-h-3.5 w-0 flex-1"
              classList={{
                "border-l-2 border-dashed border-border-strong": isWait(),
                "border-l-2 border-border": !isWait(),
              }}
            />
          </Show>
        </div>
        <div
          class="flex min-w-0 flex-1 flex-col gap-1 pb-3"
          classList={{ "ml-2 border-l border-border-subtle pl-3": p.indented }}
        >
          <Show when={opensBranch(p.index)}>
            <p
              data-testid={`${tid()}-if-${step().id}`}
              class="flex min-w-0 items-center gap-1.5 break-words pt-2 text-[12.5px] text-text-secondary"
            >
              <Split aria-hidden="true" class="h-3.5 w-3.5 shrink-0" />
              <span class="min-w-0">
                <StatusText
                  names={names()}
                  text={i18n.t("kernel.routineFlow.ifLine", {
                    condition: describeCondition(
                      markedNames(names()),
                      step().if ?? { op: "status_unchanged_since_trigger" },
                    ),
                  })}
                />
              </span>
            </p>
          </Show>
          <div
            class="min-w-0"
            classList={{
              "rounded-xl border border-border bg-surface px-4 py-3": !isWait() || open(),
              "pt-1.5": isWait() && !open(),
            }}
          >
            <div class="flex min-w-0 items-start gap-2">
              <StepBody step={step()} index={p.index} />
              <Show when={editing()}>
                <EditButtons step={step()} index={p.index} />
              </Show>
            </div>
            <Show when={open()}>
              <div class="mt-2 border-t border-border-subtle pt-2">
                <FlowStepForm
                  step={step()}
                  ctx={ctx()}
                  onChange={(s) => change(replaceStep(props.flow, p.index, s))}
                />
              </div>
            </Show>
          </div>
        </div>
      </li>
    )
  }

  /** A split on one field: its two lanes side by side (they stack on a phone). */
  const SplitRow: Component<{
    field: string
    lanes: ReadonlyArray<{ label: string; indices: number[] }>
    last: boolean
    first: string
  }> = (p) => (
    <li data-testid={`${tid()}-split-${p.first}`} class="flex min-w-0 gap-3.5">
      <div class="flex w-9 flex-none flex-col items-center" aria-hidden="true">
        <span class="h-2.5 w-0.5 bg-border" />
        <span class="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-border bg-surface text-text-secondary">
          <Split class="h-3.5 w-3.5" />
        </span>
        <Show when={!p.last}>
          <span class="w-0.5 flex-1 bg-border" />
        </Show>
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-2.5 pb-3">
        <p class="pt-3 text-[13px] text-text-secondary">
          {i18n.t("kernel.routineFlow.splitOn")} <b class="font-semibold text-text">{p.field}</b>
        </p>
        <div class="grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2">
          <For each={p.lanes}>
            {(lane, j) => (
              <div
                data-testid={`${tid()}-lane-${j()}`}
                class="flex min-w-0 flex-col gap-2 rounded-xl border border-border-subtle bg-surface-sunken p-2.5"
              >
                <span
                  data-testid={`${tid()}-lane-${j()}-label`}
                  class="self-start rounded-full border border-border bg-surface px-2.5 py-0.5 text-[12px] text-text"
                >
                  <StatusText names={names()} text={lane.label} />
                </span>
                <ol class="flex min-w-0 flex-col gap-2">
                  <For each={lane.indices}>
                    {(i) => {
                      const step = () => steps()[i] as RoutineFlowStep
                      return (
                        <li
                          data-testid={`${tid()}-step-${step().id}`}
                          data-step-type={step().type}
                          data-indented={step().if ? "true" : "false"}
                          data-lane={String(j())}
                          class="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5"
                        >
                          <LaneIcon step={step()} />
                          <StepBody step={step()} index={i} />
                        </li>
                      )
                    }}
                  </For>
                </ol>
              </div>
            )}
          </For>
        </div>
      </div>
    </li>
  )

  const TriggerCard = (): JSX.Element => (
    <section data-testid={`${tid()}-trigger`} class="flex min-w-0 gap-3.5">
      <div class="flex w-9 flex-none flex-col items-center" aria-hidden="true">
        <span
          data-node="trigger"
          class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-foreground"
        >
          <Zap class="h-4 w-4" />
        </span>
        <Show when={steps().length > 0}>
          <span class="min-h-3.5 w-0 flex-1 border-l-2 border-border" />
        </Show>
      </div>
      <div class="mb-3 min-w-0 flex-1 rounded-xl border border-accent-border bg-surface px-4 py-3">
        <p class="text-[11px] uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.routineFlow.triggerHeading")}
        </p>
        <Show
          when={triggerParts(markedNames(names()), props.event, props.eventFilter)}
          fallback={
            <p
              data-testid={`${tid()}-trigger-text`}
              class="mt-1 break-words text-[14px] leading-relaxed text-text"
            >
              {props.triggerFallback ?? ""}
            </p>
          }
        >
          {(parts) => (
            <>
              <p
                data-testid={`${tid()}-trigger-text`}
                class="mt-1 break-words text-[14px] leading-relaxed text-text"
              >
                <StatusText names={names()} text={parts().head} testid={`${tid()}-trigger`} />
              </p>
              <For each={parts().fields}>
                {(phrase, j) => (
                  <p
                    data-testid={`${tid()}-trigger-field-${j()}`}
                    class="break-words text-[13px] text-text-secondary"
                  >
                    {i18n.t("kernel.routineFlow.triggerAndField", { phrase })}
                  </p>
                )}
              </For>
            </>
          )}
        </Show>
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
                  {(s) => <option value={s.id}>{prettyStatus(s.label)}</option>}
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
                  {(s) => <option value={s.id}>{prettyStatus(s.label)}</option>}
                </For>
              </select>
            </label>
          </div>
        </Show>
      </div>
    </section>
  )

  return (
    <div data-testid={tid()} data-mode={props.mode} class="flex min-w-0 flex-col">
      <Show
        when={props.mode !== "run"}
        fallback={
          <FlowRunTimeline
            flow={props.flow}
            names={names()}
            runSteps={props.runSteps ?? []}
            triggerWords={triggerWords()}
            testid={tid()}
          />
        }
      >
        <TriggerCard />
        <ol data-testid={`${tid()}-steps`} class="flex min-w-0 flex-col">
          <Show
            when={!editing()}
            fallback={
              /* Index keeps each card mounted while its step changes, so a form keeps focus. */
              <Index each={steps()}>
                {(step, i) => (
                  <SpineRow
                    step={step()}
                    index={i}
                    last={i === steps().length - 1}
                    indented={!!step().if}
                  />
                )}
              </Index>
            }
          >
            <For each={flowSegments(markedNames(names()), steps())}>
              {(seg, k) => {
                const lastSeg = () => k() === flowSegments(names(), steps()).length - 1
                return seg.kind === "split" ? (
                  <SplitRow
                    field={seg.field}
                    lanes={seg.lanes}
                    last={lastSeg()}
                    first={steps()[seg.lanes[0].indices[0] ?? 0]?.id ?? String(k())}
                  />
                ) : (
                  <For each={seg.indices}>
                    {(i, j) => (
                      <SpineRow
                        step={steps()[i] as RoutineFlowStep}
                        index={i}
                        last={lastSeg() && j() === seg.indices.length - 1}
                        indented={!!steps()[i]?.if}
                      />
                    )}
                  </For>
                )
              }}
            </For>
          </Show>
        </ol>

        <Show when={editing() && steps().length < 20}>
          <div class="flex min-w-0 flex-wrap gap-1 pl-[50px]">
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
      </Show>
    </div>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export default FlowList
