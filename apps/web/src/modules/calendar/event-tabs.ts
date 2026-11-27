// SPDX-License-Identifier: FSL-1.1-ALv2
// Opening an event in its own tab. Creating and editing a full event is cognitive work, so it
// gets a tab (the agent stays reachable beside it), not a modal; the quick-create popover on the
// grid covers the one-line case. A new event's tab id is `new-<n>`, and the values the popover
// or the grid already chose wait here until the tab reads them.
import { openTab } from "~/modules/shell/tab-store"
import type { CalendarEventDto } from "./calendar-api"
import type { FormDefaults } from "./event-form"

export const EVENT_TAB_TYPE = "calendar:event"

const drafts = new Map<string, FormDefaults>()
/** The event as it was when its tab was opened, for a tab whose window the store no longer holds. */
const openedEvents = new Map<string, CalendarEventDto>()
let nextDraft = 0

export function takeDraft(entityId: string): FormDefaults | undefined {
  return drafts.get(entityId)
}

export function forgetDraft(entityId: string): void {
  drafts.delete(entityId)
}

export function openedEvent(eventId: string): CalendarEventDto | undefined {
  return openedEvents.get(eventId)
}

export function openNewEventTab(defaults: FormDefaults, label: string): string {
  const entityId = `new-${Date.now().toString(36)}-${++nextDraft}`
  drafts.set(entityId, defaults)
  openTab({
    type: EVENT_TAB_TYPE,
    entityId,
    label,
    routePath: `/calendar/event/${entityId}`,
  })
  return entityId
}

export function openEventTab(event: CalendarEventDto, untitled: string): void {
  openedEvents.set(event.eventId, event)
  openTab({
    type: EVENT_TAB_TYPE,
    entityId: event.eventId,
    label: event.title || untitled,
    routePath: `/calendar/event/${event.eventId}`,
  })
}
