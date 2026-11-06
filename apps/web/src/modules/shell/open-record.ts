// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RECORD OPEN INSIDE A TAB. A master and detail page keeps one tab for many
// records (`boxtal:shipments`), so the tab's own id says nothing about the parcel
// on screen. The agent was asked about "this" parcel, had no record to go on, and
// answered about another one with full confidence. So a page that opens a record
// in a pane says which (`app.trackOpenRecord` in an app, `trackOpenRecord` here in
// a kernel page), and a turn sent while that tab is active names the record
// instead of the page (`currentViewForTurn`).

import { type Accessor, createEffect, getOwner, onCleanup } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { useTabId } from "~/modules/shell/TabVisibilityContext"

export interface OpenRecord {
  /** `<app>:<entity>`, the shape a turn's `currentView.tabType` takes. */
  tabType: string
  entityId: string
}

const openByTab = new Map<string, OpenRecord>()

/** Say what is open in a tab, or null for nothing. */
export function setOpenRecord(tabId: string, record: OpenRecord | null): void {
  if (record) openByTab.set(tabId, record)
  else openByTab.delete(tabId)
}

/** The record open in a tab, if its page said so. */
export function openRecordOf(tabId: string): OpenRecord | undefined {
  return openByTab.get(tabId)
}

onSessionTeardown(() => openByTab.clear())

/**
 * From a page's component body: keep its tab's open record equal to `id()`, until
 * the page goes away. Outside a tab (a dock, a slot in no tab) it does nothing:
 * there is no page to speak for.
 */
export function trackOpenRecord(
  app: string,
  entityType: string,
  id: Accessor<string | null | undefined>,
): void {
  const tabId = useTabId()
  if (!tabId || !getOwner()) return
  const tabType = `${app}:${entityType}`
  createEffect(() => {
    const entityId = id()
    setOpenRecord(tabId, entityId ? { tabType, entityId } : null)
  })
  onCleanup(() => setOpenRecord(tabId, null))
}
