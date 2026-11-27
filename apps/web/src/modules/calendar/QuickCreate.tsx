// SPDX-License-Identifier: FSL-1.1-ALv2
// The quick-create popover: a small card anchored where the grid was clicked, for the common
// case (a title, the time already chosen, a calendar, a Meet). Enter creates; "More options"
// carries what was typed into the full event tab; Esc or a click outside closes it.
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import type { CalendarListItem } from "./calendar-api"
import { createCalendarEvent, reloadCurrentWindow } from "./calendar-store"
import { createPayload, type FormDefaults, formFromEvent, isWritableCalendar } from "./event-form"
import { openNewEventTab } from "./event-tabs"

export interface QuickCreateRequest {
  start: Date
  end: Date
  allDay: boolean
  /** Viewport point the card is anchored to. */
  x: number
  y: number
}

const CARD_WIDTH = 320
const CARD_HEIGHT = 220
const GUTTER = 12

export const QuickCreate: Component<{
  request: QuickCreateRequest
  calendars: CalendarListItem[]
  onClose: () => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  let card: HTMLDivElement | undefined
  let titleInput: HTMLInputElement | undefined

  const writable = createMemo(() =>
    props.calendars.filter((c) => c.selected !== false && isWritableCalendar(c)),
  )
  const [title, setTitle] = createSignal("")
  const [calendarId, setCalendarId] = createSignal(writable()[0]?.id ?? "")
  const [meet, setMeet] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const position = createMemo(() => {
    const vw = typeof window === "undefined" ? 1440 : window.innerWidth
    const vh = typeof window === "undefined" ? 900 : window.innerHeight
    const left = Math.min(Math.max(GUTTER, props.request.x + 8), vw - CARD_WIDTH - GUTTER)
    const top = Math.min(Math.max(GUTTER, props.request.y - 24), vh - CARD_HEIGHT - GUTTER)
    return { left: `${Math.max(GUTTER, left)}px`, top: `${Math.max(GUTTER, top)}px` }
  })

  const when = createMemo(() => {
    const { start, end, allDay } = props.request
    const day = start.toLocaleDateString(i18n.locale(), {
      weekday: "long",
      day: "numeric",
      month: "long",
    })
    if (allDay) return `${day} · ${i18n.t("calendar.allDay")}`
    const time = (d: Date) =>
      d.toLocaleTimeString(i18n.locale(), { hour: "numeric", minute: "2-digit" })
    return `${day} · ${time(start)} - ${time(end)}`
  })

  function defaults(): FormDefaults {
    const { start, end, allDay } = props.request
    return { start, end, allDay, title: title(), calendarId: calendarId() }
  }

  async function create(): Promise<void> {
    if (!title().trim()) {
      setError(i18n.t("calendar.titleRequired"))
      titleInput?.focus()
      return
    }
    setSaving(true)
    setError(null)
    try {
      const form = { ...formFromEvent(null, defaults(), props.calendars), meet: meet() }
      await createCalendarEvent(api, createPayload(form))
      void reloadCurrentWindow(api)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function moreOptions(): void {
    openNewEventTab({ ...defaults() }, i18n.t("calendar.newEvent"))
    props.onClose()
  }

  onMount(() => {
    titleInput?.focus()
    const onPointer = (e: PointerEvent) => {
      if (card && !card.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    // Next tick: the click that opened the card must not close it.
    const id = setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      clearTimeout(id)
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <Portal>
      <div
        ref={card}
        role="dialog"
        aria-label={i18n.t("calendar.newEvent")}
        class="fixed z-50 flex flex-col gap-3 rounded-xl border border-border bg-bg p-4 shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
        style={{ width: `${CARD_WIDTH}px`, ...position() }}
        data-testid="calendar-quick-create"
      >
        <input
          ref={titleInput}
          class="w-full border-b border-border bg-transparent pb-1 text-base font-medium text-text outline-none focus:border-accent"
          placeholder={i18n.t("calendar.addTitle")}
          aria-label={i18n.t("calendar.title")}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void create()
            }
          }}
          data-testid="quick-create-title"
        />
        <div class="text-xs text-text-secondary" data-testid="quick-create-when">
          {when()}
        </div>
        <Show when={writable().length > 1}>
          <select
            class="rounded-sm border border-border bg-bg px-2 py-1 text-xs"
            value={calendarId()}
            onChange={(e) => setCalendarId(e.currentTarget.value)}
            aria-label={i18n.t("calendar.calendarPicker")}
            data-testid="quick-create-calendar"
          >
            <For each={writable()}>{(cal) => <option value={cal.id}>{cal.name}</option>}</For>
          </select>
        </Show>
        <label class="flex items-center gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={meet()}
            onChange={(e) => setMeet(e.currentTarget.checked)}
            data-testid="quick-create-meet"
          />
          {i18n.t("calendar.addMeet")}
        </label>
        <Show when={error()}>
          {(msg) => (
            <div class="text-xs text-error" data-testid="quick-create-error">
              {msg()}
            </div>
          )}
        </Show>
        <div class="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={moreOptions} data-testid="quick-create-more">
            {i18n.t("calendar.moreOptions")}
          </Button>
          <Button
            size="sm"
            disabled={saving()}
            onClick={() => void create()}
            data-testid="quick-create-save"
          >
            {i18n.t("calendar.save")}
          </Button>
        </div>
      </div>
    </Portal>
  )
}
