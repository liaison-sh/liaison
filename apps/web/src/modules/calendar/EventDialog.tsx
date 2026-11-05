// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createEffect, createSignal, For, on, Show, untrack } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import type { CalendarAttendee, CalendarEventDto, CalendarListItem } from "./calendar-api"
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "./calendar-store"

export interface EventDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  calendars: CalendarListItem[]
  event?: CalendarEventDto | null
  defaultCalendarId?: string
  defaultStart?: Date
  onSaved: () => void
}

const RECURRENCE_OPTIONS = ["none", "daily", "weekly", "monthly"] as const

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const ATTENDEE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function recurrenceToRrule(choice: (typeof RECURRENCE_OPTIONS)[number]): string[] | undefined {
  if (choice === "none") return undefined
  const freq = choice.toUpperCase()
  return [`RRULE:FREQ=${freq}`]
}

export const EventDialog: Component<EventDialogProps> = (props) => {
  const phone = () => shellTier() === "phone"
  const api = useApi()
  const i18n = useI18n()

  function computeStartDefault(): Date {
    return props.event?.start?.dateTime
      ? new Date(props.event.start.dateTime)
      : (props.defaultStart ?? new Date())
  }
  function computeEndDefault(startDefault: Date): Date {
    return props.event?.end?.dateTime
      ? new Date(props.event.end.dateTime)
      : new Date(startDefault.getTime() + 30 * 60_000)
  }

  const [title, setTitle] = createSignal(props.event?.title ?? "")
  const [description, setDescription] = createSignal(props.event?.description ?? "")
  const [location, setLocation] = createSignal(props.event?.location ?? "")
  const [allDay, setAllDay] = createSignal(props.event?.allDay ?? false)
  const [start, setStart] = createSignal(toLocalInputValue(computeStartDefault()))
  const [end, setEnd] = createSignal(toLocalInputValue(computeEndDefault(computeStartDefault())))
  const [calendarId, setCalendarId] = createSignal(
    props.event?.calendarId ?? props.defaultCalendarId ?? props.calendars[0]?.id ?? "",
  )
  const [recurrence, setRecurrence] = createSignal<(typeof RECURRENCE_OPTIONS)[number]>("none")
  const [attendeeInput, setAttendeeInput] = createSignal("")
  const [attendees, setAttendees] = createSignal<CalendarAttendee[]>(props.event?.attendees ?? [])
  // Only an attendee list the user actually changed is saved: an untouched list is never sent,
  // so a Save can never uninvite anyone by accident.
  const [attendeesChanged, setAttendeesChanged] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)

  // `EventDialog` is a single persistent instance (CalendarMonthTab/WeekTab don't remount it
  // per open) — the signals above are only correct for whichever `props.event` was live at
  // FIRST render (typically null, since the dialog mounts closed before any event is
  // selected). Re-derive the form fields every time the dialog transitions to open so editing
  // a real event doesn't silently save blank/stale fields over it.
  //
  // Only the open transition (or a different event) resets the form. Everything else the
  // reset reads is untracked: the calendar list arriving or reloading while the dialog is
  // open must not wipe what the user has typed (it used to: a New event clicked before the
  // list loaded lost its title, and saved with calendarId "").
  createEffect(
    on(
      () => [props.open, props.event?.eventId] as const,
      ([open]) => {
        if (!open) return
        untrack(resetForm)
      },
    ),
  )

  // A dialog opened before the calendar list loaded has no calendar yet: take the default
  // one as soon as the list arrives, without touching the other fields.
  createEffect(() => {
    const ids = props.calendars.map((c) => c.id)
    const current = untrack(calendarId)
    if (ids.length > 0 && !ids.includes(current)) {
      setCalendarId(props.event?.calendarId ?? props.defaultCalendarId ?? ids[0]!)
    }
  })

  function resetForm(): void {
    const startDefault = computeStartDefault()
    const endDefault = computeEndDefault(startDefault)
    setTitle(props.event?.title ?? "")
    setDescription(props.event?.description ?? "")
    setLocation(props.event?.location ?? "")
    setAllDay(props.event?.allDay ?? false)
    setStart(toLocalInputValue(startDefault))
    setEnd(toLocalInputValue(endDefault))
    setCalendarId(
      props.event?.calendarId ?? props.defaultCalendarId ?? props.calendars[0]?.id ?? "",
    )
    setRecurrence("none")
    setAttendeeInput("")
    setAttendees(props.event?.attendees ?? [])
    setAttendeesChanged(false)
    setError(null)
  }

  /** Adds what is typed in the attendee field; false when it holds a malformed address. */
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

  // A guest list Google would not accept from this account (not the organizer, guests may not
  // modify) is shown read-only; a new event is always ours.
  const attendeesEditable = () => props.event?.attendeesEditable !== false

  function removeAttendee(email: string): void {
    setAttendees(attendees().filter((a) => a.email !== email))
    setAttendeesChanged(true)
  }

  function attendeeStatusLabel(status: string | undefined): string {
    return i18n.t(
      `calendar.attendeeStatus.${status && ATTENDEE_STATUSES.has(status) ? status : "needsAction"}`,
    )
  }

  const writableCalendars = () => props.calendars

  // Editing a recurring MASTER (or a synthesized single occurrence, which resolves to the master
  // row) would silently rewrite the whole series' template. The blueprint scoped OUT arbitrary
  // recurrence editing and never authorized clobbering the master when editing one occurrence, so
  // we make recurring masters view-only: Save/Delete are disabled and a note explains why. (A
  // stored exception row is a plain non-recurring row — `recurrence` empty — so it stays editable.)
  const isRecurringMaster = () => {
    const rec = props.event?.recurrence
    return Array.isArray(rec) && rec.length > 0
  }

  function validate(): string | null {
    if (!title().trim()) return i18n.t("calendar.titleRequired")
    if (new Date(end()) < new Date(start())) return i18n.t("calendar.endBeforeStart")
    return null
  }

  async function handleSave(): Promise<void> {
    if (isRecurringMaster()) {
      setError(i18n.t("calendar.recurringNotEditable"))
      return
    }
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    // An address typed but not added yet is part of what the user means to save.
    if (attendeesEditable() && !addAttendees()) return
    setSaving(true)
    setError(null)
    try {
      if (props.event) {
        await updateCalendarEvent(api, {
          eventId: props.event.eventId,
          title: title(),
          description: description(),
          location: location(),
          start: new Date(start()).toISOString(),
          end: new Date(end()).toISOString(),
          allDay: allDay(),
          ...(attendeesChanged() ? { attendees: attendees().map((a) => a.email) } : {}),
          // An edited occurrence of a recurring meeting (its own row) changes that one only.
          ...(props.event.recurringEventId ? { scope: "occurrence" as const } : {}),
        })
      } else {
        await createCalendarEvent(api, {
          calendarId: calendarId(),
          title: title(),
          description: description(),
          location: location(),
          start: new Date(start()).toISOString(),
          end: new Date(end()).toISOString(),
          allDay: allDay(),
          recurrence: recurrenceToRrule(recurrence()),
          ...(attendees().length > 0 ? { attendees: attendees().map((a) => a.email) } : {}),
        })
      }
      props.onSaved()
      props.onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!props.event) return
    setSaving(true)
    try {
      // An occurrence of a recurring meeting (its own row) is cancelled alone.
      await deleteCalendarEvent(
        api,
        props.event.eventId,
        props.event.recurringEventId ? "occurrence" : undefined,
      )
      props.onSaved()
      props.onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* A form with a date, a time and a recurrence rule does not fit in a
          centred card at 390px: at phone width the create and edit flow takes
          the whole screen, the way every other phone form here does. */}
      <Dialog.Content
        positionerClass={phone() ? "p-0" : undefined}
        class={
          phone() ? "h-full w-full max-w-full overflow-y-auto rounded-none border-0" : undefined
        }
      >
        <Dialog.Title>
          {props.event ? i18n.t("calendar.editEvent") : i18n.t("calendar.newEvent")}
        </Dialog.Title>
        <div class="flex flex-col gap-3">
          <Show when={props.event?.hangoutLink}>
            <a
              href={props.event?.hangoutLink ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              class="flex items-center gap-2 self-start rounded-full bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] py-1.5 pl-2.5 pr-4 text-xs font-medium text-accent transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]"
              data-testid="event-meet-link"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
              </svg>
              {i18n.t("calendar.joinMeet")}
            </a>
          </Show>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium">{i18n.t("calendar.title")}</span>
            <Input
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              data-testid="event-title-input"
            />
          </label>

          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allDay()}
              onChange={(e) => setAllDay(e.currentTarget.checked)}
              data-testid="event-allday-toggle"
            />
            <span class="text-xs">{i18n.t("calendar.allDay")}</span>
          </label>

          <div class="flex gap-2">
            <label class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="text-xs font-medium">{i18n.t("calendar.start")}</span>
              <input
                type={allDay() ? "date" : "datetime-local"}
                class="w-full min-w-0 rounded-sm border border-border bg-bg px-2 py-1 text-xs"
                value={start()}
                onInput={(e) => setStart(e.currentTarget.value)}
                data-testid="event-start-input"
              />
            </label>
            <label class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="text-xs font-medium">{i18n.t("calendar.end")}</span>
              <input
                type={allDay() ? "date" : "datetime-local"}
                class="w-full min-w-0 rounded-sm border border-border bg-bg px-2 py-1 text-xs"
                value={end()}
                onInput={(e) => setEnd(e.currentTarget.value)}
                data-testid="event-end-input"
              />
            </label>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium">{i18n.t("calendar.description")}</span>
            <textarea
              class="rounded-sm border border-border bg-bg px-2 py-1 text-xs"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium">{i18n.t("calendar.location")}</span>
            <Input value={location()} onInput={(e) => setLocation(e.currentTarget.value)} />
          </label>

          <Show when={!props.event}>
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium">{i18n.t("calendar.calendarPicker")}</span>
              <select
                class="rounded-sm border border-border bg-bg px-2 py-1 text-xs"
                value={calendarId()}
                onChange={(e) => setCalendarId(e.currentTarget.value)}
              >
                <For each={writableCalendars()}>
                  {(cal) => <option value={cal.id}>{cal.name}</option>}
                </For>
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium">{i18n.t("calendar.recurrence")}</span>
              <select
                class="rounded-sm border border-border bg-bg px-2 py-1 text-xs"
                value={recurrence()}
                onChange={(e) =>
                  setRecurrence(e.currentTarget.value as (typeof RECURRENCE_OPTIONS)[number])
                }
                data-testid="event-recurrence-select"
              >
                <For each={RECURRENCE_OPTIONS}>
                  {(opt) => <option value={opt}>{i18n.t(`calendar.recurrence.${opt}`)}</option>}
                </For>
              </select>
            </label>
          </Show>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium">{i18n.t("calendar.attendees")}</span>
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
                      <Show when={attendeesEditable()}>
                        <button
                          type="button"
                          class="shrink-0 text-xs text-text-secondary hover:text-text"
                          aria-label={i18n.t("calendar.removeAttendee", { email: a.email })}
                          data-testid="event-attendee-remove"
                          onClick={() => removeAttendee(a.email)}
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
                  class="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-xs"
                  type="email"
                  value={attendeeInput()}
                  onInput={(e) => setAttendeeInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void addAttendees()
                    }
                  }}
                  placeholder={i18n.t("calendar.attendeesPlaceholder")}
                  aria-label={i18n.t("calendar.attendees")}
                  data-testid="event-attendee-input"
                />
                <Button
                  variant="outline"
                  onClick={() => void addAttendees()}
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

          <Show when={props.event?.pushError ?? props.event?.pushNotice}>
            {(message) => (
              <div class="text-xs text-error" data-testid="event-push-error">
                {i18n.t("calendar.pushRejected", { message: message() })}
              </div>
            )}
          </Show>

          <Show when={isRecurringMaster()}>
            <div class="text-xs text-text-secondary" data-testid="event-recurring-note">
              {i18n.t("calendar.recurringNotEditable")}
            </div>
          </Show>

          <Show when={error()}>{(msg) => <div class="text-xs text-error">{msg()}</div>}</Show>

          <div class="flex justify-between gap-2">
            <Show when={props.event}>
              <Button
                variant="danger"
                onClick={handleDelete}
                disabled={saving() || isRecurringMaster()}
              >
                {i18n.t("calendar.deleteEvent")}
              </Button>
            </Show>
            <div class="flex flex-1 justify-end gap-2">
              <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                {i18n.t("calendar.cancel")}
              </Button>
              <Button onClick={handleSave} disabled={saving() || isRecurringMaster()}>
                {i18n.t("calendar.save")}
              </Button>
            </div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
