// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Work hours, work days and time zone on Settings -> Notifications. Saved
// together with one PATCH that carries nothing else, so the grid is never
// rewritten by a change of hours (S8).
//
// The screen shows days Monday first with ISO numbers (1 = Monday .. 7 =
// Sunday); the API counts 0 = Sunday .. 6 = Saturday.

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { getTimezones } from "~/lib/timezones"
import { useI18n } from "~/modules/i18n/i18n-context"
import type {
  NotificationSettingsData,
  NotificationSettingsPatch,
  WorkHours,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7]

function toIso(day: number): number {
  return day === 0 ? 7 : day
}
function fromIso(iso: number): number {
  return iso % 7
}

/** ISO weekday (1 = Monday) in the reader's words. 2026-06-08 is a Monday. */
function weekday(iso: number, locale: string, style: "long" | "narrow"): string {
  return new Date(2026, 5, 7 + iso).toLocaleDateString(locale, { weekday: style })
}

interface Form {
  start: string
  end: string
  days: number[]
  timezone: string
}

function formOf(hours: WorkHours): Form {
  return {
    start: hours.start,
    end: hours.end,
    days: hours.days.map(toIso).sort((a, b) => a - b),
    timezone: hours.timezone,
  }
}

function sameForm(a: Form, b: Form): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.timezone === b.timezone &&
    a.days.length === b.days.length &&
    a.days.every((d, i) => d === b.days[i])
  )
}

interface WorkHoursSectionProps {
  workHours: WorkHours
  onSave: (patch: NotificationSettingsPatch) => Promise<NotificationSettingsData | null>
}

export const WorkHoursSection: Component<WorkHoursSectionProps> = (props) => {
  const i18n = useI18n()
  // Read once: later answers to grid or cadence changes carry the same hours,
  // and must not wipe what the person is typing.
  const [saved, setSaved] = createSignal<WorkHours>(props.workHours)
  const [form, setForm] = createSignal<Form>(formOf(props.workHours))
  const [saving, setSaving] = createSignal(false)

  const dirty = createMemo(() => !sameForm(form(), formOf(saved())))
  const noDays = createMemo(() => form().days.length === 0)
  const timezones = createMemo(() => {
    const list = getTimezones()
    const current = form().timezone
    return current && !list.includes(current) ? [current, ...list] : list
  })

  function update(part: Partial<Form>): void {
    setForm({ ...form(), ...part })
  }

  function toggleDay(iso: number): void {
    const days = form().days
    update({
      days: days.includes(iso)
        ? days.filter((d) => d !== iso)
        : [...days, iso].sort((a, b) => a - b),
    })
  }

  async function save(): Promise<void> {
    if (saving() || !dirty() || noDays()) return
    setSaving(true)
    const f = form()
    const next = await props.onSave({
      workHours: {
        start: f.start,
        end: f.end,
        days: f.days.map(fromIso).sort((a, b) => a - b),
      },
      timezone: f.timezone,
    })
    if (next) {
      setSaved(next.workHours)
      setForm(formOf(next.workHours))
    }
    setSaving(false)
  }

  return (
    <section class="mb-10 border-t border-border-subtle pt-8">
      <h2 class={`mb-3 ${sectionHeading}`}>
        {i18n.t("kernel.notificationSettings.workHoursTitle")}
      </h2>
      <p class="mb-4 text-[13px] leading-relaxed text-text-secondary">
        {i18n.t("kernel.notificationSettings.workHoursHint")}
      </p>
      <Show when={!saved().explicit && saved().quiet !== false}>
        <p
          data-testid="notif-work-hours-default"
          class="mb-4 rounded-sm border border-border-subtle bg-surface px-3 py-2 text-[12px] leading-relaxed text-text-secondary"
        >
          {i18n.t("kernel.notificationSettings.workHoursDefault")}
        </p>
      </Show>
      <Show when={saved().timezoneSource === "org" || saved().timezoneSource === "unknown"}>
        <p
          data-testid="notif-timezone-source"
          class="mb-4 text-[12px] leading-relaxed text-text-secondary"
        >
          {i18n.t(
            saved().timezoneSource === "org"
              ? "kernel.notificationSettings.timezoneFromOrg"
              : "kernel.notificationSettings.timezoneUnknown",
          )}
        </p>
      </Show>

      <fieldset
        aria-label={i18n.t("kernel.workDays")}
        data-testid="attention-workdays"
        class="flex flex-wrap gap-1.5"
      >
        <For each={ISO_DAYS}>
          {(iso) => (
            <button
              type="button"
              data-testid={`attention-workday-${iso}`}
              aria-label={weekday(iso, i18n.locale(), "long")}
              aria-pressed={form().days.includes(iso)}
              onClick={() => toggleDay(iso)}
              class="flex h-11 w-11 items-center justify-center rounded-full border text-[12.5px] font-medium transition-colors duration-150 lg:h-9 lg:w-9"
              classList={{
                "border-accent-border bg-accent-glow text-text": form().days.includes(iso),
                "border-border bg-bg text-text-tertiary hover:border-border-strong hover:text-text-secondary":
                  !form().days.includes(iso),
              }}
            >
              {weekday(iso, i18n.locale(), "narrow")}
            </button>
          )}
        </For>
      </fieldset>
      <Show when={noDays()}>
        <p data-testid="attention-workdays-error" class="mt-2 text-[12px] text-warning">
          {i18n.t("kernel.settingsUi.pickAtLeastOneWorkDay")}
        </p>
      </Show>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <div class="inline-flex items-center gap-2 rounded-sm border border-border bg-bg px-3 py-2">
          <input
            type="time"
            data-testid="attention-work-hours-start"
            aria-label={i18n.t("kernel.workHoursStart")}
            value={form().start}
            onInput={(e) => update({ start: e.currentTarget.value })}
            class="border-none bg-transparent px-0 py-0 font-mono text-[13.5px] tabular-nums text-text outline-none"
          />
          <span class="text-text-tertiary" aria-hidden="true">
            →
          </span>
          <input
            type="time"
            data-testid="attention-work-hours-end"
            aria-label={i18n.t("kernel.workHoursEnd")}
            value={form().end}
            onInput={(e) => update({ end: e.currentTarget.value })}
            class="border-none bg-transparent px-0 py-0 font-mono text-[13.5px] tabular-nums text-text outline-none"
          />
        </div>
        <Show when={form().start === form().end}>
          <span class="text-[11.5px] text-text-tertiary">
            {i18n.t("kernel.settingsUi.all24HoursOnSelectedDays")}
          </span>
        </Show>
      </div>

      <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="min-w-0 flex-1">
          <h3 class={sectionHeading}>{i18n.t("kernel.settingsUi.timezone")}</h3>
          <p class="mt-2 text-[13px] leading-relaxed text-text-secondary">
            {i18n.t("kernel.notificationSettings.timezoneHint")}
          </p>
        </div>
        <select
          data-testid="attention-timezone"
          aria-label={i18n.t("kernel.settingsUi.timezone")}
          value={form().timezone}
          onChange={(e) => update({ timezone: e.currentTarget.value })}
          class="min-h-11 min-w-[180px] rounded-sm border border-border bg-bg px-3 py-2 font-mono text-[12.5px] text-text outline-none focus:border-accent-muted lg:min-h-0"
        >
          <For each={timezones()}>{(tz) => <option value={tz}>{tz}</option>}</For>
        </select>
      </div>

      <Show when={dirty()}>
        <div
          data-testid="settings-save-bar"
          // pb-dock-clearance: Save sits in the panel's bottom right corner,
          // under the dock's bar (index.css).
          class="sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t border-border bg-bg/95 pt-3 pb-dock-clearance backdrop-blur"
        >
          <span class="text-[12px] text-text-secondary">
            {noDays()
              ? i18n.t("kernel.settingsUi.pickAtLeastOneWorkDay")
              : i18n.t("kernel.notificationSettings.unsavedChanges")}
          </span>
          <button
            type="button"
            data-testid="attention-save"
            class="min-h-11 rounded-sm border border-accent-border bg-accent-glow px-4 py-1.5 text-[13px] font-medium text-accent hover:bg-accent-wash hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
            disabled={saving() || noDays()}
            onClick={() => void save()}
          >
            {saving() ? i18n.t("kernel.common.saving") : i18n.t("kernel.settingsUi.saveChanges")}
          </button>
        </div>
      </Show>
    </section>
  )
}
