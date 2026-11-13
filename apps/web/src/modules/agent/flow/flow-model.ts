// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pure helpers behind the routine flow list (FlowList.tsx): the words for a
 * trigger, a step, a condition and an outcome; the "if" grouping (consecutive
 * steps sharing the same `if` render indented under one line); and the edits
 * (add, remove, move, new ids). The flow shape is the shared schema's
 * (`routineFlowSchema`, packages/shared validation/agent/routines.ts).
 */
import type {
  RoutineFlow,
  RoutineFlowCondition,
  RoutineFlowOutcome,
  RoutineFlowStep,
} from "@liaison/shared"
import { routineEventFilterSchema, routineFlowSchema } from "@liaison/shared"
import type { Translate } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { prettyStatus } from "~/modules/projects/status-label"

/** The project a flow's trigger and steps name: its statuses and task fields. */
export interface FlowProject {
  id: string
  name: string
  statuses: ReadonlyArray<{ id: string; label: string }>
  fields: ReadonlyArray<FlowField>
}

export interface FlowField {
  key: string
  label: string
  type: string
  choices?: string[]
}

export interface FlowPerson {
  id: string
  name: string
}

/** What the words need to name things: the project and the people. */
export interface FlowNames {
  project?: FlowProject | null
  people?: ReadonlyArray<FlowPerson>
  t: Translate
  /** For plural forms; English when absent. */
  locale?: string
}

/** A run's state for one step (routine_runs.steps, 0303). */
export interface FlowRunStep {
  id: string
  type?: "action" | "wait" | "agent"
  state:
    | "pending"
    | "running"
    | "done"
    | "skipped"
    | "failed"
    | "flagged"
    | "waiting"
    | "awaiting_approval"
  startedAt?: string | null
  endedAt?: string | null
  note?: string | null
}

/** The projects event filter keys (0303) next to the older filter keys. */
export interface FlowEventFilter {
  projectId?: string
  fromStatusId?: string | null
  toStatusId?: string
  fields?: Record<string, unknown>
}

export const PROJECT_TASK_EVENTS = [
  "projects:task:status_changed",
  "projects:task:updated",
  "projects:task:created",
] as const

export const WAIT_UNITS = ["working_hours", "working_days", "hours", "days"] as const
export type WaitUnit = (typeof WAIT_UNITS)[number]

export const ACTION_KINDS = [
  "assign",
  "set_status",
  "set_field",
  "message",
  "notify",
  "comment",
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export type ActionStep = Extract<RoutineFlowStep, { type: "action" }>
export type WaitStep = Extract<RoutineFlowStep, { type: "wait" }>
export type AgentStep = Extract<RoutineFlowStep, { type: "agent" }>

const OWNER = "{{owner}}"
const ASSIGNEE = "{{task.assigneeId}}"

// ── Names ─────────────────────────────────────────────────────────────────────

export function statusName(names: FlowNames, id: string | null | undefined): string {
  if (!id) return names.t("kernel.routineFlow.unknownStatus")
  const s = names.project?.statuses.find((x) => x.id === id)
  return s ? prettyStatus(s.label) : names.t("kernel.routineFlow.unknownStatus")
}

export function personName(names: FlowNames, ref: string): string {
  if (ref === OWNER) return names.t("kernel.routineFlow.personOwner")
  if (ref === ASSIGNEE) return names.t("kernel.routineFlow.personAssignee")
  const p = names.people?.find((x) => x.id === ref)
  return p ? p.name : names.t("kernel.routineFlow.personUnknown")
}

function fieldLabel(names: FlowNames, key: string): string {
  return names.project?.fields.find((f) => f.key === key)?.label ?? key
}

function joinList(names: FlowNames, items: string[], word: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? ""
  const sep = names.t(word === "and" ? "kernel.routineFlow.and" : "kernel.routineFlow.or")
  return `${items.slice(0, -1).join(", ")} ${sep} ${items[items.length - 1]}`
}

function valueWords(names: FlowNames, field: string, value: unknown): string {
  if (field === "status" && typeof value === "string") return statusName(names, value)
  if (field === "assignee" && typeof value === "string") return personName(names, value)
  if (value === null || value === undefined) return names.t("kernel.routineFlow.nothing")
  if (typeof value === "boolean") {
    return names.t(value ? "kernel.routineFlow.yes" : "kernel.routineFlow.no")
  }
  return String(value)
}

function conditionFieldName(names: FlowNames, field: string): string {
  if (field === "status") return names.t("kernel.routineFlow.fieldStatus")
  if (field === "assignee") return names.t("kernel.routineFlow.fieldAssignee")
  return fieldLabel(names, field.replace(/^fields\./, ""))
}

/** A condition in words: "the status is Done", "nobody is assigned", ... */
export function describeCondition(names: FlowNames, c: RoutineFlowCondition): string {
  if ("all" in c) {
    return joinList(
      names,
      c.all.map((x) => describeCondition(names, x)),
      "and",
    )
  }
  if ("any" in c) {
    return joinList(
      names,
      c.any.map((x) => describeCondition(names, x)),
      "or",
    )
  }
  if (!("field" in c)) return names.t("kernel.routineFlow.condUnchanged")
  const field = conditionFieldName(names, c.field)
  if (c.op === "empty") {
    return c.field === "assignee"
      ? names.t("kernel.routineFlow.condNobodyAssigned")
      : names.t("kernel.routineFlow.condEmpty", { field })
  }
  if (c.op === "not_empty") {
    return c.field === "assignee"
      ? names.t("kernel.routineFlow.condSomeoneAssigned")
      : names.t("kernel.routineFlow.condNotEmpty", { field })
  }
  if (c.op === "in") {
    const values = Array.isArray(c.value) ? c.value : []
    return names.t("kernel.routineFlow.condIn", {
      field,
      values: joinList(
        names,
        values.map((v) => valueWords(names, c.field, v)),
        "or",
      ),
    })
  }
  return names.t("kernel.routineFlow.condEq", {
    field,
    value: valueWords(names, c.field, c.value),
  })
}

/** The trigger in words: "When a task in Website moves from To do to Doing". */
export function describeTrigger(
  names: FlowNames,
  event: string | null | undefined,
  filter: FlowEventFilter | null | undefined,
  fallback: string,
): string {
  const parts = triggerParts(names, event, filter)
  if (!parts) return fallback
  if (parts.fields.length === 0) return parts.head
  return names.t("kernel.routineFlow.triggerWithFields", {
    trigger: parts.head,
    fields: joinList(names, parts.fields, "and"),
  })
}

/**
 * A projects task trigger in words, its event line and one phrase per field filter
 * ("Priority is high or urgent"); null when the event is not a projects task event.
 */
export function triggerParts(
  names: FlowNames,
  event: string | null | undefined,
  filter: FlowEventFilter | null | undefined,
): { head: string; fields: string[] } | null {
  const project = names.project?.name ?? names.t("kernel.routineFlow.aProject")
  const f = filter ?? {}
  let head: string
  if (event === "projects:task:status_changed") {
    if (f.toStatusId && f.fromStatusId === null) {
      head = names.t("kernel.routineFlow.triggerCreatedIn", {
        project,
        to: statusName(names, f.toStatusId),
      })
    } else if (f.toStatusId && f.fromStatusId) {
      head = names.t("kernel.routineFlow.triggerFromTo", {
        project,
        from: statusName(names, f.fromStatusId),
        to: statusName(names, f.toStatusId),
      })
    } else if (f.toStatusId) {
      head = names.t("kernel.routineFlow.triggerTo", {
        project,
        to: statusName(names, f.toStatusId),
      })
    } else {
      head = names.t("kernel.routineFlow.triggerAnyMove", { project })
    }
  } else if (event === "projects:task:created") {
    head = names.t("kernel.routineFlow.triggerCreated", { project })
  } else if (event === "projects:task:updated") {
    head = names.t("kernel.routineFlow.triggerUpdated", { project })
  } else {
    return null
  }
  const fields = f.fields && typeof f.fields === "object" ? Object.entries(f.fields) : []
  const parts = fields.map(([key, v]) => {
    const vals = Array.isArray(v) ? v : [v]
    return names.t("kernel.routineFlow.condIn", {
      field: fieldLabel(names, key),
      values: joinList(
        names,
        vals.map((x) => valueWords(names, `fields.${key}`, x)),
        "or",
      ),
    })
  })
  return { head, fields: parts }
}

/** One step in words (its title line). */
export function describeStep(names: FlowNames, step: RoutineFlowStep): string {
  if (step.type === "wait") {
    const form = pluralFormFor(names.locale ?? "en", step.for.amount)
    return names.t(`kernel.routineFlow.wait_${step.for.unit}_${form}`, { n: step.for.amount })
  }
  if (step.type === "agent") {
    const first = step.prompt.split("\n")[0]?.trim() ?? ""
    return first
      ? names.t("kernel.routineFlow.agentStep", { prompt: first })
      : names.t("kernel.routineFlow.agentStepEmpty")
  }
  switch (step.action) {
    case "assign": {
      const to = step.args.to
      if (typeof to === "string") {
        return names.t("kernel.routineFlow.assignTo", { person: personName(names, to) })
      }
      return names.t("kernel.routineFlow.assignLeastLoaded", {
        people: joinList(
          names,
          to.leastLoaded.map((id) => personName(names, id)),
          "or",
        ),
      })
    }
    case "set_status":
      return names.t("kernel.routineFlow.setStatus", {
        status: statusName(names, step.args.statusId),
      })
    case "set_field":
      return names.t("kernel.routineFlow.setField", {
        field: fieldLabel(names, step.args.key),
        value: Array.isArray(step.args.value)
          ? step.args.value.join(", ")
          : valueWords(names, `fields.${step.args.key}`, step.args.value),
      })
    case "message":
      return names.t("kernel.routineFlow.messageTo", { person: personName(names, step.args.to) })
    case "notify":
      return names.t("kernel.routineFlow.notifyTo", {
        people: joinList(
          names,
          step.args.to.map((p) => personName(names, p)),
          "and",
        ),
      })
    case "comment":
      return names.t("kernel.routineFlow.comment")
  }
}

/** The step's text body (a message, a note), shown under its title. */
// ── Placeholders ──────────────────────────────────────────────────────────────

/** A placeholder a message can carry, and its words ("task title"). */
export interface FlowPlaceholder {
  token: string
  label: string
}

const TASK_PLACEHOLDERS = ["title", "key", "url", "assigneeName"] as const

/** The placeholders a message step offers: the task's own, then each project field. */
export function flowPlaceholders(names: FlowNames): FlowPlaceholder[] {
  const own = TASK_PLACEHOLDERS.map((k) => ({
    token: `{{task.${k}}}`,
    label: names.t(`kernel.routineFlow.ph_${k}`),
  }))
  const fields = (names.project?.fields ?? []).map((f) => ({
    token: `{{task.fields.${f.key}}}`,
    label: names.t("kernel.routineFlow.ph_field", { label: f.label }),
  }))
  return [...own, ...fields]
}

export type FlowTextPart =
  | { kind: "text"; text: string }
  | { kind: "token"; token: string; label: string }

/**
 * A message's text cut into plain runs and placeholders, each placeholder named in words
 * ("task title", "field: Priority") for view mode. A token it does not know stays text.
 */
export function textParts(names: FlowNames, text: string): FlowTextPart[] {
  const parts: FlowTextPart[] = []
  const re = /\{\{\s*task\.([a-zA-Z]+)(?:\.([^}\s]+))?\s*\}\}/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [token, head, key] = m
    let label: string | null = null
    if (head === "fields" && key) {
      label = names.t("kernel.routineFlow.ph_field", { label: fieldLabel(names, key) })
    } else if (!key && (TASK_PLACEHOLDERS as readonly string[]).includes(head ?? "")) {
      label = names.t(`kernel.routineFlow.ph_${head}`)
    } else if (!key && head === "assigneeId") {
      label = names.t("kernel.routineFlow.ph_assigneeName")
    }
    if (label === null) continue
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) })
    parts.push({ kind: "token", token, label })
    last = m.index + token.length
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) })
  return parts
}

/** `text` with `token` put in at `at` (a caret offset), a space added where words would touch. */
export function insertPlaceholder(text: string, at: number, token: string): string {
  const pos = Math.max(0, Math.min(at, text.length))
  const before = text.slice(0, pos)
  const after = text.slice(pos)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const tail = after && !/^\s/.test(after) ? " " : ""
  return `${before}${lead}${token}${tail}${after}`
}

export function stepText(step: RoutineFlowStep): string | null {
  if (step.type !== "action") return null
  if (step.action === "message" || step.action === "notify" || step.action === "comment") {
    return step.args.text
  }
  return null
}

/** A required outcome in words, for its badge. */
export function describeOutcome(names: FlowNames, o: RoutineFlowOutcome): string {
  switch (o.kind) {
    case "message_posted":
      return names.t("kernel.routineFlow.outcomeMessage", { person: personName(names, o.to) })
    case "field_set":
      return names.t("kernel.routineFlow.outcomeField", { field: fieldLabel(names, o.field) })
    case "status_is":
      return names.t("kernel.routineFlow.outcomeStatus", { status: statusName(names, o.status) })
    case "tool_called":
      return names.t("kernel.routineFlow.outcomeTool", { tool: o.tool })
  }
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/** Stable key of a step's `if` (consecutive steps with the same key share a branch). */
export function conditionKey(c: RoutineFlowCondition | undefined): string | null {
  return c ? JSON.stringify(c) : null
}

export interface FlowGroup {
  /** The shared condition; null for steps that always run. */
  condition: RoutineFlowCondition | null
  /** Indices into flow.steps, in order. */
  indices: number[]
}

/** Consecutive steps sharing the same `if` form one indented group. */
export function groupSteps(steps: readonly RoutineFlowStep[]): FlowGroup[] {
  const out: FlowGroup[] = []
  let lastKey: string | null | undefined
  steps.forEach((s, i) => {
    const key = conditionKey(s.if)
    const last = out[out.length - 1]
    if (last && key === lastKey) last.indices.push(i)
    else out.push({ condition: s.if ?? null, indices: [i] })
    lastKey = key
  })
  return out
}

// ── Edits ─────────────────────────────────────────────────────────────────────

/** A step id not yet used in the flow. */
export function nextStepId(steps: readonly RoutineFlowStep[], base: string): string {
  const used = new Set(steps.map((s) => s.id))
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`
    if (!used.has(id)) return id
  }
}

export function defaultAction(
  id: string,
  kind: ActionKind,
  keepIf?: RoutineFlowCondition,
): ActionStep {
  const base = { id, type: "action" as const, ...(keepIf ? { if: keepIf } : {}) }
  switch (kind) {
    case "assign":
      return { ...base, action: "assign", args: { to: OWNER } }
    case "set_status":
      return { ...base, action: "set_status", args: { statusId: "" } }
    case "set_field":
      return { ...base, action: "set_field", args: { key: "", value: "" } }
    case "message":
      return { ...base, action: "message", args: { to: ASSIGNEE, text: "" } }
    case "notify":
      return { ...base, action: "notify", args: { to: [OWNER], text: "" } }
    case "comment":
      return { ...base, action: "comment", args: { text: "" } }
  }
}

export function newStep(
  steps: readonly RoutineFlowStep[],
  type: "action" | "wait" | "agent",
): RoutineFlowStep {
  if (type === "wait") {
    return {
      id: nextStepId(steps, "wait"),
      type: "wait",
      for: { amount: 1, unit: "working_days" },
      until: { op: "status_unchanged_since_trigger" },
    }
  }
  if (type === "agent") {
    return { id: nextStepId(steps, "agent"), type: "agent", prompt: "", outcomes: [] }
  }
  return defaultAction(nextStepId(steps, "action"), "notify")
}

export function moveStep(flow: RoutineFlow, index: number, delta: -1 | 1): RoutineFlow {
  const to = index + delta
  if (to < 0 || to >= flow.steps.length) return flow
  const steps = [...flow.steps]
  const [s] = steps.splice(index, 1)
  if (s) steps.splice(to, 0, s)
  return { ...flow, steps }
}

export function removeStep(flow: RoutineFlow, index: number): RoutineFlow {
  return { ...flow, steps: flow.steps.filter((_, i) => i !== index) }
}

export function replaceStep(flow: RoutineFlow, index: number, step: RoutineFlowStep): RoutineFlow {
  return { ...flow, steps: flow.steps.map((s, i) => (i === index ? step : s)) }
}

export function appendStep(flow: RoutineFlow, step: RoutineFlowStep): RoutineFlow {
  return { ...flow, steps: [...flow.steps, step] }
}

// ── Templates ─────────────────────────────────────────────────────────────────

/**
 * Fills a template's `{{projectId}}` and `{{status:<label>}}` placeholders for
 * one project, leniently: a status the project lacks becomes "" (the editor
 * then asks for it) instead of failing the whole prefill. The server's
 * strict twin is `resolveRoutineTemplatePlaceholders` (shared).
 */
export function fillTemplate<T>(
  value: T,
  project: { id: string; statuses: ReadonlyArray<{ id: string; label: string }> },
): { value: T; missing: string[] } {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "_")
  const byLabel = new Map(project.statuses.map((s) => [norm(s.label), s.id]))
  const missing = new Set<string>()
  const fill = (s: string): string =>
    s
      .replace(/\{\{\s*projectId\s*\}\}/g, project.id)
      .replace(/\{\{\s*status:([^}]+)\}\}/g, (_, label: string) => {
        const id = byLabel.get(norm(label))
        if (!id) missing.add(label.trim())
        return id ?? ""
      })
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fill(v)
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== "")
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return { value: walk(value) as T, missing: [...missing] }
}

/** The run's state for one step; a step the run never reached is pending. */
export function runStateFor(runSteps: readonly FlowRunStep[] | null | undefined, id: string) {
  return runSteps?.find((s) => s.id === id) ?? null
}

/**
 * Why a flow (and its trigger filter) cannot be saved yet, in the schema's own
 * words, or null when it can. The server checks the same schemas.
 */
export function flowProblem(
  t: Translate,
  flow: RoutineFlow,
  event: string | null,
  filter: FlowEventFilter | null,
): string | null {
  if (event === "projects:task:status_changed" && !filter?.toStatusId) {
    return t("kernel.routineFlow.problemToStatus")
  }
  const f = routineFlowSchema.safeParse(flow)
  if (!f.success) {
    const issue = f.error.issues[0]
    const stepIndex = typeof issue?.path[1] === "number" ? issue.path[1] : null
    const where =
      stepIndex !== null ? t("kernel.routineFlow.problemStep", { n: stepIndex + 1 }) : ""
    return `${where}${issue?.message ?? t("kernel.routineFlow.problemGeneric")}`
  }
  if (filter) {
    const g = routineEventFilterSchema.safeParse(filter)
    if (!g.success) return g.error.issues[0]?.message ?? t("kernel.routineFlow.problemGeneric")
  }
  return null
}
