// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { getActivityBarEntries, getTabType, resetRegistry } from "~/framework/app-registry"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import { registerAgentApp } from "./agent-app"

describe("agent-app registration", () => {
  beforeEach(() => {
    resetRegistry()
  })

  it("the agent app registers no chat tab type", () => {
    registerAgentApp()
    expect(getTabType("agents:chat")).toBeUndefined()
    const entry = getActivityBarEntries().find((e) => e.id === "agents")
    expect(entry?.tabAction.type).not.toBe("agents:chat")
  })

  it("activity bar entry uses the agent glyph, sits in the bottom section above Settings (order 900 < 1000)", () => {
    registerAgentApp()
    const entry = getActivityBarEntries().find((e) => e.id === "agents")
    expect(entry).toBeDefined()
    expect(entry?.position).toBe("bottom")
    expect(entry?.order).toBe(900)
    expect(entry?.label).toBe("Agents")
  })

  // There is no directory SCREEN any more: the sidebar is the roster, and the
  // main area always shows an agent. The activity bar therefore opens the
  // viewer's OWN agent, and `/agents` resolves to it through the shell's
  // redirect rather than through a tab type of its own.
  it("the activity bar opens the viewer's own agent, and no directory tab type remains", () => {
    registerAgentApp()
    expect(getTabType("agents:directory")).toBeUndefined()
    const entry = getActivityBarEntries().find((e) => e.id === "agents")
    expect(entry?.tabAction.type).toBe("agents:agent")
    expect(entry?.tabAction.entityId).toBe("self")
  })

  it("registers the agent page at /agents/:entityId keyed by handle", () => {
    registerAgentApp()
    const t = getTabType("agents:agent")
    expect(t).toBeDefined()
    expect(t?.urlPattern).toBe("/agents/:entityId")
    expect(t?.singleton).not.toBe(true)
  })

  // P4c FX-F3: `resolveLabel` runs the instant the URL opens the tab, which on
  // a COLD deep load is before anything has fetched the org's agents. The tab
  // kept the registry's generic "Agent" for the rest of the session.
  it("a cold deep load resolves the agent's name", async () => {
    resetAgentDirectory()
    resetTabStore()
    registerAgentApp()

    // Cold: nothing has loaded the directory, so the label is all the URL had.
    const label = getTabType("agents:agent")?.resolveLabel?.("@ada")
    expect(label).toBeUndefined()
    openTab({
      type: "agents:agent",
      entityId: "@ada",
      label: label ?? getTabType("agents:agent")!.defaultLabel,
    })
    const tab = () => tabStore.tabs.find((t) => t.type === "agents:agent")
    expect(tab()?.label).toBe("Agent")

    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: "ag-ada", handle: "@ada", displayName: "Ada", kind: "personal" }],
      }),
    })

    expect(tab()?.label).toBe("Ada")
    expect(getTabType("agents:agent")?.resolveLabel?.("@ada")).toBe("Ada")
  })

  it("no legacy agent tab type remains registered", () => {
    registerAgentApp()
    // The flat screens and the per-artifact detail tabs are tabs of an agent's
    // page now (P4c-T39). Their URLs still resolve, through the shell's
    // `legacyRedirectFor`, but nothing answers them as a tab type any more.
    for (const t of [
      "agents:skills",
      "agents:skill",
      "agents:routines",
      "agents:routine",
      "agents:memories",
      "agents:memory",
      "agents:profile",
    ]) {
      expect(getTabType(t)).toBeUndefined()
    }
    // And no surviving agent tab type answers a `/agent/...` URL.
    for (const t of ["agents:agent"]) {
      expect(getTabType(t)?.urlPattern?.startsWith("/agent/")).toBe(false)
    }
  })
})
