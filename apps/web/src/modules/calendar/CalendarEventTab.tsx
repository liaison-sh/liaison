// SPDX-License-Identifier: FSL-1.1-ALv2
// The event tab: the full editor for one event (opened from the grid, the agenda or "More
// options" in the quick-create popover), or for a new one (`new-<n>` tab id). Its actions sit at
// the top of the view. Saving or deleting closes the tab and leaves the calendar where it was; a
// delete asks first and offers Undo. An event of a recurring meeting asks which occurrences a
// save or a delete applies to (this one, this and the following ones, all of them). Guests are
// emailed only when "Send invitations" is ticked; the account's own invitation is answered here.
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import { createAttendeeSearch } from "./attendee-search"
import {
  type CalendarAttendee,
  type CalendarEventDto,
  getEvent,
  type RsvpResponse,
  respondToEvent,
  type SeriesScope,
} from "./calendar-api"
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
import { closeEventTab, openedEvent, parseEventTabEntityId, takeDraft } from "./event-tabs"
import { FindATime } from "./FindATime"
import {
  buildRepeat,
  NO_REPEAT,
  parseRepeat,
  type RepeatFreq,
  type RepeatRule,
  WEEKDAY_CODES,
  withRule,
} from "./recurrence-rule"
import {
  isRecurringMaster as isMasterEvent,
  occurrenceView,
  scopeTarget,
  seriesContextOf,
  seriesTimes,
} from "./series-edit"
import { browserTimeZone, zoneShortName } from "./time-zones"

const REPEAT_FREQS: RepeatFreq[] = ["none", "daily", "weekly", "monthly", "yearly"]
const RSVP_CHOICES: RsvpResponse[] = ["accepted", "tentative", "declined"]
/** What the scope dialog is asking about. */
type PendingAction = "save" | "delete" | { rsvp: RsvpResponse }
const ATTENDEE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** How long Undo stays offered after a delete. */
const UNDO_MS = 8000

const fieldClass = "w-full min-w-0 rounded-sm border border-border bg-bg px-2 py-1.5 text-sm"

export const CalendarEventTab: Component<{ entityId?: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const entityId = () => props.entityId ?? ""
  const isNew = () => entityId().startsWith("new-")
  // `<series id>~<occurrence>` for one occurrence of a recurring meeting.
  const target = () => parseEventTabEntityId(entityId())

  // Read by id when the calendar window does not hold it (a tab reopened after a reload, an
  // event outside the week on screen): `undefined` while that read runs.
  const [fetched, setFetched] = createSignal<CalendarEventDto | null | undefined>(null)
  const event = createMemo<CalendarEventDto | null>(() => {
    if (isNew()) return null
    const id = target().eventId
    return (
      calendarStore.events.find((e) => e.eventId === id) ?? openedEvent(id) ?? fetched() ?? null
    )
  })
  const series = createMemo(() => seriesContextOf(event(), target().occurrence))
  /** The event as the form shows it: a series at the occurrence it was opened at. */
  const shown = (): CalendarEventDto | null => {
    const e = event()
    const ctx = series()
    return e && ctx?.kind === "master" ? occurrenceView(e, ctx.occurrence) : e
  }

  const [form, setForm] = createSignal<EventFormValues>(
    formFromEvent(shown(), takeDraft(entityId()) ?? {}, calendarStore.calendars),
  )
  const initialRepeat = parseRepeat(event()?.recurrence ?? null)
  const [repeat, setRepeat] = createSignal<RepeatRule>(initialRepeat ?? NO_REPEAT)
  const [repeatChanged, setRepeatChanged] = createSignal(false)
  const [attendees, setAttendees] = createSignal<CalendarAttendee[]>(event()?.attendees ?? [])
  const [attendeesChanged, setAttendeesChanged] = createSignal(false)
  const [attendeeInput, setAttendeeInput] = createSignal("")
  /** Null until the person touches it: then their choice; before, on when guests were added. */
  const [notifyChoice, setNotifyChoice] = createSignal<boolean | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [pending, setPending] = createSignal<PendingAction | null>(null)
  const suggest = createAttendeeSearch(
    api,
    () => new Set(attendees().map((a) => a.email.toLowerCase())),
  )

  onMount(() => {
    if (!isNew() && !event()) {
      setFetched(undefined)
      void getEvent(api, target().eventId)
        .then((found) => {
          setFetched(found)
          if (found) {
            setForm(formFromEvent(shown() ?? found, {}, calendarStore.calendars))
            setAttendees(found.attendees ?? [])
          }
        })
        .catch(() => setFetched(null))
    }
    if (calendarStore.calendars.length === 0) {
      void loadCalendarsList(api).then(() => {
        if (!form().calendarId) {
          setForm(formFromEvent(shown(), takeDraft(entityId()) ?? {}, calendarStore.calendars))
        }
      })
    }
  })

  const update = (patch: Partial<EventFormValues>) => setForm({ ...form(), ...patch })
  const editRepeat = (patch: Partial<RepeatRule>) => {
    setRepeat({ ...repeat(), ...patch })
    setRepeatChanged(true)
  }

  /** The event's own zone, when Google gives one that differs from the browser's. */
  const eventZone = () => {
    const zone = event()?.start?.timeZone
    return zone && zone !== browserTimeZone() ? zone : null
  }

  // Del (or Backspace) outside a field asks to delete the open event, like the Delete button.
  const tabActive = useTabIsActive()
  const onDeleteKey = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return
    if (!tabActive() || !event() || confirmDelete() || pending() !== null) return
    const target = e.target as HTMLElement | null
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return
    e.preventDefault()
    askDelete()
  }
  document.addEventListener("keydown", onDeleteKey)
  onCleanup(() => document.removeEventListener("keydown", onDeleteKey))

  const writableCalendars = createMemo(() =>
    calendarStore.calendars.filter((c) => c.selected !== false && isWritableCalendar(c)),
  )
  const isRecurringMaster = () => isMasterEvent(event())
  const attendeesEditable = () => event()?.attendeesEditable !== false
  /** A repeat rule this editor cannot show is kept as it is, never rewritten. */
  const repeatEditable = () => isNew() || (isRecurringMaster() && initialRepeat !== null)
  /** Guests get Google's email: ticked by the person, or by default when guests were added. */
  const notify = () => notifyChoice() ?? (attendeesChanged() && attendees().length > 0)
  const sendUpdates = () =>
    notify() && attendees().length > 0 ? { sendUpdates: "all" as const } : {}
  /** The account's own guest entry, when someone else invited it. */
  const ownInvite = createMemo(() => {
    const list = event()?.attendees ?? []
    const self = list.find((a) => a.self === true)
    return self && !self.organizer ? self : null
  })

  function attendeeStatusLabel(status: string | undefined): string {
    return i18n.t(
      `calendar.attendeeStatus.${status && ATTENDEE_STATUSES.has(status) ? status : "needsAction"}`,
    )
  }

  function addAttendee(email: string): void {
    if (attendees().some((a) => a.email.toLowerCase() === email.toLowerCase())) return
    setAttendees([...attendees(), { email }])
    setAttendeesChanged(true)
    setAttendeeInput("")
    suggest.clear()
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
    const invalid = validateForm(form())
    if (invalid) {
      setError(i18n.t(invalid))
      return
    }
    if (attendeesEditable() && !addAttendees()) return
    // A recurring meeting: which occurrences first.
    if (event() && series()) {
      setPending("save")
      return
    }
    await saveWith(null)
  }

  async function saveWith(scope: SeriesScope | null): Promise<void> {
    setPending(null)
    setSaving(true)
    setError(null)
    try {
      const current = event()
      const ctx = series()
      if (current) {
        const hadMeet = Boolean(current.hangoutLink)
        const times = timesPayload(form())
        const scoped = ctx && scope ? scopeTarget(current, ctx, scope) : null
        // The whole series moves by what the form moved its occurrence; an edited occurrence
        // keeps its own time out of a whole-series change.
        const timeFields =
          scope === "series"
            ? ctx?.kind === "master"
              ? seriesTimes(current, ctx.occurrence, times)
              : {}
            : times
        const rule =
          repeatChanged() && scope !== "occurrence" ? buildRepeat(repeat(), form().allDay) : null
        await updateCalendarEvent(api, {
          eventId: scoped?.eventId ?? current.eventId,
          title: form().title.trim(),
          description: form().description,
          location: form().location,
          ...timeFields,
          ...(attendeesChanged() ? { attendees: attendees().map((a) => a.email) } : {}),
          ...(form().meet !== hadMeet
            ? { conference: form().meet ? ("google_meet" as const) : ("none" as const) }
            : {}),
          ...(scoped ? { scope: scoped.scope } : {}),
          ...(scoped?.occurrenceStart ? { occurrenceStart: scoped.occurrenceStart } : {}),
          ...(rule !== null ? { recurrence: withRule(current.recurrence, rule) } : {}),
          ...sendUpdates(),
        })
      } else {
        await createCalendarEvent(api, {
          ...createPayload(form(), {
            recurrence: buildRepeat(repeat(), form().allDay),
            attendees: attendees().map((a) => a.email),
          }),
          ...sendUpdates(),
        })
      }
      void reloadCurrentWindow(api)
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function askDelete(): void {
    if (series()) setPending("delete")
    else setConfirmDelete(true)
  }

  async function remove(scope: SeriesScope | null = null): Promise<void> {
    const current = event()
    if (!current) return
    setConfirmDelete(false)
    setPending(null)
    setSaving(true)
    setError(null)
    const ctx = series()
    const scoped = ctx && scope ? scopeTarget(current, ctx, scope) : null
    try {
      await deleteCalendarEvent(api, scoped?.eventId ?? current.eventId, {
        ...(scoped ? { scope: scoped.scope } : {}),
        ...(scoped?.occurrenceStart ? { occurrenceStart: scoped.occurrenceStart } : {}),
        ...(notifyChoice() === true && (current.attendees?.length ?? 0) > 0
          ? { sendUpdates: "all" as const }
          : {}),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
      return
    }
    setSaving(false)
    void reloadCurrentWindow(api)
    close()
    // Undo puts a deleted one-off event back (a cancelled occurrence comes back with the series).
    if (!ctx) {
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

  /** The account's answer: a recurring meeting asks for this occurrence or all of them. */
  function answer(response: RsvpResponse): void {
    if (series()) setPending({ rsvp: response })
    else void answerWith(response, null)
  }

  async function answerWith(response: RsvpResponse, scope: SeriesScope | null): Promise<void> {
    const current = event()
    if (!current) return
    setPending(null)
    setSaving(true)
    setError(null)
    const ctx = series()
    const scoped = ctx && scope ? scopeTarget(current, ctx, scope) : null
    try {
      await respondToEvent(api, {
        eventId: scoped?.eventId ?? current.eventId,
        response,
        ...(scoped && scoped.scope !== "following" ? { scope: scoped.scope } : {}),
        ...(scoped?.occurrenceStart ? { occurrenceStart: scoped.occurrenceStart } : {}),
      })
      setAttendees(
        attendees().map((a) => (a.self === true ? { ...a, responseStatus: response } : a)),
      )
      void reloadCurrentWindow(api)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function chooseScope(scope: SeriesScope): void {
    const action = pending()
    if (action === "save") void saveWith(scope)
    else if (action === "delete") void remove(scope)
    else if (action) void answerWith(action.rsvp, scope)
  }

  /** The choices the dialog offers: an answer is for one occurrence or all of them. */
  const scopeChoices = (): SeriesScope[] => {
    const action = pending()
    if (action && typeof action === "object") return ["occurrence", "series"]
    // A new repeat rule applies from an occurrence on, never to one occurrence alone.
    if (action === "save" && repeatChanged()) return ["following", "series"]
    return ["occurrence", "following", "series"]
  }

  const ownStatus = () => attendees().find((a) => a.self === true)?.responseStatus

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
            disabled={saving()}
            onClick={askDelete}
            data-testid="event-delete"
          >
            {i18n.t("calendar.deleteEvent")}
          </Button>
        </Show>
        <Button variant="outline" size="sm" onClick={close} data-testid="event-cancel">
          {i18n.t("calendar.cancel")}
        </Button>
        <Button size="sm" disabled={saving()} onClick={() => void save()} data-testid="event-save">
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
          <Show when={!isNew() && !event() && fetched() !== undefined}>
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

          <Show when={ownInvite()}>
            <div class="flex flex-wrap items-center gap-2" data-testid="event-rsvp">
              <span class="text-xs font-medium text-text-secondary">
                {i18n.t("calendar.rsvpQuestion")}
              </span>
              <For each={RSVP_CHOICES}>
                {(choice) => (
                  <Button
                    size="sm"
                    variant={ownStatus() === choice ? "default" : "outline"}
                    aria-pressed={ownStatus() === choice}
                    disabled={saving()}
                    onClick={() => answer(choice)}
                    data-testid={`event-rsvp-${choice}`}
                  >
                    {i18n.t(`calendar.rsvp.${choice}`)}
                  </Button>
                )}
              </For>
            </div>
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
            <Show when={!form().allDay && eventZone()}>
              {(zone) => (
                <span class="text-xs text-text-secondary" data-testid="event-zone-note">
                  {i18n.t("calendar.eventZoneNote", {
                    yours: zoneShortName(browserTimeZone(), i18n.locale()),
                    zone: zone().replaceAll("_", " "),
                  })}
                </span>
              )}
            </Show>
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
            <Show when={repeatEditable()}>
              <label class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-xs font-medium text-text-secondary">
                  {i18n.t("calendar.recurrence")}
                </span>
                <select
                  class={fieldClass}
                  value={repeat().freq}
                  onChange={(e) => editRepeat({ freq: e.currentTarget.value as RepeatFreq })}
                  data-testid="event-recurrence-select"
                >
                  <For each={REPEAT_FREQS}>
                    {(opt) => <option value={opt}>{i18n.t(`calendar.recurrence.${opt}`)}</option>}
                  </For>
                </select>
              </label>
            </Show>
          </div>

          <Show when={repeatEditable() && repeat().freq !== "none"}>
            <div
              class="flex flex-col gap-2 rounded-sm border border-border p-2"
              data-testid="event-repeat-editor"
            >
              <label class="flex items-center gap-2 text-sm">
                {i18n.t("calendar.repeatEvery")}
                <input
                  type="number"
                  min="1"
                  class={`${fieldClass} w-16`}
                  value={repeat().interval}
                  onInput={(e) =>
                    editRepeat({
                      interval: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)),
                    })
                  }
                  data-testid="event-repeat-interval"
                />
                {i18n.t(`calendar.repeatUnit.${repeat().freq}`)}
              </label>
              <Show when={repeat().freq === "weekly"}>
                <div class="flex flex-wrap gap-1" data-testid="event-repeat-days">
                  <For each={WEEKDAY_CODES}>
                    {(day) => (
                      <button
                        type="button"
                        aria-pressed={repeat().byDay.includes(day)}
                        class={`rounded-full border px-2 py-0.5 text-xs ${
                          repeat().byDay.includes(day)
                            ? "border-accent bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-accent"
                            : "border-border text-text-secondary"
                        }`}
                        onClick={() =>
                          editRepeat({
                            byDay: repeat().byDay.includes(day)
                              ? repeat().byDay.filter((d) => d !== day)
                              : [...repeat().byDay, day],
                          })
                        }
                        data-testid={`event-repeat-day-${day}`}
                      >
                        {i18n.t(`calendar.weekday.${day}`)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <span>{i18n.t("calendar.repeatEnds")}</span>
                <select
                  class={`${fieldClass} w-auto`}
                  value={repeat().end.kind}
                  onChange={(e) => {
                    const kind = e.currentTarget.value
                    editRepeat({
                      end:
                        kind === "until"
                          ? {
                              kind: "until",
                              date: form().allDay
                                ? form().startDate
                                : form().startLocal.slice(0, 10),
                            }
                          : kind === "count"
                            ? { kind: "count", count: 10 }
                            : { kind: "never" },
                    })
                  }}
                  data-testid="event-repeat-end"
                >
                  <option value="never">{i18n.t("calendar.repeatEnd.never")}</option>
                  <option value="until">{i18n.t("calendar.repeatEnd.until")}</option>
                  <option value="count">{i18n.t("calendar.repeatEnd.count")}</option>
                </select>
                <Show
                  when={repeat().end.kind === "until" ? (repeat().end as { date: string }) : null}
                >
                  {(end) => (
                    <input
                      type="date"
                      class={`${fieldClass} w-auto`}
                      value={end().date}
                      onInput={(e) =>
                        editRepeat({ end: { kind: "until", date: e.currentTarget.value } })
                      }
                      data-testid="event-repeat-until"
                    />
                  )}
                </Show>
                <Show
                  when={repeat().end.kind === "count" ? (repeat().end as { count: number }) : null}
                >
                  {(end) => (
                    <input
                      type="number"
                      min="1"
                      class={`${fieldClass} w-20`}
                      value={end().count}
                      onInput={(e) =>
                        editRepeat({
                          end: {
                            kind: "count",
                            count: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)),
                          },
                        })
                      }
                      data-testid="event-repeat-count"
                    />
                  )}
                </Show>
              </div>
            </div>
          </Show>

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
                      <Show when={attendeesEditable()}>
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
                  onInput={(e) => {
                    setAttendeeInput(e.currentTarget.value)
                    suggest.setQuery(e.currentTarget.value)
                  }}
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
              <Show when={suggest.results().length > 0}>
                <ul
                  class="flex flex-col rounded-sm border border-border bg-bg"
                  data-testid="event-attendee-suggestions"
                >
                  <For each={suggest.results()}>
                    {(s) => (
                      <li>
                        <button
                          type="button"
                          class="flex w-full min-w-0 items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-surface-hover"
                          onClick={() => addAttendee(s.email)}
                          data-testid="event-attendee-suggestion"
                        >
                          <span class="truncate font-medium text-text">{s.name}</span>
                          <span class="truncate text-text-secondary">{s.email}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
            <Show when={attendees().length > 0 && attendeesEditable()}>
              <label class="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notify()}
                  onChange={(e) => setNotifyChoice(e.currentTarget.checked)}
                  data-testid="event-send-invitations"
                />
                {i18n.t("calendar.sendInvitations")}
              </label>
            </Show>
            <Show when={attendees().length > 0 && !form().allDay}>
              <FindATime
                attendees={attendees().map((a) => a.email)}
                startLocal={form().startLocal}
                endLocal={form().endLocal}
                onPick={(slot) => update(slot)}
              />
            </Show>
          </div>

          <Show when={event()?.pushError ?? event()?.pushNotice}>
            {(message) => (
              <div class="text-xs text-text-secondary" data-testid="event-push-error">
                {i18n.t("calendar.pushRejected", { message: message() })}
              </div>
            )}
          </Show>
          <Show when={isRecurringMaster() && initialRepeat === null}>
            <div class="text-xs text-text-secondary" data-testid="event-recurring-note">
              {i18n.t("calendar.recurrenceKept")}
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

      <Dialog open={pending() !== null} onOpenChange={(open) => !open && setPending(null)}>
        <Dialog.Content>
          <Dialog.Title>
            {pending() === "delete"
              ? i18n.t("calendar.scopeDeleteTitle")
              : typeof pending() === "object"
                ? i18n.t("calendar.scopeRsvpTitle")
                : i18n.t("calendar.scopeSaveTitle")}
          </Dialog.Title>
          <div class="mt-2 flex flex-col gap-1" data-testid="event-scope-dialog">
            <For each={scopeChoices()}>
              {(scope) => (
                <Button
                  variant="outline"
                  onClick={() => chooseScope(scope)}
                  data-testid={`event-scope-${scope}`}
                >
                  {i18n.t(`calendar.scope.${scope}`)}
                </Button>
              )}
            </For>
          </div>
          <Show when={pending() === "delete" && (event()?.attendees?.length ?? 0) > 0}>
            <label class="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyChoice() === true}
                onChange={(e) => setNotifyChoice(e.currentTarget.checked)}
                data-testid="event-delete-notify"
              />
              {i18n.t("calendar.notifyCancellation")}
            </label>
          </Show>
          <div class="mt-4 flex justify-end">
            <Button
              variant="ghost"
              onClick={() => setPending(null)}
              data-testid="event-scope-cancel"
            >
              {i18n.t("calendar.cancel")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>

      <Dialog open={confirmDelete()} onOpenChange={setConfirmDelete}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("calendar.deleteConfirmTitle")}</Dialog.Title>
          <p class="text-sm text-text-secondary">
            {i18n.t("calendar.deleteConfirmBody", {
              title: event()?.title || i18n.t("calendar.untitledEvent"),
            })}
          </p>
          <Show when={(event()?.attendees?.length ?? 0) > 0}>
            <label class="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyChoice() === true}
                onChange={(e) => setNotifyChoice(e.currentTarget.checked)}
                data-testid="event-delete-notify"
              />
              {i18n.t("calendar.notifyCancellation")}
            </label>
          </Show>
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
