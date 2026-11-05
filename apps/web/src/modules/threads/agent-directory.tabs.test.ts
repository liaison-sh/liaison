// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE AGENT, ONE TAB, even when the org's agent listing has not arrived yet.
//
// The Home sidebar's agent row is clickable on a cold load and it knows only
// the agent's uuid, so `openAgentPage` had nothing to canonicalize with: the
// tab opened on `/agents/<uuid>` and KEPT that key for the session, beside the
// `@handle` tab every other surface produced. Re-labelling the tab was never
// enough: the key is what makes one agent one tab.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { registerAgentApp } from "~/modules/agent/agent-app"
import { promoteTab, resetTabStore, tabStore, updateTabRoutePath } from "~/modules/shell/tab-store"
import {
  AGENT_PAGE_TAB_TYPE,
  loadAgentDirectory,
  openAgentPage,
  registerAgentDirectoryLoader,
  resetAgentDirectory,
} from "~/modules/threads/agent-directory"

const AGENT_ID = "166a5139-1111-4111-8111-111111111111"
const DIRECTORY = [{ id: AGENT_ID, handle: "@taylor", displayName: "Taylor", kind: "role" }]

function agentTabs() {
  return tabStore.tabs.filter((t) => t.type === AGENT_PAGE_TAB_TYPE)
}

describe("agent page tabs before the directory has loaded", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetAgentDirectory()
    registerAgentDirectoryLoader(async () => {})
    registerAgentApp()
  })

  it("opening an agent by uuid asks for the directory and re-keys the tab onto the handle", async () => {
    const api = { get: vi.fn(async () => ({ data: DIRECTORY })) }
    let pending: Promise<void> | null = null
    registerAgentDirectoryLoader(() => {
      pending = loadAgentDirectory(api)
      return pending
    })

    // Cold: the directory is empty, so the only spelling the row has is the id.
    openAgentPage({ id: AGENT_ID, name: "Taylor" })
    expect(agentTabs()).toHaveLength(1)
    expect(agentTabs()[0].entityId).toBe(AGENT_ID)
    expect(api.get).toHaveBeenCalledTimes(1)

    await pending

    const tabs = agentTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].entityId).toBe("@taylor")
    expect(tabs[0].id).toBe(`${AGENT_PAGE_TAB_TYPE}:@taylor`)
    expect(tabs[0].routePath).toBe("/agents/@taylor")
    expect(tabs[0].label).toBe("Taylor")
    expect(tabStore.activeTabId).toBe(`${AGENT_PAGE_TAB_TYPE}:@taylor`)
  })

  it("the uuid tab merges into the handle tab instead of standing beside it", async () => {
    openAgentPage({ id: AGENT_ID, name: "Taylor" })
    // A permanent tab: only one EPHEMERAL preview exists app wide, so the two
    // spellings can only stand side by side once the first one is kept.
    promoteTab(agentTabs()[0].id)
    openAgentPage({ id: "@taylor", name: "Taylor" })
    expect(agentTabs()).toHaveLength(2)

    await loadAgentDirectory({ get: async () => ({ data: DIRECTORY }) })

    const tabs = agentTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].entityId).toBe("@taylor")
    expect(tabStore.activeTabId).toBe(`${AGENT_PAGE_TAB_TYPE}:@taylor`)
  })

  it("a re-keyed tab keeps the page sub route it was on", async () => {
    openAgentPage({ id: AGENT_ID, name: "Taylor" })
    updateTabRoutePath(agentTabs()[0].id, `/agents/${AGENT_ID}/skills`)

    await loadAgentDirectory({ get: async () => ({ data: DIRECTORY }) })

    expect(agentTabs()).toHaveLength(1)
    expect(agentTabs()[0].routePath).toBe("/agents/@taylor/skills")
  })

  it("a caller that already knows the handle opens the canonical tab with no roundtrip", () => {
    const load = vi.fn(async () => {})
    registerAgentDirectoryLoader(load)

    openAgentPage({ id: AGENT_ID, name: "Taylor", handle: "@taylor" })

    expect(agentTabs()).toHaveLength(1)
    expect(agentTabs()[0].entityId).toBe("@taylor")
    expect(load).not.toHaveBeenCalled()
  })

  it("an agent the directory cannot name keeps the id it was opened with", async () => {
    openAgentPage({ id: AGENT_ID, name: "Taylor" })

    await loadAgentDirectory({ get: async () => ({ data: [] }) })

    expect(agentTabs()).toHaveLength(1)
    expect(agentTabs()[0].entityId).toBe(AGENT_ID)
  })
})
