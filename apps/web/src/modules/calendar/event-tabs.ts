// SPDX-License-Identifier: FSL-1.1-ALv2
// Opening an event in its own tab. Creating and editing a full event is cognitive work, so it
// gets a tab (the agent stays reachable beside it), not a modal; the quick-create popover on the
// grid covers the one-line case. A new event's tab id is `new-<n>`, and the values the popover
// or the grid already chose wait here until the tab reads them.
import { activateTab, evictTabByEntity, openTab, tabStore } from "~/modules/shell/tab-store"
import type { CalendarEventDto, CalendarPoint } from "./calendar-api"
import type { FormDefaults } from "./event-form"

export const EVENT_TAB_TYPE = "calendar:event"

const drafts = new Map<string, FormDefaults>()
/** The event as it was when its tab was opened, for a tab whose window the store no longer holds. */
const openedEvents = new Map<string, CalendarEventDto>()
/** The tab an event tab was opened from (the calendar), to return to when it closes. */
const openers = new Map<string, string>()
let nextDraft = 0

function rememberOpener(entityId: string): void {
  if (tabStore.activeTabId) openers.set(entityId, tabStore.activeTabId)
}

/** Close an event tab and go back to the calendar it was opened from. */
export function closeEventTab(entityId: string): void {
  drafts.delete(entityId)
  const opener = openers.get(entityId)
  openers.delete(entityId)
  evictTabByEntity(EVENT_TAB_TYPE, entityId)
  if (opener && tabStore.tabs.some((t) => t.id === opener)) activateTab(opener)
}

export function takeDraft(entityId: string): FormDefaults | undefined {
  return drafts.get(entityId)
}

export function openedEvent(eventId: string): CalendarEventDto | undefined {
  return openedEvents.get(eventId)
}

export function openNewEventTab(defaults: FormDefaults, label: string): string {
  const entityId = `new-${Date.now().toString(36)}-${++nextDraft}`
  drafts.set(entityId, defaults)
  rememberOpener(entityId)
  // A permanent tab: an editor is engagement, and a preview tab would replace the calendar's.
  openTab({
    preview: false,
    type: EVENT_TAB_TYPE,
    entityId,
    label,
    routePath: `/calendar/event/${entityId}`,
  })
  return entityId
}

/** An occurrence's start as a URL-safe key: `20261116T080000Z` (an instant), `20261116` (a date). */
function pointKey(point: CalendarPoint): string | null {
  if (point.date) return point.date.replace(/-/g, "")
  if (point.dateTime) {
    const at = new Date(point.dateTime)
    if (Number.isNaN(at.getTime())) return null
    return `${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
  }
  return null
}

/**
 * An event tab's id: the event id, or `<series id>~<occurrence start>` for one occurrence of a
 * recurring series (the grid shows every occurrence under the series' id), so two occurrences
 * open two tabs and the tab knows which one it edits.
 */
export function eventTabEntityId(
  event: CalendarEventDto,
  occurrence?: CalendarPoint | null,
): string {
  const recurring = !event.recurringEventId && (event.recurrence?.length ?? 0) > 0
  const key = recurring && occurrence ? pointKey(occurrence) : null
  return key ? `${event.eventId}~${key}` : event.eventId
}

/** The event id and, for one occurrence of a series, that occurrence's original start. */
export function parseEventTabEntityId(entityId: string): {
  eventId: string
  occurrence: CalendarPoint | null
} {
  const at = entityId.indexOf("~")
  if (at < 0) return { eventId: entityId, occurrence: null }
  const key = entityId.slice(at + 1)
  const eventId = entityId.slice(0, at)
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(key)
  if (date) return { eventId, occurrence: { date: `${date[1]}-${date[2]}-${date[3]}` } }
  const instant = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(key)
  if (!instant) return { eventId, occurrence: null }
  const [, y, mo, d, h, mi, sec] = instant
  return { eventId, occurrence: { dateTime: `${y}-${mo}-${d}T${h}:${mi}:${sec}.000Z` } }
}

export function openEventTab(
  event: CalendarEventDto,
  untitled: string,
  occurrence?: CalendarPoint | null,
): void {
  const entityId = eventTabEntityId(event, occurrence)
  openedEvents.set(event.eventId, event)
  rememberOpener(entityId)
  openTab({
    preview: false,
    type: EVENT_TAB_TYPE,
    entityId,
    label: event.title || untitled,
    routePath: `/calendar/event/${entityId}`,
  })
}
