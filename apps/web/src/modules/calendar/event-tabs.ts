// SPDX-License-Identifier: FSL-1.1-ALv2
// Opening an event in its own tab. Creating and editing a full event is cognitive work, so it
// gets a tab (the agent stays reachable beside it), not a modal; the quick-create popover on the
// grid covers the one-line case. A new event's tab id is `new-<n>`, and the values the popover
// or the grid already chose wait here until the tab reads them.
import { activateTab, evictTabByEntity, openTab, tabStore } from "~/modules/shell/tab-store"
import type { CalendarEventDto } from "./calendar-api"
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

export function openEventTab(event: CalendarEventDto, untitled: string): void {
  openedEvents.set(event.eventId, event)
  rememberOpener(event.eventId)
  openTab({
    preview: false,
    type: EVENT_TAB_TYPE,
    entityId: event.eventId,
    label: event.title || untitled,
    routePath: `/calendar/event/${event.eventId}`,
  })
}
