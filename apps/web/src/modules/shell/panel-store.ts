// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

const STORAGE_KEY = "liaison:panelOpen"
// The key an older build wrote. Read once to carry a person's preference
// across the rename, never written. REMOVAL DATE: one release after the chat
// dock ships (P4c); kept deliberately at the remnant audit (T47, 2026-09-15).
const LEGACY_STORAGE_KEY = "liaison:agentPanelOpen"

// The side panel no longer hosts the agent or a per-entity discussion: chats
// live in the dock (`modules/shell/dock-store`) and a discussion about an
// entity is a message in the viewer's personal DM
// (`discussWithPersonalAgent`). What is left here is the app-panel surface a
// plugin contributes.
export type PanelState = {
  type: "app-panel"
  appName: string
  panelType: string
  context?: unknown
}

// An older build persisted the panel's open flag as `"true"`/`"false"` and, in
// one revision, a serialized panel object such as `{"type":"agent"}`. Anything
// that is not one of the two booleans is dropped rather than restored: the
// agent variant no longer exists, and a parse of it must not decide the layout
// (or throw) on the first render after an upgrade.
function readStoredOpen(key: string): boolean | null {
  try {
    const stored = localStorage.getItem(key)
    if (stored === "true") return true
    if (stored === "false") return false
    return null
  } catch {
    return null
  }
}

function readInitialOpen(): boolean {
  return readStoredOpen(STORAGE_KEY) ?? readStoredOpen(LEGACY_STORAGE_KEY) ?? true
}

const [activePanel, _setActivePanel] = createSignal<PanelState | null>(null)
const [panelOpen, _setPanelOpen] = createSignal(readInitialOpen())
// True while the panel is closed because the user closed it (the toggle, or a
// closed state persisted from an earlier session). Openers the user did not ask
// for must not override it.
const [panelClosedByUser, setPanelClosedByUser] = createSignal(!readInitialOpen())

export { activePanel, panelClosedByUser, panelOpen }

export function setActivePanel(panel: PanelState): void {
  _setActivePanel(panel)
  setPanelClosedByUser(false)
  if (!panelOpen()) _setPanelOpen(true)
  persistOpen(true)
}

export function clearActivePanel(): void {
  _setActivePanel(null)
}

// The panel is a docked column at desktop and a viewport-covering sheet at
// tablet and phone. A sheet that opens itself owns the screen: nothing under it
// can be read or clicked until the user dismisses it, so entering a compact
// tier closes the panel. The persisted preference is left alone (this is not a
// user close), and returning to desktop restores it.
export function syncPanelForTier(tier: "desktop" | "tablet" | "phone"): void {
  if (tier !== "desktop") {
    _setPanelOpen(false)
    return
  }
  _setPanelOpen(readInitialOpen())
}

export function togglePanel(): void {
  const next = !panelOpen()
  _setPanelOpen(next)
  setPanelClosedByUser(!next)
  persistOpen(next)
}

function persistOpen(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
    localStorage.setItem(LEGACY_STORAGE_KEY, String(value))
  } catch {
    /* quota exceeded */
  }
}

export function resetPanelStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    /* ok */
  }
  _setActivePanel(null)
  _setPanelOpen(true)
  setPanelClosedByUser(false)
}

onSessionTeardown(resetPanelStore)
