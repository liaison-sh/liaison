// SPDX-License-Identifier: FSL-1.1-ALv2
// One declared field: the control for its type, saved on its own (S10: on
// blur for typed values, on change for toggles, choices, dates and hours),
// with its state beside the label ("Saved", "Waiting for approval", "Not
// saved") and the server's message under it with a Retry.
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch as SwitchCase,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Switch } from "~/ui/Switch"
import { labelOf, optionsOf } from "./page-model"
import { callAppTool, type SaveOutcome } from "./settings-api"
import { isSupportedFieldType } from "./supported"
import type { SettingsListCreateField } from "./types"
import { UnsupportedSettingsPart } from "./UnsupportedSettingsPart"

const P = "kernel.settingsPage"

export const controlClass =
  "w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 placeholder:text-text-tertiary focus:border-accent-muted disabled:opacity-60"

type FieldStatus = "idle" | "saving" | "saved" | "pending" | "error"

export interface FieldBlockProps {
  app: string
  field: SettingsListCreateField
  /** The stored value (or the declared default). */
  value: unknown
  /** The value could not be read: the field is shown read-only. */
  readError?: { code: string; message: string }
  /** No write possible (an org field the viewer cannot administer). */
  readOnly?: boolean
  save: (path: string, value: unknown) => Promise<SaveOutcome>
  /** A save went through: the page keeps the new value. */
  onSaved: (value: unknown) => void
  /**
   * The field belongs to a section saved as one unit (M1): an edit goes here
   * and waits for the section's Save; the field saves nothing on its own.
   */
  onDraft?: (value: unknown) => void
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** A declared field that saves itself. */
export const FieldBlock: Component<FieldBlockProps> = (props) => {
  const i18n = useI18n()
  const [status, setStatus] = createSignal<FieldStatus>("idle")
  const [error, setError] = createSignal<string | null>(null)
  // The value being saved, waiting for approval, or refused: shown in place of
  // the stored one until a save goes through.
  const [attempt, setAttempt] = createSignal<{ v: unknown } | null>(null)
  const current = () => {
    const a = attempt()
    return a ? a.v : props.value
  }
  const disabled = () => props.readOnly === true || props.readError !== undefined
  const key = () => props.field.key

  async function commit(next: unknown): Promise<void> {
    if (disabled()) return
    if (props.onDraft) {
      props.onDraft(next)
      return
    }
    if (status() !== "error" && attempt() === null && same(next, props.value)) return
    setAttempt({ v: next })
    setStatus("saving")
    setError(null)
    try {
      const out = await props.save(key(), next)
      if (out.kind === "pending") {
        setStatus("pending")
        return
      }
      props.onSaved(out.value)
      setAttempt(null)
      setStatus("saved")
      addToast({ message: i18n.t(`${P}.savedToast`), type: "success" })
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function retry(): void {
    const a = attempt()
    if (a) void commit(a.v)
  }

  const statusText = () => {
    if (props.readError?.code === "pending") return i18n.t(`${P}.waitingApproval`)
    switch (status()) {
      case "saving":
        return i18n.t(`${P}.saving`)
      case "saved":
        return i18n.t(`${P}.saved`)
      case "pending":
        return i18n.t(`${P}.waitingApproval`)
      case "error":
        return i18n.t(`${P}.notSaved`)
      default:
        return ""
    }
  }
  const label = () => labelOf(i18n.t, props.field.labelKey, props.field.label)
  const help = () =>
    props.field.help ? labelOf(i18n.t, props.field.helpKey, props.field.help) : undefined

  const inline = () => props.field.type === "toggle"

  return (
    <div
      class={cn("flex flex-col gap-1.5", inline() && "min-h-11 justify-center")}
      data-testid={`settings-field-${key()}`}
      data-status={status()}
    >
      <div class={cn("flex items-start gap-3", inline() ? "justify-between" : "")}>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <label for={`settings-${key()}`} class="text-[12.5px] font-medium text-text-secondary">
              {label()}
            </label>
            <span
              class="whitespace-nowrap text-[11px] text-text-tertiary"
              data-testid={`settings-field-status-${key()}`}
            >
              {statusText()}
            </span>
          </div>
          <Show when={inline() && help()}>
            <div class="mt-0.5 text-xs text-text-secondary">{help()}</div>
          </Show>
        </div>
        <Show when={inline()}>
          <Switch
            checked={current() === true}
            onChange={(next) => void commit(next)}
            label={label()}
            disabled={disabled()}
            data-testid={`settings-input-${key()}`}
          />
        </Show>
      </div>
      <Show when={!inline()}>
        <FieldControl
          app={props.app}
          field={props.field}
          value={current()}
          disabled={disabled()}
          invalid={status() === "error"}
          onCommit={(v) => void commit(v)}
        />
        <Show when={help()}>
          <span class="text-xs text-text-tertiary">{help()}</span>
        </Show>
      </Show>
      <Show when={props.readError && props.readError.code !== "pending"}>
        <span
          class="text-xs text-text-secondary"
          data-testid={`settings-field-unavailable-${key()}`}
        >
          {i18n.t(`${P}.fieldUnavailable`, { message: props.readError?.message ?? "" })}
        </span>
      </Show>
      <Show when={status() === "error" && error()}>
        <div class="flex items-center gap-2">
          <span class="text-xs text-error" data-testid={`settings-field-error-${key()}`}>
            {error()}
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid={`settings-field-retry-${key()}`}
            onClick={retry}
          >
            {i18n.t(`${P}.retry`)}
          </Button>
        </div>
      </Show>
    </div>
  )
}

interface ControlProps {
  app: string
  field: SettingsListCreateField
  value: unknown
  disabled?: boolean
  invalid?: boolean
  /** A finished edit (blur, change). */
  onCommit: (value: unknown) => void
}

/** The control of a non-toggle field. Also used, uncommitted, by a list block's create form. */
export const FieldControl: Component<ControlProps> = (props) => {
  const id = () => `settings-${props.field.key}`
  const testId = () => `settings-input-${props.field.key}`
  return (
    <SwitchCase fallback={<TextControl {...props} id={id()} testId={testId()} />}>
      {/* A type from a newer server: never guessed at as a text box. */}
      <Match when={!isSupportedFieldType(props.field.type)}>
        <UnsupportedSettingsPart />
      </Match>
      <Match when={props.field.type === "textarea"}>
        <TextControl {...props} id={id()} testId={testId()} multiline />
      </Match>
      <Match when={props.field.type === "number"}>
        <NumberControl {...props} id={id()} testId={testId()} />
      </Match>
      <Match when={props.field.type === "duration"}>
        <DurationControl {...props} id={id()} testId={testId()} />
      </Match>
      <Match when={props.field.type === "select"}>
        <SelectControl {...props} id={id()} testId={testId()} />
      </Match>
      <Match when={props.field.type === "multiselect"}>
        <MultiSelectControl {...props} testId={testId()} />
      </Match>
      <Match when={props.field.type === "date"}>
        <input
          id={id()}
          type="date"
          class={cn(controlClass, props.invalid && "border-error")}
          data-testid={testId()}
          value={typeof props.value === "string" ? props.value : ""}
          disabled={props.disabled}
          onChange={(e) => props.onCommit(e.currentTarget.value || null)}
        />
      </Match>
      <Match when={props.field.type === "dates"}>
        <DatesControl {...props} testId={testId()} />
      </Match>
      <Match when={props.field.type === "schedule"}>
        <ScheduleControl {...props} testId={testId()} />
      </Match>
      <Match when={props.field.type === "toggle"}>
        <Switch
          checked={props.value === true}
          onChange={(next) => props.onCommit(next)}
          label={props.field.label}
          disabled={props.disabled}
          data-testid={testId()}
        />
      </Match>
    </SwitchCase>
  )
}

type Ctl = ControlProps & { id?: string; testId: string }

const TextControl: Component<Ctl & { multiline?: boolean }> = (props) => {
  const [draft, setDraft] = createSignal<string | null>(null)
  const shown = () => draft() ?? (typeof props.value === "string" ? props.value : "")
  const inputType = () =>
    props.field.type === "url" ? "url" : props.field.type === "email" ? "email" : "text"
  function finish(): void {
    const d = draft()
    if (d === null) return
    setDraft(null)
    props.onCommit(d === "" ? null : d)
  }
  return (
    <Show
      when={props.multiline}
      fallback={
        <input
          id={props.id}
          type={inputType()}
          value={shown()}
          disabled={props.disabled}
          class={cn(controlClass, props.invalid && "border-error")}
          aria-invalid={props.invalid || undefined}
          autocomplete="off"
          spellcheck={props.field.type === "text"}
          data-testid={props.testId}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={finish}
        />
      }
    >
      <textarea
        id={props.id}
        rows={4}
        class={cn(controlClass, "min-h-24 resize-y", props.invalid && "border-error")}
        value={shown()}
        disabled={props.disabled}
        data-testid={props.testId}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={finish}
      />
    </Show>
  )
}

const NumberControl: Component<Ctl> = (props) => {
  const [draft, setDraft] = createSignal<string | null>(null)
  const shown = () => draft() ?? (typeof props.value === "number" ? String(props.value) : "")
  function finish(): void {
    const d = draft()
    if (d === null) return
    setDraft(null)
    const n = d.trim() === "" ? null : Number(d)
    props.onCommit(n !== null && Number.isNaN(n) ? d : n)
  }
  return (
    <input
      id={props.id}
      type="number"
      inputmode="decimal"
      value={shown()}
      disabled={props.disabled}
      class={cn(controlClass, props.invalid && "border-error")}
      aria-invalid={props.invalid || undefined}
      data-testid={props.testId}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={finish}
    />
  )
}

const UNITS = [
  ["minutes", 60],
  ["hours", 3600],
  ["days", 86400],
] as const
type Unit = (typeof UNITS)[number][0]

function unitOf(seconds: unknown): Unit {
  if (typeof seconds !== "number" || seconds <= 0) return "minutes"
  if (seconds % 86400 === 0) return "days"
  if (seconds % 3600 === 0) return "hours"
  return "minutes"
}
const unitSeconds = (u: Unit) => UNITS.find(([n]) => n === u)?.[1] ?? 60

/** A duration in seconds, typed as a count of minutes, hours or days. */
const DurationControl: Component<Ctl> = (props) => {
  const i18n = useI18n()
  const [unitChoice, setUnitChoice] = createSignal<Unit | null>(null)
  const unit = () => unitChoice() ?? unitOf(props.value)
  const [draft, setDraft] = createSignal<string | null>(null)
  const shown = () =>
    draft() ?? (typeof props.value === "number" ? String(props.value / unitSeconds(unit())) : "")
  function commitCount(text: string, u: Unit): void {
    if (text.trim() === "") {
      props.onCommit(null)
      return
    }
    const n = Number(text)
    props.onCommit(Number.isFinite(n) ? Math.round(n * unitSeconds(u)) : text)
  }
  return (
    <div class="flex gap-2">
      <input
        id={props.id}
        type="number"
        inputmode="decimal"
        value={shown()}
        disabled={props.disabled}
        class={cn(controlClass, "min-w-0 flex-1", props.invalid && "border-error")}
        aria-invalid={props.invalid || undefined}
        data-testid={props.testId}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          const d = draft()
          if (d === null) return
          setDraft(null)
          commitCount(d, unit())
        }}
      />
      <select
        class={cn(controlClass, "w-auto")}
        aria-label={i18n.t(`${P}.durationUnit`)}
        data-testid={`${props.testId}-unit`}
        value={unit()}
        disabled={props.disabled}
        onChange={(e) => {
          const next = e.currentTarget.value as Unit
          const count = shown()
          setUnitChoice(next)
          if (count.trim() !== "") commitCount(count, next)
        }}
      >
        <For each={UNITS}>{([u]) => <option value={u}>{i18n.t(`${P}.unit.${u}`)}</option>}</For>
      </select>
    </div>
  )
}

function useOptions(props: Ctl) {
  const api = useApi()
  const i18n = useI18n()
  const [loaded] = createResource(
    () => props.field.optionsTool,
    async (tool) => {
      const out = await callAppTool(api, props.app, tool, {})
      return out.kind === "ok" ? optionsOf(out.data) : []
    },
  )
  return createMemo(() =>
    props.field.options
      ? props.field.options.map((o) => ({
          value: o.value,
          label: labelOf(i18n.t, o.labelKey, o.label),
        }))
      : (loaded() ?? []),
  )
}

const SelectControl: Component<Ctl> = (props) => {
  const i18n = useI18n()
  const options = useOptions(props)
  return (
    <select
      id={props.id}
      class={cn(controlClass, props.invalid && "border-error")}
      data-testid={props.testId}
      value={props.value === null || props.value === undefined ? "" : String(props.value)}
      disabled={props.disabled}
      onChange={(e) => {
        const raw = e.currentTarget.value
        const opt = options().find((o) => String(o.value) === raw)
        props.onCommit(opt ? opt.value : null)
      }}
    >
      <option value="">{i18n.t(`${P}.choose`)}</option>
      <For each={options()}>{(o) => <option value={String(o.value)}>{o.label}</option>}</For>
    </select>
  )
}

const MultiSelectControl: Component<Ctl> = (props) => {
  const options = useOptions(props)
  const chosen = () => (Array.isArray(props.value) ? (props.value as unknown[]) : [])
  function toggle(v: string | number): void {
    const has = chosen().includes(v)
    const next = options()
      .map((o) => o.value)
      .filter((x) => (x === v ? !has : chosen().includes(x)))
    props.onCommit(next)
  }
  return (
    <div class="flex flex-wrap gap-1.5" role="group">
      <For each={options()}>
        {(o) => (
          <button
            type="button"
            aria-pressed={chosen().includes(o.value)}
            disabled={props.disabled}
            data-testid={`${props.testId}-opt-${o.value}`}
            class={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              chosen().includes(o.value)
                ? "border-accent bg-accent font-medium text-accent-foreground"
                : "border-border text-text-secondary hover:bg-surface-hover",
            )}
            onClick={() => toggle(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}

interface Holiday {
  date: string
  label: string
}

/** Named dates (holidays): a row per date, and a small add row. */
const DatesControl: Component<Ctl> = (props) => {
  const i18n = useI18n()
  const list = (): Holiday[] =>
    Array.isArray(props.value)
      ? (props.value as unknown[]).filter(
          (d): d is Holiday =>
            typeof d === "object" && d !== null && typeof (d as Holiday).date === "string",
        )
      : []
  const [newDate, setNewDate] = createSignal("")
  const [newLabel, setNewLabel] = createSignal("")
  function add(): void {
    if (!newDate() || !newLabel().trim()) return
    const next = [...list(), { date: newDate(), label: newLabel().trim() }].sort((a, b) =>
      a.date.localeCompare(b.date),
    )
    setNewDate("")
    setNewLabel("")
    props.onCommit(next)
  }
  return (
    <div class="flex flex-col gap-2" data-testid={props.testId}>
      <Show
        when={list().length > 0}
        fallback={<span class="text-xs text-text-tertiary">{i18n.t(`${P}.noDates`)}</span>}
      >
        <ul class="flex flex-col divide-y divide-border-subtle rounded-sm border border-border">
          <For each={list()}>
            {(d, i) => (
              <li class="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                <span class="font-mono text-xs text-text-secondary">{d.date}</span>
                <span class="min-w-0 flex-1 truncate">{d.label}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.disabled}
                  data-testid={`${props.testId}-remove-${i()}`}
                  onClick={() => props.onCommit(list().filter((_, j) => j !== i()))}
                >
                  {i18n.t(`${P}.remove`)}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <input
          type="date"
          class={cn(controlClass, "w-auto")}
          aria-label={i18n.t(`${P}.newDate`)}
          data-testid={`${props.testId}-new-date`}
          value={newDate()}
          disabled={props.disabled}
          onInput={(e) => setNewDate(e.currentTarget.value)}
          onChange={(e) => setNewDate(e.currentTarget.value)}
        />
        <input
          type="text"
          class={cn(controlClass, "min-w-0 flex-1")}
          placeholder={i18n.t(`${P}.newDateLabel`)}
          aria-label={i18n.t(`${P}.newDateLabel`)}
          autocomplete="off"
          data-testid={`${props.testId}-new-label`}
          value={newLabel()}
          disabled={props.disabled}
          onInput={(e) => setNewLabel(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add()
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled || !newDate() || !newLabel().trim()}
          data-testid={`${props.testId}-add`}
          onClick={add}
        >
          {i18n.t(`${P}.add`)}
        </Button>
      </div>
    </div>
  )
}

export const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
type Day = (typeof WEEK_DAYS)[number]
type Weekly = Record<Day, Array<[string, string]>>

function weeklyOf(v: unknown): Weekly {
  const src = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
  const out = {} as Weekly
  for (const d of WEEK_DAYS) {
    const day = src[d]
    out[d] = Array.isArray(day)
      ? day.filter(
          (w): w is [string, string] =>
            Array.isArray(w) && typeof w[0] === "string" && typeof w[1] === "string",
        )
      : []
  }
  return out
}

/** Weekly hours: per day open or closed, with its opening window (the SLA control's model). */
const ScheduleControl: Component<Ctl> = (props) => {
  const i18n = useI18n()
  const weekly = () => weeklyOf(props.value)
  function setDay(day: Day, windows: Array<[string, string]>): void {
    props.onCommit({ ...weekly(), [day]: windows })
  }
  function setWindow(day: Day, which: 0 | 1, time: string): void {
    const [first, ...rest] = weekly()[day]
    const win: [string, string] = [...(first ?? ["09:00", "18:00"])] as [string, string]
    win[which] = time
    setDay(day, [win, ...rest])
  }
  const row = (day: Day): JSX.Element => {
    const open = () => weekly()[day].length > 0
    const win = () => weekly()[day][0] ?? ["09:00", "18:00"]
    return (
      <div
        class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-[13px]"
        data-testid={`${props.testId}-${day}`}
      >
        <label class="flex min-h-9 min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={open()}
            disabled={props.disabled}
            data-testid={`${props.testId}-${day}-enabled`}
            onChange={(e) => setDay(day, e.currentTarget.checked ? [["09:00", "18:00"]] : [])}
          />
          <span class="truncate">{i18n.t(`${P}.day.${day}`)}</span>
        </label>
        <Show
          when={open()}
          fallback={
            <span class="col-span-2 text-xs text-text-tertiary">{i18n.t(`${P}.closed`)}</span>
          }
        >
          <input
            type="time"
            class={cn(controlClass, "py-1")}
            aria-label={i18n.t(`${P}.opens`)}
            value={win()[0]}
            disabled={props.disabled}
            data-testid={`${props.testId}-${day}-start`}
            onChange={(e) => setWindow(day, 0, e.currentTarget.value)}
          />
          <input
            type="time"
            class={cn(controlClass, "py-1")}
            aria-label={i18n.t(`${P}.closes`)}
            value={win()[1]}
            disabled={props.disabled}
            data-testid={`${props.testId}-${day}-end`}
            onChange={(e) => setWindow(day, 1, e.currentTarget.value)}
          />
        </Show>
      </div>
    )
  }
  return (
    <div class="flex flex-col gap-1" data-testid={props.testId}>
      <For each={WEEK_DAYS}>{(d) => row(d)}</For>
    </div>
  )
}
