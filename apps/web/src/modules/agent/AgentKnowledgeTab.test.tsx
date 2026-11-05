// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import AgentKnowledgeTab from "./AgentKnowledgeTab"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: vi.fn(() => "tab-id"),
}))

afterEach(() => {
  vi.mocked(openTab).mockClear()
})

function setup(rows: any) {
  const api = {
    get: vi.fn(async () => rows),
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
      <AgentKnowledgeTab agentId="agent-1" />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentKnowledgeTab", () => {
  it("the Knowledge tab lists pointers with collection names", async () => {
    const api = setup([
      {
        id: "ptr-1",
        collectionId: "col-1",
        collectionName: "Support Playbooks",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ptr-2",
        collectionId: "col-2",
        collectionName: "Product Facts",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ])

    await waitFor(() => expect(screen.getByTestId("agent-knowledge-row-col-1")).toBeInTheDocument())
    expect(api.get).toHaveBeenCalledWith("/agents/agent-1/knowledge")
    expect(screen.getByTestId("agent-knowledge-row-col-1").textContent).toContain(
      "Support Playbooks",
    )
    expect(screen.getByTestId("agent-knowledge-row-col-2").textContent).toContain("Product Facts")

    // The collection's home is Knowledge, not a second copy of it here.
    fireEvent.click(screen.getByTestId("agent-knowledge-open-col-1"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "knowledge:home", entityId: "knowledge-home" }),
    )
  })

  it("renders an empty state when the agent reads no collection", async () => {
    setup([])
    await waitFor(() => expect(screen.getByTestId("agent-knowledge-empty")).toBeInTheDocument())
  })
})

// A screenshot pass found every pointer row carrying only a name, so the rows
// were indistinguishable and said nothing about what the agent reads.
describe("AgentKnowledgeTab: a pointer row says how much and how fresh", () => {
  it("shows the document count and the last update beside the name", async () => {
    setup([
      {
        id: "ptr-1",
        collectionId: "col-1",
        collectionName: "Support Playbooks",
        documentCount: 12,
        lastUpdatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ptr-2",
        collectionId: "col-2",
        collectionName: "Product Facts",
        documentCount: 1,
        lastUpdatedAt: null,
        createdAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "ptr-3",
        collectionId: "col-3",
        collectionName: "Empty shelf",
        documentCount: 0,
        lastUpdatedAt: null,
        createdAt: "2026-01-03T00:00:00Z",
      },
    ])
    await waitFor(() =>
      expect(screen.getByTestId("agent-knowledge-meta-col-1")).toBeInTheDocument(),
    )
    const many = screen.getByTestId("agent-knowledge-meta-col-1").textContent ?? ""
    expect(many).toContain("12 documents")
    expect(many).toContain("updated")
    // Singular is written out: there is no plural engine in the catalog.
    expect(screen.getByTestId("agent-knowledge-meta-col-2")).toHaveTextContent("1 document")
    expect(screen.getByTestId("agent-knowledge-meta-col-2").textContent).not.toContain("updated")
    expect(screen.getByTestId("agent-knowledge-meta-col-3")).toHaveTextContent("No documents yet")
  })

  it("draws no meta line at all when the backend sends no count", async () => {
    setup([{ id: "ptr-1", collectionId: "col-1", collectionName: "Support Playbooks" }])
    await waitFor(() => expect(screen.getByTestId("agent-knowledge-row-col-1")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-knowledge-meta-col-1")).toBeNull()
  })
})
