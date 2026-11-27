// SPDX-License-Identifier: FSL-1.1-ALv2
// The event tab: the full editor for one event (opened from the grid, the agenda or "More
// options" in the quick-create popover), or for a new one (`new-<n>` tab id). Its actions sit at
// the top of the view. Saving or deleting closes the tab and leaves the calendar where it was; a
// delete asks first and offers Undo.
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import type { CalendarAttendee, CalendarEventDto } from "./calendar-api"
import {
  calendarStore,
  createCalendarEvent,
  deleteCalendarEvent,
  loadCalendarsList,
  reloadCurrentWindow,
  updateCalendarEvent,
} from "./calendar-store"
import {
  createPayload,
  type EventFormValues,
  formFromEvent,
  isWritableCalendar,
  timesPayload,
  validateForm,
  withAllDay,
} from "./event-form"
import { closeEventTab, openedEvent, takeDraft } from "./event-tabs"

const RECURRENCE_OPTIONS = ["none", "daily", "weekly", "monthly"] as const
type RecurrenceChoice = (typeof RECURRENCE_OPTIONS)[number]
const ATTENDEE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** How long Undo stays offered after a delete. */
const UNDO_MS = 8000

function recurrenceToRrule(choice: RecurrenceChoice): string[] | undefined {
  return choice === "none" ? undefined : [`RRULE:FREQ=${choice.toUpperCase()}`]
}

const fieldClass = "w-full min-w-0 rounded-sm border border-border bg-bg px-2 py-1.5 text-sm"

export const CalendarEventTab: Component<{ entityId?: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const entityId = () => props.entityId ?? ""
  const isNew = () => entityId().startsWith("new-")

  const event = createMemo<CalendarEventDto | null>(() => {
    if (isNew()) return null
    return (
      calendarStore.events.find((e) => e.eventId === entityId()) ?? openedEvent(entityId()) ?? null
    )
  })

  const [form, setForm] = createSignal<EventFormValues>(
    formFromEvent(event(), takeDraft(entityId()) ?? {}, calendarStore.calendars),
  )
  const [recurrence, setRecurrence] = createSignal<RecurrenceChoice>("none")
  const [attendees, setAttendees] = createSignal<CalendarAttendee[]>(event()?.attendees ?? [])
  const [attendeesChanged, setAttendeesChanged] = createSignal(false)
  const [attendeeInput, setAttendeeInput] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  onMount(() => {
    if (calendarStore.calendars.length === 0) {
      void loadCalendarsList(api).then(() => {
        if (!form().calendarId) {
          setForm(formFromEvent(event(), takeDraft(entityId()) ?? {}, calendarStore.calendars))
        }
      })
    }
  })

  const update = (patch: Partial<EventFormValues>) => setForm({ ...form(), ...patch })

  const writableCalendars = createMemo(() =>
    calendarStore.calendars.filter((c) => c.selected !== false && isWritableCalendar(c)),
  )
  // A recurring master is read-only here until series editing lands (one occurrence's own row,
  // an exception, stays editable).
  const isRecurringMaster = () => {
    const rec = event()?.recurrence
    return Array.isArray(rec) && rec.length > 0
  }
  const attendeesEditable = () => event()?.attendeesEditable !== false
  const readOnly = () => isRecurringMaster()

  function attendeeStatusLabel(status: string | undefined): string {
    return i18n.t(
      `calendar.attendeeStatus.${status && ATTENDEE_STATUSES.has(status) ? status : "needsAction"}`,
    )
  }

  function addAttendees(): boolean {
    const parts = attendeeInput()
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 0) return true
    const invalid = parts.find((p) => !EMAIL_RE.test(p))
    if (invalid) {
      setError(i18n.t("calendar.attendeeInvalid", { email: invalid }))
      return false
    }
    const known = new Set(attendees().map((a) => a.email.toLowerCase()))
    const added = parts.filter((p) => {
      const key = p.toLowerCase()
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    if (added.length > 0) {
      setAttendees([...attendees(), ...added.map((email) => ({ email }))])
      setAttendeesChanged(true)
    }
    setAttendeeInput("")
    setError(null)
    return true
  }

  function close(): void {
    closeEventTab(entityId())
  }

  async function save(): Promise<void> {
    if (readOnly()) return
    const invalid = validateForm(form())
    if (invalid) {
      setError(i18n.t(invalid))
      return
    }
    if (attendeesEditable() && !addAttendees()) return
    setSaving(true)
    setError(null)
    try {
      const current = event()
      if (current) {
        const hadMeet = Boolean(current.hangoutLink)
        await updateCalendarEvent(api, {
          eventId: current.eventId,
          title: form().title.trim(),
          description: form().description,
          location: form().location,
          ...timesPayload(form()),
          ...(attendeesChanged() ? { attendees: attendees().map((a) => a.email) } : {}),
          ...(form().meet !== hadMeet
            ? { conference: form().meet ? ("google_meet" as const) : ("none" as const) }
            : {}),
          ...(current.recurringEventId ? { scope: "occurrence" as const } : {}),
        })
      } else {
        await createCalendarEvent(
          api,
          createPayload(form(), {
            recurrence: recurrenceToRrule(recurrence()),
            attendees: attendees().map((a) => a.email),
          }),
        )
      }
      void reloadCurrentWindow(api)
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    const current = event()
    if (!current) return
    setConfirmDelete(false)
    setSaving(true)
    setError(null)
    try {
      await deleteCalendarEvent(
        api,
        current.eventId,
        current.recurringEventId ? "occurrence" : undefined,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
      return
    }
    setSaving(false)
    void reloadCurrentWindow(api)
    close()
    // Undo puts a deleted one-off event back (a cancelled occurrence comes back with the series).
    if (!current.recurringEventId) {
      const snapshot = formFromEvent(current, {}, calendarStore.calendars)
      const guests = (current.attendees ?? []).map((a) => a.email)
      addToast({
        message: i18n.t("calendar.eventDeleted"),
        type: "info",
        durationMs: UNDO_MS,
        action: {
          label: i18n.t("calendar.undo"),
          onClick: () => {
            void createCalendarEvent(api, createPayload(snapshot, { attendees: guests })).then(
              () => reloadCurrentWindow(api),
              (err: unknown) =>
                addToast({
                  message: err instanceof Error ? err.message : String(err),
                  type: "error",
                }),
            )
          },
        },
      })
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="calendar-event-tab">
      {/* Actions at the top of the view. */}
      <div class="flex items-center gap-2 border-b border-border px-4 py-2">
        <h2 class="min-w-0 flex-1 truncate text-base font-semibold text-text">
          {isNew() ? i18n.t("calendar.newEvent") : i18n.t("calendar.editEvent")}
        </h2>
        <Show when={event()}>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving() || readOnly()}
            onClick={() => setConfirmDelete(true)}
            data-testid="event-delete"
          >
            {i18n.t("calendar.deleteEvent")}
          </Button>
        </Show>
        <Button variant="outline" size="sm" onClick={close} data-testid="event-cancel">
          {i18n.t("calendar.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={saving() || readOnly()}
          onClick={() => void save()}
          data-testid="event-save"
        >
          {i18n.t("calendar.save")}
        </Button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pb-dock-runway">
        <form
          class="mx-auto flex max-w-xl flex-col gap-4 px-4 py-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Show when={!isNew() && !event()}>
            <p class="text-sm text-text-secondary" data-testid="event-not-found">
              {i18n.t("calendar.eventNotFound")}
            </p>
          </Show>

          <Show when={event()?.hangoutLink}>
            <a
              href={event()?.hangoutLink ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              class="self-start rounded-full bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-4 py-1.5 text-xs font-medium text-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]"
              data-testid="event-meet-link"
            >
              {i18n.t("calendar.joinMeet")}
            </a>
          </Show>

          <Input
            value={form().title}
            onInput={(e) => update({ title: e.currentTarget.value })}
            placeholder={i18n.t("calendar.addTitle")}
            aria-label={i18n.t("calendar.title")}
            class="text-lg font-medium"
            data-testid="event-title-input"
            autofocus={isNew()}
          />

          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form().allDay}
                onChange={(e) => setForm(withAllDay(form(), e.currentTarget.checked))}
                data-testid="event-allday-toggle"
              />
              {i18n.t("calendar.allDay")}
            </label>
            {/* Side by side when there is room; stacked on a phone, where a date and a time
                did not fit in half a 390 px row. */}
            <div class="flex flex-wrap gap-2">
              <label class="flex min-w-[12rem] flex-1 flex-col gap-1">
                <span class="text-xs font-medium text-text-secondary">
                  {i18n.t("calendar.start")}
                </span>
                <Show
                  when={form().allDay}
                  fallback={
                    <input
                      type="datetime-local"
                      class={fieldClass}
                      value={form().startLocal}
                      onInput={(e) => update({ startLocal: e.currentTarget.value })}
                      data-testid="event-start-input"
                    />
                  }
                >
                  <input
                    type="date"
                    class={fieldClass}
                    value={form().startDate}
                    onInput={(e) => update({ startDate: e.currentTarget.value })}
                    data-testid="event-start-input"
                  />
                </Show>
              </label>
              <label class="flex min-w-[12rem] flex-1 flex-col gap-1">
                <span class="text-xs font-medium text-text-secondary">
                  {i18n.t("calendar.end")}
                </span>
                <Show
                  when={form().allDay}
                  fallback={
                    <input
                      type="datetime-local"
                      class={fieldClass}
                      value={form().endLocal}
                      onInput={(e) => update({ endLocal: e.currentTarget.value })}
                      data-testid="event-end-input"
                    />
                  }
                >
                  <input
                    type="date"
                    class={fieldClass}
                    value={form().endDate}
                    onInput={(e) => update({ endDate: e.currentTarget.value })}
                    data-testid="event-end-input"
                  />
                </Show>
              </label>
            </div>
          </div>

          <div class="flex gap-2">
            <label class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="text-xs font-medium text-text-secondary">
                {i18n.t("calendar.calendarPicker")}
              </span>
              <select
                class={fieldClass}
                value={form().calendarId}
                disabled={!isNew()}
                onChange={(e) => update({ calendarId: e.currentTarget.value })}
                data-testid="event-calendar-select"
              >
                <For each={writableCalendars()}>
                  {(cal) => <option value={cal.id}>{cal.name}</option>}
                </For>
              </select>
            </label>
            <Show when={isNew()}>
              <label class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-xs font-medium text-text-secondary">
                  {i18n.t("calendar.recurrence")}
                </span>
                <select
                  class={fieldClass}
                  value={recurrence()}
                  onChange={(e) => setRecurrence(e.currentTarget.value as RecurrenceChoice)}
                  data-testid="event-recurrence-select"
                >
                  <For each={RECURRENCE_OPTIONS}>
                    {(opt) => <option value={opt}>{i18n.t(`calendar.recurrence.${opt}`)}</option>}
                  </For>
                </select>
              </label>
            </Show>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form().meet}
              onChange={(e) => update({ meet: e.currentTarget.checked })}
              data-testid="event-meet-toggle"
            />
            {i18n.t("calendar.addMeet")}
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-text-secondary">
              {i18n.t("calendar.location")}
            </span>
            <Input
              value={form().location}
              onInput={(e) => update({ location: e.currentTarget.value })}
              data-testid="event-location-input"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-text-secondary">
              {i18n.t("calendar.description")}
            </span>
            <textarea
              class={`${fieldClass} min-h-24`}
              value={form().description}
              onInput={(e) => update({ description: e.currentTarget.value })}
              data-testid="event-description-input"
            />
          </label>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-text-secondary">
              {i18n.t("calendar.attendees")}
            </span>
            <Show when={attendees().length > 0}>
              <ul class="flex flex-col gap-1">
                <For each={attendees()}>
                  {(a) => (
                    <li
                      class="flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1"
                      data-testid="event-attendee"
                    >
                      <div class="min-w-0">
                        <div class="truncate text-xs font-medium">{a.displayName ?? a.email}</div>
                        <div class="truncate text-xs text-text-secondary">
                          <Show when={a.displayName}>{a.email} · </Show>
                          {attendeeStatusLabel(a.responseStatus)}
                          <Show when={a.organizer}> · {i18n.t("calendar.organizer")}</Show>
                        </div>
                      </div>
                      <Show when={attendeesEditable() && !readOnly()}>
                        <button
                          type="button"
                          class="shrink-0 text-xs text-text-secondary hover:text-text"
                          aria-label={i18n.t("calendar.removeAttendee", { email: a.email })}
                          data-testid="event-attendee-remove"
                          onClick={() => {
                            setAttendees(attendees().filter((x) => x.email !== a.email))
                            setAttendeesChanged(true)
                          }}
                        >
                          ✕
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show
              when={attendeesEditable()}
              fallback={
                <span class="text-xs text-text-secondary" data-testid="event-attendees-readonly">
                  {i18n.t("calendar.attendeesReadOnly")}
                </span>
              }
            >
              <div class="flex gap-2">
                <input
                  class={`${fieldClass} flex-1`}
                  type="email"
                  value={attendeeInput()}
                  onInput={(e) => setAttendeeInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addAttendees()
                    }
                  }}
                  placeholder={i18n.t("calendar.attendeesPlaceholder")}
                  aria-label={i18n.t("calendar.attendees")}
                  data-testid="event-attendee-input"
                />
                <Button
                  variant="outline"
                  onClick={() => addAttendees()}
                  data-testid="event-attendee-add"
                >
                  {i18n.t("calendar.addAttendee")}
                </Button>
              </div>
            </Show>
            <span class="text-xs text-text-secondary" data-testid="event-attendees-no-invite">
              {i18n.t("calendar.attendeesNotNotified")}
            </span>
          </div>

          <Show when={event()?.pushError ?? event()?.pushNotice}>
            {(message) => (
              <div class="text-xs text-text-secondary" data-testid="event-push-error">
                {i18n.t("calendar.pushRejected", { message: message() })}
              </div>
            )}
          </Show>
          <Show when={isRecurringMaster()}>
            <div class="text-xs text-text-secondary" data-testid="event-recurring-note">
              {i18n.t("calendar.recurringNotEditable")}
            </div>
          </Show>
          <Show when={error()}>
            {(msg) => (
              <div class="text-xs text-error" data-testid="event-error">
                {msg()}
              </div>
            )}
          </Show>
        </form>
      </div>

      <Dialog open={confirmDelete()} onOpenChange={setConfirmDelete}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("calendar.deleteConfirmTitle")}</Dialog.Title>
          <p class="text-sm text-text-secondary">
            {i18n.t("calendar.deleteConfirmBody", {
              title: event()?.title || i18n.t("calendar.untitledEvent"),
            })}
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              data-testid="event-delete-cancel"
            >
              {i18n.t("calendar.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => void remove()}
              data-testid="event-delete-confirm"
            >
              {i18n.t("calendar.deleteEvent")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default CalendarEventTab
