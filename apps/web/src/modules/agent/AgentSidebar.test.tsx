// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import AgentSidebar from "./AgentSidebar"

const AGENTS = [
  { id: "a-base", handle: "@base", displayName: "Base", kind: "system", ownerUserId: null },
  { id: "a-logistics", handle: "@logistics", displayName: "Logistics", kind: "role" },
  { id: "a-mine", handle: "@admin", displayName: "Taylor's agent", kind: "personal" },
]

/** The grouped answer `GET /api/agents/search` gives the sidebar. */
const SEARCH = {
  agents: [{ agentId: "a-logistics", handle: "@logistics", displayName: "Logistics" }],
  skills: [
    {
      agentId: "a-logistics",
      agentHandle: "@logistics",
      agentName: "Logistics",
      id: "sk-1",
      name: "refund-triage",
      description: "How refunds are triaged",
    },
  ],
  routines: [
    {
      agentId: "a-logistics",
      agentHandle: "@logistics",
      agentName: "Logistics",
      id: "rt-1",
      name: "refund-sweep",
      description: "Sweeps the refund queue",
    },
  ],
  memories: [
    {
      agentId: "a-mine",
      agentHandle: "@admin",
      agentName: "Taylor's agent",
      path: "reference/refund-rule.md",
      name: "refund-rule",
      description: "Refund window is 30 days",
    },
  ],
}

afterEach(() => {
  resetAgentDirectory()
  try {
    resetTabStore()
  } catch {
    /* test isolation */
  }
})

function renderWithApi(rows: unknown[] = AGENTS, search: unknown = SEARCH) {
  const api = {
    get: vi.fn(async (path: string) => (path.startsWith("/agents/search") ? search : rows)),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentSidebar />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentSidebar", () => {
  it("the agents sidebar lists your agent first and @base last, dimmed", async () => {
    renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    const handles = [
      ...screen.getByTestId("agent-sidebar").querySelectorAll("[data-agent-handle]"),
    ].map((row) => row.getAttribute("data-agent-handle"))
    expect(handles).toEqual(["@admin", "@logistics", "@base"])
    expect(screen.getByTestId("agent-sidebar-row-@admin").getAttribute("data-agent-mine")).toBe(
      "true",
    )
    expect(screen.getByTestId("agent-sidebar-row-@base").getAttribute("data-dimmed")).toBe("true")
    expect(
      screen.getByTestId("agent-sidebar-row-@logistics").getAttribute("data-dimmed"),
    ).toBeNull()
  })

  it("a sidebar row opens /agents/:handle", async () => {
    renderWithApi()
    fireEvent.click(await screen.findByTestId("agent-sidebar-row-@logistics"))
    const { tabStore } = await import("~/modules/shell/tab-store")
    expect(
      tabStore.tabs.some((t: any) => t.type === "agents:agent" && t.entityId === "@logistics"),
    ).toBe(true)
  })

  it("the Skills / Routines / Memory nav is gone", async () => {
    renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    expect(screen.queryByTestId("agent-sidebar-nav-skills")).toBeNull()
    expect(screen.queryByTestId("agent-sidebar-nav-routines")).toBeNull()
    expect(screen.queryByTestId("agent-sidebar-nav-memory")).toBeNull()
  })

  it("the agent sidebar lists no chats and costs one request on mount", async () => {
    const api = renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    expect(screen.queryByTestId("agent-sidebar-chat-list")).toBeNull()
    expect(screen.queryByTestId("agent-sidebar-new-chat")).toBeNull()
    // The box is there, but an untouched box asks nothing: the only fetch on
    // mount is the org's agent listing.
    expect(screen.getByTestId("agent-sidebar-search")).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith("/agents")
  })

  it("the search box searches across agents, skills, routines and memory", async () => {
    const api = renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")

    fireEvent.input(screen.getByTestId("agent-sidebar-search"), { target: { value: "refund" } })

    await waitFor(() => expect(screen.getByTestId("agent-sidebar-results")).toBeInTheDocument())
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/agents/search?q=refund"))
    // Grouped by kind, each group present only when it has hits.
    for (const kind of ["agents", "skills", "routines", "memories"]) {
      expect(screen.getByTestId(`agent-sidebar-result-group-${kind}`)).toBeInTheDocument()
    }
    // The roster is replaced by the results while a query is live, so the
    // sidebar never shows the same agents twice.
    expect(screen.queryByTestId("agent-sidebar-row-@base")).toBeNull()
  })

  it("a skill hit opens its OWN agent's Skills tab with the skill selected", async () => {
    renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    fireEvent.input(screen.getByTestId("agent-sidebar-search"), { target: { value: "refund" } })

    const hit = await screen.findByTestId("agent-sidebar-hit-skills-sk-1")
    fireEvent.click(hit)

    const { tabStore } = await import("~/modules/shell/tab-store")
    const tab = tabStore.tabs.find((t: any) => t.type === "agents:agent")
    expect(tab?.entityId).toBe("@logistics")
    expect(tab?.routePath).toBe("/agents/@logistics/skills?selected=sk-1")
  })

  it("a memory hit opens the owning agent's Memory tab at that file", async () => {
    renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    fireEvent.input(screen.getByTestId("agent-sidebar-search"), { target: { value: "refund" } })

    fireEvent.click(
      await screen.findByTestId("agent-sidebar-hit-memories-reference/refund-rule.md"),
    )

    const { tabStore } = await import("~/modules/shell/tab-store")
    const tab = tabStore.tabs.find((t: any) => t.type === "agents:agent")
    expect(tab?.entityId).toBe("@admin")
    expect(tab?.routePath).toBe("/agents/@admin/memory?selected=reference%2Frefund-rule.md")
  })

  it("clearing the box puts the roster back", async () => {
    renderWithApi()
    await screen.findByTestId("agent-sidebar-row-@base")
    const box = screen.getByTestId("agent-sidebar-search")
    fireEvent.input(box, { target: { value: "refund" } })
    await screen.findByTestId("agent-sidebar-results")
    fireEvent.input(box, { target: { value: "" } })
    await waitFor(() => expect(screen.getByTestId("agent-sidebar-row-@base")).toBeInTheDocument())
  })

  it("a search the backend cannot answer leaves a working roster", async () => {
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/agents/search")) throw new Error("404")
        return AGENTS
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      rawPost: vi.fn(),
      rawGet: vi.fn(),
      getEnvelope: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <AgentSidebar />
      </ApiContext.Provider>
    ))
    await screen.findByTestId("agent-sidebar-row-@base")
    fireEvent.input(screen.getByTestId("agent-sidebar-search"), { target: { value: "refund" } })
    await waitFor(() =>
      expect(screen.getByTestId("agent-sidebar-search-empty")).toBeInTheDocument(),
    )
    fireEvent.input(screen.getByTestId("agent-sidebar-search"), { target: { value: "" } })
    await waitFor(() =>
      expect(screen.getByTestId("agent-sidebar-row-@logistics")).toBeInTheDocument(),
    )
  })
})
