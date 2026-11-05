// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SchedulePicker — the routine scheduling control.
 *
 * Recurring mode: a row of preset chips (daily / weekdays / weekly / monthly /
 * custom) + a time field, a day-of-week selector for `weekly`, and a raw cron
 * input for `custom`. Emits `{ kind: "recurring", cron, timezone }`.
 *
 * Scheduled (one-shot) mode: a native `datetime-local` input. Emits
 * `{ kind: "scheduled", runAt }` as an ISO string; validates future-dated.
 *
 * Event mode: a searchable list of the org's subscribable `app:entity:action`
 * events, grouped by app, each row the human label over the raw string. Emits
 * `{ kind: "event", event }`. An event routine has no cadence and no clock, so
 * this mode shows neither a preset nor a preview.
 *
 * Crafted to read as a first-class scheduling control within the Liaison
 * charcoal/calm design language — no new tokens, no new dependencies.
 */
import { type Component, createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { cronPreview } from "./cron-preview"
import {
  cronFromPreset,
  describeRoutineEvent,
  loadRoutineEvents,
  localTimezone,
  presetFromCron,
  type RoutineEventRow,
  routinesStore,
  type SchedulePreset,
} from "./routines-store"

export type ScheduleValue =
  | { kind: "recurring"; cron: string; timezone: string }
  | { kind: "scheduled"; runAt: string }
  | { kind: "event"; event: string }

interface SchedulePickerProps {
  kind: "recurring" | "scheduled" | "event"
  /** Initial value when editing an existing routine. */
  value?: Partial<{ cron: string; timezone: string; runAt: string; event: string }>
  onChange: (value: ScheduleValue) => void
}

const PRESETS: { id: SchedulePreset; labelKey: string }[] = [
  { id: "daily", labelKey: "kernel.agentForms.presetDaily" },
  { id: "weekdays", labelKey: "kernel.agentForms.presetWeekdays" },
  { id: "weekly", labelKey: "kernel.agentForms.presetWeekly" },
  { id: "monthly", labelKey: "kernel.agentForms.presetMonthly" },
  { id: "custom", labelKey: "kernel.agentForms.presetCustom" },
]

const DOW = [
  { value: 1, labelKey: "kernel.agentForms.dayMon" },
  { value: 2, labelKey: "kernel.agentForms.dayTue" },
  { value: 3, labelKey: "kernel.agentForms.dayWed" },
  { value: 4, labelKey: "kernel.agentForms.dayThu" },
  { value: 5, labelKey: "kernel.agentForms.dayFri" },
  { value: 6, labelKey: "kernel.agentForms.daySat" },
  { value: 0, labelKey: "kernel.agentForms.daySun" },
]

const SchedulePicker: Component<SchedulePickerProps> = (props) => {
  const i18n = useI18n()
  const initial = presetFromCron(props.value?.cron ?? "")
  const [preset, setPreset] = createSignal<SchedulePreset>(initial.preset)
  const [time, setTime] = createSignal(initial.time)
  const [dayOfWeek, setDayOfWeek] = createSignal(initial.dayOfWeek)
  const [customCron, setCustomCron] = createSignal(
    initial.preset === "custom" ? (props.value?.cron ?? "") : "",
  )
  const [datetime, setDatetime] = createSignal(
    props.value?.runAt ? toLocalInput(props.value.runAt) : "",
  )
  const [dateError, setDateError] = createSignal<string | null>(null)
  // OPTIONAL on purpose: the recurring and one-shot modes need no client at
  // all, and this picker is rendered without a provider wherever only those two
  // are exercised. No client simply means no catalog, never a thrown render.
  const api = useOptionalApi()
  const [eventQuery, setEventQuery] = createSignal("")
  const [selectedEvent, setSelectedEvent] = createSignal(props.value?.event ?? "")

  // The catalog is fetched when this picker can actually show it, and only
  // then: a recurring routine never pays for the event list. An EFFECT rather
  // than a mount hook, because the picker is mounted once and told which kind
  // to render: the person switching the create form to "when an event happens"
  // never remounts it, and a mount hook would leave the list empty forever.
  let eventsRequested = false
  createEffect(() => {
    if (props.kind !== "event" || eventsRequested) return
    if (!api) return
    eventsRequested = true
    void loadRoutineEvents(api)
  })

  /** The catalog narrowed by the search box, grouped by app, apps in order. */
  const eventGroups = createMemo<Array<{ app: string; events: RoutineEventRow[] }>>(() => {
    const q = eventQuery().trim().toLowerCase()
    const matches = routinesStore.events.filter(
      (e) =>
        q.length === 0 ||
        e.event.toLowerCase().includes(q) ||
        describeRoutineEvent(e.event).toLowerCase().includes(q),
    )
    const byApp = new Map<string, RoutineEventRow[]>()
    for (const e of matches) {
      const list = byApp.get(e.app) ?? []
      list.push(e)
      byApp.set(e.app, list)
    }
    return [...byApp.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([app, events]) => ({ app, events }))
  })

  function chooseEvent(event: string): void {
    setSelectedEvent(event)
    props.onChange({ kind: "event", event })
  }

  const timezone = props.value?.timezone || localTimezone()

  function emitRecurring(): void {
    const cron =
      preset() === "custom" ? customCron() : (cronFromPreset(preset(), time(), dayOfWeek()) ?? "")
    props.onChange({ kind: "recurring", cron, timezone })
  }

  function emitScheduled(local: string): void {
    if (!local) {
      setDateError(null)
      return
    }
    const dt = new Date(local)
    if (Number.isNaN(dt.getTime())) {
      setDateError(i18n.t("kernel.agentForms.dateInvalid"))
      return
    }
    if (dt.getTime() <= Date.now()) {
      setDateError(i18n.t("kernel.agentForms.dateInPast"))
      return
    }
    setDateError(null)
    props.onChange({ kind: "scheduled", runAt: dt.toISOString() })
  }

  // Live cron preview for recurring mode.
  const previewFires = createMemo(() => {
    if (props.kind !== "recurring") return []
    const cron =
      preset() === "custom" ? customCron() : (cronFromPreset(preset(), time(), dayOfWeek()) ?? "")
    return cronPreview(cron, timezone, 2)
  })

  return (
    <div data-testid="schedule-picker" class="flex flex-col gap-3">
      <Show when={props.kind === "event"}>
        <div data-testid="event-picker" class="flex flex-col gap-2">
          <input
            type="text"
            data-testid="event-search"
            placeholder={i18n.t("kernel.agentForms.eventSearchPlaceholder")}
            class="w-full rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
            value={eventQuery()}
            onInput={(e) => setEventQuery(e.currentTarget.value)}
          />
          <Show
            when={eventGroups().length > 0}
            fallback={
              <p data-testid="event-picker-empty" class="text-[12px] text-text-tertiary">
                {i18n.t("kernel.agentForms.eventNoneFound")}
              </p>
            }
          >
            <div class="max-h-[260px] overflow-auto rounded-md border border-border-subtle">
              <For each={eventGroups()}>
                {(group) => (
                  <div>
                    <p class="bg-surface px-2.5 py-1 text-[11px] uppercase tracking-wide text-text-tertiary">
                      {group.app}
                    </p>
                    <For each={group.events}>
                      {(row) => (
                        <button
                          type="button"
                          data-testid={`event-option-${row.event}`}
                          data-selected={selectedEvent() === row.event ? "true" : "false"}
                          onClick={() => chooseEvent(row.event)}
                          class={`flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition-colors ${
                            selectedEvent() === row.event
                              ? "bg-accent/10 text-text"
                              : "text-text hover:bg-surface-hover"
                          }`}
                        >
                          <span class="text-[13px]">{describeRoutineEvent(row.event)}</span>
                          <span class="font-mono text-[11px] text-text-tertiary">{row.event}</span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <p class="text-[11px] text-text-tertiary">{i18n.t("kernel.agentForms.eventHint")}</p>
        </div>
      </Show>

      <Show
        when={props.kind === "recurring"}
        fallback={
          <Show when={props.kind === "scheduled"}>
            <div class="flex flex-col gap-1.5">
              <label class="text-[12px] text-text-tertiary" for="schedule-datetime">
                {i18n.t("kernel.agentForms.runOnceAt")}
              </label>
              <input
                id="schedule-datetime"
                data-testid="schedule-datetime"
                type="datetime-local"
                class="w-full rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
                value={datetime()}
                onInput={(e) => {
                  setDatetime(e.currentTarget.value)
                  emitScheduled(e.currentTarget.value)
                }}
              />
              <Show when={dateError()}>
                <p class="text-[12px] text-amber-500">{dateError()}</p>
              </Show>
              <p class="text-[11px] text-text-tertiary">
                {i18n.t("kernel.agentForms.oneShotHint")}
              </p>
            </div>
          </Show>
        }
      >
        <div class="flex flex-col gap-2.5">
          {/* Preset chips */}
          <div class="flex flex-wrap gap-1.5">
            <For each={PRESETS}>
              {(p) => (
                <button
                  type="button"
                  data-testid={`schedule-preset-${p.id}`}
                  data-selected={preset() === p.id ? "true" : "false"}
                  onClick={() => {
                    setPreset(p.id)
                    emitRecurring()
                  }}
                  class={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                    preset() === p.id
                      ? "border-accent bg-accent/10 text-text"
                      : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                  }`}
                >
                  {i18n.t(p.labelKey)}
                </button>
              )}
            </For>
          </div>

          {/* Time + day-of-week / custom cron */}
          <Show
            when={preset() !== "custom"}
            fallback={
              <div class="flex flex-col gap-1.5">
                <label class="text-[12px] text-text-tertiary" for="schedule-cron-input">
                  {i18n.t("kernel.agentForms.cronExpression")}
                </label>
                <input
                  id="schedule-cron-input"
                  data-testid="schedule-cron-input"
                  type="text"
                  placeholder="*/15 * * * *"
                  class="w-full rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"
                  value={customCron()}
                  onInput={(e) => {
                    setCustomCron(e.currentTarget.value)
                    emitRecurring()
                  }}
                />
              </div>
            }
          >
            <div class="flex items-end gap-3">
              <div class="flex flex-col gap-1.5">
                <label class="text-[12px] text-text-tertiary" for="schedule-time">
                  {i18n.t("kernel.agentUi.at")}
                </label>
                <input
                  id="schedule-time"
                  data-testid="schedule-time"
                  type="time"
                  class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
                  value={time()}
                  onInput={(e) => {
                    setTime(e.currentTarget.value)
                    emitRecurring()
                  }}
                />
              </div>
              <Show when={preset() === "weekly"}>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px] text-text-tertiary">{i18n.t("kernel.agentUi.on")}</span>
                  <div class="flex gap-1">
                    <For each={DOW}>
                      {(d) => (
                        <button
                          type="button"
                          data-testid={`schedule-dow-${d.value}`}
                          data-selected={dayOfWeek() === d.value ? "true" : "false"}
                          onClick={() => {
                            setDayOfWeek(d.value)
                            emitRecurring()
                          }}
                          class={`rounded border px-1.5 py-1 text-[11px] transition-colors ${
                            dayOfWeek() === d.value
                              ? "border-accent bg-accent/10 text-text"
                              : "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                          }`}
                        >
                          {i18n.t(d.labelKey)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={previewFires().length > 0}>
            <p class="text-[11px] text-text-tertiary">
              {i18n.t("kernel.agentUi.next")}{" "}
              {previewFires()
                .map((d) => formatPreview(d))
                .join(" · ")}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function formatPreview(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** ISO string → `YYYY-MM-DDTHH:MM` for a `datetime-local` input (local time). */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

export default SchedulePicker
