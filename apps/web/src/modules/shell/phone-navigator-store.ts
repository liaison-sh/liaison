// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone tier's navigator (M1-A T1). At phone width the shell is one
// column: there is no room for the sidebar column the desktop grid carries,
// and until now the tier simply rendered NOTHING there, so mail, mailbox,
// settings, knowledge and contacts lost their navigation entirely.
//
// The fix reuses what already exists rather than writing a second navigation:
// the SAME sidebar component the registry declares for the active tab type is
// rendered inside an OverlaySheet. This module owns only the open flag plus
// the two derivations both the opener (PhoneTopBar, in MainPanel) and the
// sheet (Sidebar) read, so the control and the surface can never disagree
// about whether a sidebar exists.
import type { Component } from "solid-js"
import { createSignal } from "solid-js"
import {
  getActivityBarEntries,
  getTabType,
  resolveRegisteredTabType,
  tabTypeRegistryVersion,
} from "~/framework/app-registry"
import { isAppUnavailable } from "~/framework/unavailable-apps"
import { tabStore } from "~/modules/shell/tab-store"

const [phoneNavigatorOpen, setPhoneNavigatorOpen] = createSignal(false)

export { phoneNavigatorOpen }

export function openPhoneNavigator(): void {
  setPhoneNavigatorOpen(true)
}

export function closePhoneNavigator(): void {
  setPhoneNavigatorOpen(false)
}

function activeTabType(): string | null {
  // Tracked so a manifest app registering its tab types after first paint
  // re-derives the sidebar rather than leaving the opener hidden forever.
  tabTypeRegistryVersion()
  const activeTab = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId)
  if (!activeTab) return null
  return resolveRegisteredTabType(activeTab.type) ?? activeTab.type
}

/** The sidebar component the ACTIVE tab type registers, or null when it has none. */
export function activeSidebarComponent(): Component | null {
  const type = activeTabType()
  if (!type) return null
  const reg = getTabType(type)
  // An unavailable app (S19, S20) keeps its routes for the notice, never its navigation.
  if (isAppUnavailable(reg?.appId)) return null
  return reg?.sidebar ?? null
}

/**
 * What to title the navigator sheet: the app's own label as the activity bar
 * spells it ("Mail", "Knowledge"), falling back to the tab type's default
 * label for a tab type whose app has no bar entry.
 */
export function activeSidebarTitle(): string {
  const type = activeTabType()
  if (!type) return ""
  const reg = getTabType(type)
  const appId = reg?.appId
  const entry = appId ? getActivityBarEntries().find((e) => e.appId === appId) : undefined
  return entry?.label ?? reg?.defaultLabel ?? ""
}
