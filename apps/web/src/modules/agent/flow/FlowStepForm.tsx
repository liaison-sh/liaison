// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The small inline forms of the flow list's edit mode: one per step type
 * (action, wait, agent), the person / status / field pickers they share, and
 * the "only if" condition row. Every change hands a whole new step up.
 */
import type { RoutineFlowCondition, RoutineFlowOutcome, RoutineFlowStep } from "@liaison/shared"
import { type Component, For, Index, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { prettyStatus } from "~/modules/projects/status-label"
import {
  ACTION_KINDS,
  type ActionKind,
  type ActionStep,
  type AgentStep,
  defaultAction,
  describeCondition,
  type FlowNames,
  type FlowPerson,
  type FlowProject,
  WAIT_UNITS,
  type WaitStep,
  type WaitUnit,
} from "./flow-model"

export const fieldClass =
  "w-full min-w-0 rounded-md border border-border-subtle bg-surface-elevated px-2 py-1.5 text-[13px] text-text"
const labelClass = "text-[12px] font-medium text-text-secondary"

const OWNER = "{{owner}}"
const ASSIGNEE = "{{task.assigneeId}}"

interface Ctx {
  project?: FlowProject | null
  people: ReadonlyArray<FlowPerson>
  names: FlowNames
}

// ── Pickers ───────────────────────────────────────────────────────────────────

const PersonSelect: Component<{
  value: string
  onChange: (v: string) => void
  ctx: Ctx
  testid: string
  label: string
}> = (props) => {
  const i18n = useI18n()
  const knownMember = () => props.ctx.people.some((p) => p.id === props.value)
  return (
    <label class="flex min-w-0 flex-col gap-1">
      <span class={labelClass}>{props.label}</span>
      <select
        data-testid={props.testid}
        class={fieldClass}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value={OWNER}>{i18n.t("kernel.routineFlow.personOwner")}</option>
        <option value={ASSIGNEE}>{i18n.t("kernel.routineFlow.personAssignee")}</option>
        <Show when={props.value !== OWNER && props.value !== ASSIGNEE && !knownMember()}>
          <option value={props.value}>{i18n.t("kernel.routineFlow.personUnknown")}</option>
        </Show>
        <For each={props.ctx.people}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>
    </label>
  )
}

const StatusSelect: Component<{
  value: string
  onChange: (v: string) => void
  ctx: Ctx
  testid: string
  label: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <label class="flex min-w-0 flex-col gap-1">
      <span class={labelClass}>{props.label}</span>
      <select
        data-testid={props.testid}
        class={fieldClass}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">{i18n.t("kernel.routineFlow.pickStatus")}</option>
        <For each={props.ctx.project?.statuses ?? []}>
          {(s) => <option value={s.id}>{prettyStatus(s.label)}</option>}
        </For>
      </select>
    </label>
  )
}

const FieldSelect: Component<{
  value: string
  onChange: (v: string) => void
  ctx: Ctx
  testid: string
  label: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <label class="flex min-w-0 flex-col gap-1">
      <span class={labelClass}>{props.label}</span>
      <select
        data-testid={props.testid}
        class={fieldClass}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">{i18n.t("kernel.routineFlow.pickField")}</option>
        <For each={props.ctx.project?.fields ?? []}>
          {(f) => <option value={f.key}>{f.label}</option>}
        </For>
      </select>
    </label>
  )
}

/** A field value: the field's choices when it has them, else free text. */
const FieldValueInput: Component<{
  fieldKey: string
  value: string
  onChange: (v: string) => void
  ctx: Ctx
  testid: string
}> = (props) => {
  const i18n = useI18n()
  const choices = () => props.ctx.project?.fields.find((f) => f.key === props.fieldKey)?.choices
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <span class={labelClass}>{i18n.t("kernel.routineFlow.value")}</span>
      <Show
        when={choices()}
        fallback={
          <input
            data-testid={props.testid}
            aria-label={i18n.t("kernel.routineFlow.value")}
            class={fieldClass}
            value={props.value}
            onInput={(e) => props.onChange(e.currentTarget.value)}
          />
        }
      >
        {(list) => (
          <select
            data-testid={props.testid}
            aria-label={i18n.t("kernel.routineFlow.value")}
            class={fieldClass}
            value={props.value}
            onChange={(e) => props.onChange(e.currentTarget.value)}
          >
            <option value="">{i18n.t("kernel.routineFlow.pickValue")}</option>
            <For each={list()}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        )}
      </Show>
    </div>
  )
}

/** Several people, as a short checklist (owner, assignee, then the members). */
const PeopleChecklist: Component<{
  value: readonly string[]
  onChange: (v: string[]) => void
  ctx: Ctx
  testid: string
  label: string
  withRoles?: boolean
}> = (props) => {
  const i18n = useI18n()
  const options = () => [
    ...(props.withRoles === false
      ? []
      : [
          { id: OWNER, name: i18n.t("kernel.routineFlow.personOwner") },
          { id: ASSIGNEE, name: i18n.t("kernel.routineFlow.personAssignee") },
        ]),
    ...props.ctx.people,
  ]
  const toggle = (id: string, on: boolean) => {
    const next = props.value.filter((x) => x !== id)
    props.onChange(on ? [...next, id] : next)
  }
  return (
    <fieldset class="flex min-w-0 flex-col gap-1" data-testid={props.testid}>
      <legend class={labelClass}>{props.label}</legend>
      <div class="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        <For each={options()}>
          {(o) => (
            <label class="flex min-w-0 items-center gap-2 text-[13px] text-text">
              <input
                type="checkbox"
                data-testid={`${props.testid}-${o.id.replace(/[{}.]/g, "")}`}
                checked={props.value.includes(o.id)}
                onChange={(e) => toggle(o.id, e.currentTarget.checked)}
              />
              <span class="min-w-0 truncate">{o.name}</span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  )
}

const TextArea: Component<{
  value: string
  onChange: (v: string) => void
  testid: string
  label: string
  rows?: number
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1">
    <span class={labelClass}>{props.label}</span>
    <textarea
      data-testid={props.testid}
      class={`${fieldClass} resize-y`}
      rows={props.rows ?? 2}
      value={props.value}
      onInput={(e) => props.onChange(e.currentTarget.value)}
    />
  </label>
)

// ── Conditions ────────────────────────────────────────────────────────────────

type Leaf = Extract<RoutineFlowCondition, { field: string }>

function isLeaf(c: RoutineFlowCondition): c is Leaf {
  return "field" in c
}

/**
 * One simple condition: a field, "is" / "is empty" / "is set", and a value.
 * A compound one (all / any / unchanged) reads as words and can be replaced.
 */
export const ConditionEditor: Component<{
  value: RoutineFlowCondition
  onChange: (c: RoutineFlowCondition) => void
  ctx: Ctx
  testid: string
  allowUnchanged?: boolean
}> = (props) => {
  const i18n = useI18n()
  const fieldValue = () =>
    isLeaf(props.value) ? props.value.field : "status_unchanged_since_trigger"
  const setField = (field: string) => {
    if (field === "status_unchanged_since_trigger") {
      props.onChange({ op: "status_unchanged_since_trigger" })
      return
    }
    if (field === "assignee") props.onChange({ field, op: "not_empty" })
    else props.onChange({ field, op: "eq", value: "" })
  }
  const setOp = (op: string) => {
    const c = props.value
    if (!isLeaf(c)) return
    if (op === "empty" || op === "not_empty") props.onChange({ field: c.field, op })
    else props.onChange({ field: c.field, op: "eq", value: "" })
  }
  const leafValue = () => {
    const c = props.value
    return isLeaf(c) && c.op === "eq" && c.value !== undefined && !Array.isArray(c.value)
      ? String(c.value ?? "")
      : ""
  }
  const setValue = (v: string) => {
    const c = props.value
    if (isLeaf(c)) props.onChange({ field: c.field, op: "eq", value: v })
  }
  const compound = () =>
    "all" in props.value || "any" in props.value || (isLeaf(props.value) && props.value.op === "in")
  return (
    <Show
      when={!compound()}
      fallback={
        <div class="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-text-secondary">
          <span data-testid={`${props.testid}-words`} class="min-w-0 break-words">
            {describeCondition(props.ctx.names, props.value)}
          </span>
          <button
            type="button"
            data-testid={`${props.testid}-replace`}
            class="rounded px-1.5 py-0.5 text-[12px] text-text-tertiary hover:bg-surface-hover"
            onClick={() => props.onChange({ field: "status", op: "eq", value: "" })}
          >
            {i18n.t("kernel.routineFlow.replaceCondition")}
          </button>
        </div>
      }
    >
      <div class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        <label class="flex min-w-0 flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.routineFlow.conditionField")}</span>
          <select
            data-testid={`${props.testid}-field`}
            class={fieldClass}
            value={fieldValue()}
            onChange={(e) => setField(e.currentTarget.value)}
          >
            <Show when={props.allowUnchanged}>
              <option value="status_unchanged_since_trigger">
                {i18n.t("kernel.routineFlow.condUnchanged")}
              </option>
            </Show>
            <option value="status">{i18n.t("kernel.routineFlow.fieldStatus")}</option>
            <option value="assignee">{i18n.t("kernel.routineFlow.fieldAssignee")}</option>
            <For each={props.ctx.project?.fields ?? []}>
              {(f) => <option value={`fields.${f.key}`}>{f.label}</option>}
            </For>
          </select>
        </label>
        <Show when={isLeaf(props.value) ? (props.value as Leaf) : null}>
          {(leaf) => (
            <>
              <label class="flex min-w-0 flex-col gap-1">
                <span class={labelClass}>{i18n.t("kernel.routineFlow.conditionOp")}</span>
                <select
                  data-testid={`${props.testid}-op`}
                  class={fieldClass}
                  value={leaf().op}
                  onChange={(e) => setOp(e.currentTarget.value)}
                >
                  <option value="eq">{i18n.t("kernel.routineFlow.opIs")}</option>
                  <option value="empty">{i18n.t("kernel.routineFlow.opEmpty")}</option>
                  <option value="not_empty">{i18n.t("kernel.routineFlow.opNotEmpty")}</option>
                </select>
              </label>
              <Show when={leaf().op === "eq"}>
                <Show
                  when={leaf().field === "status"}
                  fallback={
                    <Show
                      when={leaf().field === "assignee"}
                      fallback={
                        <FieldValueInput
                          fieldKey={leaf().field.replace(/^fields\./, "")}
                          value={leafValue()}
                          onChange={setValue}
                          ctx={props.ctx}
                          testid={`${props.testid}-value`}
                        />
                      }
                    >
                      <PersonSelect
                        value={leafValue() || OWNER}
                        onChange={setValue}
                        ctx={props.ctx}
                        testid={`${props.testid}-value`}
                        label={i18n.t("kernel.routineFlow.value")}
                      />
                    </Show>
                  }
                >
                  <StatusSelect
                    value={leafValue()}
                    onChange={setValue}
                    ctx={props.ctx}
                    testid={`${props.testid}-value`}
                    label={i18n.t("kernel.routineFlow.value")}
                  />
                </Show>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

// ── Step forms ────────────────────────────────────────────────────────────────

/** The step when it is that action, else null (a non-keyed `Show` keeps its form mounted). */
function pick<K extends ActionKind>(
  s: ActionStep,
  kind: K,
): Extract<ActionStep, { action: K }> | null {
  return s.action === kind ? (s as Extract<ActionStep, { action: K }>) : null
}

const ActionForm: Component<{
  step: ActionStep
  onChange: (s: RoutineFlowStep) => void
  ctx: Ctx
}> = (props) => {
  const i18n = useI18n()
  const tid = () => `flow-step-${props.step.id}`
  const s = () => props.step
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <label class="flex min-w-0 flex-col gap-1">
        <span class={labelClass}>{i18n.t("kernel.routineFlow.actionKind")}</span>
        <select
          data-testid={`${tid()}-action`}
          class={fieldClass}
          value={s().action}
          onChange={(e) =>
            props.onChange(defaultAction(s().id, e.currentTarget.value as ActionKind, s().if))
          }
        >
          <For each={ACTION_KINDS}>
            {(k) => <option value={k}>{i18n.t(`kernel.routineFlow.action_${k}`)}</option>}
          </For>
        </select>
      </label>
      <Show when={pick(s(), "assign")}>
        {(st) => {
          const least = () => {
            const to = st().args.to
            return typeof to === "string" ? null : to.leastLoaded
          }
          return (
            <>
              <label class="flex min-w-0 items-center gap-2 text-[13px] text-text">
                <input
                  type="checkbox"
                  data-testid={`${tid()}-least-loaded`}
                  checked={least() !== null}
                  onChange={(e) =>
                    props.onChange({
                      ...st(),
                      args: {
                        to: e.currentTarget.checked
                          ? { leastLoaded: props.ctx.people.slice(0, 1).map((p) => p.id) }
                          : OWNER,
                      },
                    })
                  }
                />
                <span>{i18n.t("kernel.routineFlow.leastLoaded")}</span>
              </label>
              <Show
                when={least()}
                fallback={
                  <PersonSelect
                    value={(() => {
                      const to = st().args.to
                      return typeof to === "string" ? to : OWNER
                    })()}
                    onChange={(v) => props.onChange({ ...st(), args: { to: v } })}
                    ctx={props.ctx}
                    testid={`${tid()}-person`}
                    label={i18n.t("kernel.routineFlow.assignee")}
                  />
                }
              >
                {(list) => (
                  <PeopleChecklist
                    value={list()}
                    withRoles={false}
                    onChange={(v) =>
                      props.onChange({
                        ...st(),
                        args: { to: v.length > 0 ? { leastLoaded: v } : OWNER },
                      })
                    }
                    ctx={props.ctx}
                    testid={`${tid()}-people`}
                    label={i18n.t("kernel.routineFlow.amongPeople")}
                  />
                )}
              </Show>
            </>
          )
        }}
      </Show>
      <Show when={pick(s(), "set_status")}>
        {(st) => (
          <StatusSelect
            value={st().args.statusId}
            onChange={(v) => props.onChange({ ...st(), args: { statusId: v } })}
            ctx={props.ctx}
            testid={`${tid()}-status`}
            label={i18n.t("kernel.routineFlow.status")}
          />
        )}
      </Show>
      <Show when={pick(s(), "set_field")}>
        {(st) => (
          <div class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <FieldSelect
              value={st().args.key}
              onChange={(v) => props.onChange({ ...st(), args: { key: v, value: "" } })}
              ctx={props.ctx}
              testid={`${tid()}-field`}
              label={i18n.t("kernel.routineFlow.field")}
            />
            <FieldValueInput
              fieldKey={st().args.key}
              value={(() => {
                const v = st().args.value
                return Array.isArray(v) ? v.join(", ") : String(v ?? "")
              })()}
              onChange={(v) => props.onChange({ ...st(), args: { ...st().args, value: v } })}
              ctx={props.ctx}
              testid={`${tid()}-value`}
            />
          </div>
        )}
      </Show>
      <Show when={pick(s(), "message")}>
        {(st) => (
          <>
            <PersonSelect
              value={st().args.to}
              onChange={(v) => props.onChange({ ...st(), args: { ...st().args, to: v } })}
              ctx={props.ctx}
              testid={`${tid()}-person`}
              label={i18n.t("kernel.routineFlow.recipient")}
            />
            <TextArea
              value={st().args.text}
              onChange={(v) => props.onChange({ ...st(), args: { ...st().args, text: v } })}
              testid={`${tid()}-text`}
              label={i18n.t("kernel.routineFlow.text")}
            />
          </>
        )}
      </Show>
      <Show when={pick(s(), "notify")}>
        {(st) => (
          <>
            <PeopleChecklist
              value={st().args.to}
              onChange={(v) => props.onChange({ ...st(), args: { ...st().args, to: v } })}
              ctx={props.ctx}
              testid={`${tid()}-people`}
              label={i18n.t("kernel.routineFlow.recipients")}
            />
            <TextArea
              value={st().args.text}
              onChange={(v) => props.onChange({ ...st(), args: { ...st().args, text: v } })}
              testid={`${tid()}-text`}
              label={i18n.t("kernel.routineFlow.text")}
            />
          </>
        )}
      </Show>
      <Show when={pick(s(), "comment")}>
        {(st) => (
          <TextArea
            value={st().args.text}
            onChange={(v) => props.onChange({ ...st(), args: { text: v } })}
            testid={`${tid()}-text`}
            label={i18n.t("kernel.routineFlow.text")}
          />
        )}
      </Show>
    </div>
  )
}

const WaitForm: Component<{ step: WaitStep; onChange: (s: RoutineFlowStep) => void; ctx: Ctx }> = (
  props,
) => {
  const i18n = useI18n()
  const tid = () => `flow-step-${props.step.id}`
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <div class="grid min-w-0 grid-cols-2 gap-2">
        <label class="flex min-w-0 flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.routineFlow.amount")}</span>
          <input
            type="number"
            min="1"
            inputmode="numeric"
            data-testid={`${tid()}-amount`}
            class={fieldClass}
            value={props.step.for.amount}
            onInput={(e) => {
              const n = Number.parseInt(e.currentTarget.value, 10)
              props.onChange({
                ...props.step,
                for: { ...props.step.for, amount: Number.isFinite(n) ? n : 0 },
              })
            }}
          />
        </label>
        <label class="flex min-w-0 flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.routineFlow.unit")}</span>
          <select
            data-testid={`${tid()}-unit`}
            class={fieldClass}
            value={props.step.for.unit}
            onChange={(e) =>
              props.onChange({
                ...props.step,
                for: { ...props.step.for, unit: e.currentTarget.value as WaitUnit },
              })
            }
          >
            <For each={WAIT_UNITS}>
              {(u) => <option value={u}>{i18n.t(`kernel.routineFlow.unit_${u}`)}</option>}
            </For>
          </select>
        </label>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <span class={labelClass}>{i18n.t("kernel.routineFlow.continueIf")}</span>
        <ConditionEditor
          value={props.step.until}
          onChange={(c) => props.onChange({ ...props.step, until: c })}
          ctx={props.ctx}
          testid={`${tid()}-until`}
          allowUnchanged
        />
      </div>
    </div>
  )
}

const OUTCOME_KINDS = ["message_posted", "field_set", "status_is", "tool_called"] as const

function defaultOutcome(kind: (typeof OUTCOME_KINDS)[number]): RoutineFlowOutcome {
  switch (kind) {
    case "message_posted":
      return { kind, to: ASSIGNEE }
    case "field_set":
      return { kind, field: "" }
    case "status_is":
      return { kind, status: "" }
    case "tool_called":
      return { kind, tool: "" }
  }
}

function pickOutcome<K extends RoutineFlowOutcome["kind"]>(
  o: RoutineFlowOutcome,
  kind: K,
): Extract<RoutineFlowOutcome, { kind: K }> | null {
  return o.kind === kind ? (o as Extract<RoutineFlowOutcome, { kind: K }>) : null
}

const AgentForm: Component<{
  step: AgentStep
  onChange: (s: RoutineFlowStep) => void
  ctx: Ctx
}> = (props) => {
  const i18n = useI18n()
  const tid = () => `flow-step-${props.step.id}`
  const outcomes = () => props.step.outcomes ?? []
  const setOutcome = (i: number, o: RoutineFlowOutcome) =>
    props.onChange({ ...props.step, outcomes: outcomes().map((x, j) => (j === i ? o : x)) })
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <TextArea
        value={props.step.prompt}
        onChange={(v) => props.onChange({ ...props.step, prompt: v })}
        testid={`${tid()}-prompt`}
        label={i18n.t("kernel.routineFlow.prompt")}
        rows={3}
      />
      <span class={labelClass}>{i18n.t("kernel.routineFlow.outcomes")}</span>
      <ul class="flex min-w-0 flex-col gap-2">
        <Index each={outcomes()}>
          {(o, i) => (
            <li class="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle p-2">
              <div class="flex min-w-0 items-end gap-2">
                <label class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class={labelClass}>{i18n.t("kernel.routineFlow.outcomeKind")}</span>
                  <select
                    data-testid={`${tid()}-outcome-${i}-kind`}
                    class={fieldClass}
                    value={o().kind}
                    onChange={(e) =>
                      setOutcome(
                        i,
                        defaultOutcome(e.currentTarget.value as (typeof OUTCOME_KINDS)[number]),
                      )
                    }
                  >
                    <For each={OUTCOME_KINDS}>
                      {(k) => (
                        <option value={k}>{i18n.t(`kernel.routineFlow.outcome_${k}`)}</option>
                      )}
                    </For>
                  </select>
                </label>
                <button
                  type="button"
                  data-testid={`${tid()}-outcome-${i}-remove`}
                  class="shrink-0 rounded px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-surface-hover"
                  onClick={() =>
                    props.onChange({
                      ...props.step,
                      outcomes: outcomes().filter((_, j) => j !== i),
                    })
                  }
                >
                  {i18n.t("kernel.routineFlow.remove")}
                </button>
              </div>
              <Show when={pickOutcome(o(), "message_posted")}>
                {(x) => (
                  <PersonSelect
                    value={x().to}
                    onChange={(v) => setOutcome(i, { kind: "message_posted", to: v })}
                    ctx={props.ctx}
                    testid={`${tid()}-outcome-${i}-person`}
                    label={i18n.t("kernel.routineFlow.recipient")}
                  />
                )}
              </Show>
              <Show when={pickOutcome(o(), "field_set")}>
                {(x) => (
                  <FieldSelect
                    value={x().field}
                    onChange={(v) => setOutcome(i, { kind: "field_set", field: v })}
                    ctx={props.ctx}
                    testid={`${tid()}-outcome-${i}-field`}
                    label={i18n.t("kernel.routineFlow.field")}
                  />
                )}
              </Show>
              <Show when={pickOutcome(o(), "status_is")}>
                {(x) => (
                  <StatusSelect
                    value={x().status}
                    onChange={(v) => setOutcome(i, { kind: "status_is", status: v })}
                    ctx={props.ctx}
                    testid={`${tid()}-outcome-${i}-status`}
                    label={i18n.t("kernel.routineFlow.status")}
                  />
                )}
              </Show>
              <Show when={pickOutcome(o(), "tool_called")}>
                {(x) => (
                  <label class="flex min-w-0 flex-col gap-1">
                    <span class={labelClass}>{i18n.t("kernel.routineFlow.tool")}</span>
                    <input
                      data-testid={`${tid()}-outcome-${i}-tool`}
                      class={fieldClass}
                      value={x().tool}
                      onInput={(e) =>
                        setOutcome(i, { kind: "tool_called", tool: e.currentTarget.value })
                      }
                    />
                  </label>
                )}
              </Show>
            </li>
          )}
        </Index>
      </ul>
      <Show when={outcomes().length < 10}>
        <button
          type="button"
          data-testid={`${tid()}-outcome-add`}
          class="self-start rounded px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-hover"
          onClick={() =>
            props.onChange({
              ...props.step,
              outcomes: [...outcomes(), defaultOutcome("message_posted")],
            })
          }
        >
          {i18n.t("kernel.routineFlow.addOutcome")}
        </button>
      </Show>
    </div>
  )
}

/** The whole inline form of one step: its type's fields, then "Only if". */
export const FlowStepForm: Component<{
  step: RoutineFlowStep
  onChange: (s: RoutineFlowStep) => void
  ctx: Ctx
}> = (props) => {
  const i18n = useI18n()
  const tid = () => `flow-step-${props.step.id}`
  const setIf = (c: RoutineFlowCondition | undefined) => {
    const { if: _old, ...rest } = props.step
    props.onChange((c ? { ...rest, if: c } : rest) as RoutineFlowStep)
  }
  return (
    <div class="flex min-w-0 flex-col gap-3" data-testid={`${tid()}-form`}>
      <Show when={props.step.type === "action" ? (props.step as ActionStep) : null}>
        {(s) => <ActionForm step={s()} onChange={props.onChange} ctx={props.ctx} />}
      </Show>
      <Show when={props.step.type === "wait" ? (props.step as WaitStep) : null}>
        {(s) => <WaitForm step={s()} onChange={props.onChange} ctx={props.ctx} />}
      </Show>
      <Show when={props.step.type === "agent" ? (props.step as AgentStep) : null}>
        {(s) => <AgentForm step={s()} onChange={props.onChange} ctx={props.ctx} />}
      </Show>
      <div class="flex min-w-0 flex-col gap-1">
        <label class="flex items-center gap-2 text-[13px] text-text">
          <input
            type="checkbox"
            data-testid={`${tid()}-if-toggle`}
            checked={props.step.if !== undefined}
            onChange={(e) =>
              setIf(e.currentTarget.checked ? { field: "status", op: "eq", value: "" } : undefined)
            }
          />
          <span>{i18n.t("kernel.routineFlow.onlyIf")}</span>
        </label>
        <Show when={props.step.if}>
          {(c) => (
            <ConditionEditor value={c()} onChange={setIf} ctx={props.ctx} testid={`${tid()}-if`} />
          )}
        </Show>
      </div>
    </div>
  )
}

export type { Ctx as FlowFormContext }
