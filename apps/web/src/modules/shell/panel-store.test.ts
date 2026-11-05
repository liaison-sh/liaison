// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import {
  activePanel,
  clearActivePanel,
  panelClosedByUser,
  panelOpen,
  resetPanelStore,
  setActivePanel,
  syncPanelForTier,
  togglePanel,
} from "./panel-store"

describe("panel-store", () => {
  afterEach(() => resetPanelStore())

  it("defaults to no active panel, open", () => {
    expect(activePanel()).toBeNull()
    expect(panelOpen()).toBe(true)
  })

  it("the panel union has no agent member", () => {
    // @ts-expect-error the agent panel variant is gone: agent chats live in the dock
    setActivePanel({ type: "agent" })
  })

  it("togglePanel closes and opens the panel", () => {
    expect(panelOpen()).toBe(true)
    togglePanel()
    expect(panelOpen()).toBe(false)
    togglePanel()
    expect(panelOpen()).toBe(true)
  })

  it("records a user close so openers the user did not ask for can respect it", () => {
    expect(panelClosedByUser()).toBe(false)
    togglePanel()
    expect(panelOpen()).toBe(false)
    expect(panelClosedByUser()).toBe(true)
    togglePanel()
    expect(panelClosedByUser()).toBe(false)
  })

  it("an explicit open clears the user-closed mark", () => {
    togglePanel()
    setActivePanel({ type: "app-panel", appName: "mail", panelType: "filters" })
    expect(panelOpen()).toBe(true)
    expect(panelClosedByUser()).toBe(false)
  })

  it("setActivePanel switches panel type", () => {
    setActivePanel({ type: "app-panel", appName: "mail", panelType: "filters" })
    expect(activePanel()?.type).toBe("app-panel")
    clearActivePanel()
    expect(activePanel()).toBeNull()
  })

  it("setActivePanel opens panel if closed", () => {
    togglePanel() // close
    expect(panelOpen()).toBe(false)
    setActivePanel({ type: "app-panel", appName: "mail", panelType: "filters" })
    expect(panelOpen()).toBe(true)
  })

  it("persists open/close state to current and legacy localStorage keys", () => {
    togglePanel() // close
    expect(localStorage.getItem("liaison:panelOpen")).toBe("false")
    expect(localStorage.getItem("liaison:agentPanelOpen")).toBe("false")
    togglePanel() // open
    expect(localStorage.getItem("liaison:panelOpen")).toBe("true")
    expect(localStorage.getItem("liaison:agentPanelOpen")).toBe("true")
    localStorage.removeItem("liaison:panelOpen")
    localStorage.removeItem("liaison:agentPanelOpen")
  })

  it("drops a panel state persisted by an older build instead of restoring it", () => {
    localStorage.setItem("liaison:panelOpen", '{"type":"agent"}')
    localStorage.setItem("liaison:agentPanelOpen", "false")
    // The unusable current value is skipped, the legacy boolean still decides.
    syncPanelForTier("phone")
    syncPanelForTier("desktop")
    expect(panelOpen()).toBe(false)
    localStorage.removeItem("liaison:panelOpen")
    localStorage.removeItem("liaison:agentPanelOpen")
  })

  it("syncPanelForTier closes the panel at tablet and phone", () => {
    expect(panelOpen()).toBe(true)
    syncPanelForTier("tablet")
    expect(panelOpen()).toBe(false)
    syncPanelForTier("desktop")
    expect(panelOpen()).toBe(true)
    syncPanelForTier("phone")
    expect(panelOpen()).toBe(false)
  })

  it("syncPanelForTier does not record a compact close as a user close", () => {
    syncPanelForTier("phone")
    expect(panelOpen()).toBe(false)
    expect(panelClosedByUser()).toBe(false)
    syncPanelForTier("desktop")
    expect(panelOpen()).toBe(true)
  })

  it("syncPanelForTier at desktop honours a close the user made", () => {
    togglePanel()
    expect(panelOpen()).toBe(false)
    syncPanelForTier("phone")
    syncPanelForTier("desktop")
    expect(panelOpen()).toBe(false)
  })
})
