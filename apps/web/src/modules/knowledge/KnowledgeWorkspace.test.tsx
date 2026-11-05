// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import KnowledgeWorkspace from "./KnowledgeWorkspace"
import { resetKnowledgeStore, setKnowledgeView } from "./knowledge-store"

function renderWorkspace(api: unknown) {
  return render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeWorkspace />
    </ApiContext.Provider>
  ))
}

describe("Knowledge workspace", () => {
  it("renders empty home with the calm primary CTA, no persistent inspector", async () => {
    resetKnowledgeStore()
    const api = {
      get: vi.fn(async () => ({ personal: [], recent: [], needsReview: [], sourceHealth: [] })),
      post: vi.fn(),
    }
    renderWorkspace(api)
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-home-create-from-cta")).toBeInTheDocument(),
    )
    // Deprecated surfaces are gone.
    expect(screen.queryByText("New personal note")).not.toBeInTheDocument()
    expect(screen.queryByText("Connect Drive")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-inspector-pane")).toBeNull()
  })

  it("MF-4: home loads exactly once on mount", async () => {
    resetKnowledgeStore()
    const api = {
      get: vi.fn(async () => ({ personal: [], recent: [], needsReview: [], sourceHealth: [] })),
      post: vi.fn(),
    }
    renderWorkspace(api)
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-home-create-from-cta")).toBeInTheDocument(),
    )
    const homeCalls = (api.get.mock.calls as unknown[][]).filter((c) => c[0] === "/knowledge/home")
    expect(homeCalls).toHaveLength(1)
  })

  it("shows blended search results with per-source partial status", async () => {
    resetKnowledgeStore()
    const api = {
      get: vi.fn(async () => ({ personal: [], recent: [], needsReview: [], sourceHealth: [] })),
      post: vi.fn(async () => ({
        hits: [
          {
            source: "knowledge",
            sourceEntityId: "d1",
            title: "Local Policy",
            type: "local_document",
            badges: ["local", "verified"],
            snippet: "local",
          },
          {
            source: "google-drive",
            sourceEntityId: "g1",
            title: "Drive Policy",
            type: "file",
            badges: ["remote"],
            snippet: "drive",
            canFetchContent: true,
          },
        ],
        sourceStatuses: [
          { source: "knowledge", state: "complete", retryable: false },
          {
            source: "google-drive",
            state: "partial",
            message: "Drive returned incomplete results",
            retryable: true,
          },
        ],
        final: true,
      })),
    }
    renderWorkspace(api)
    setKnowledgeView("search")
    fireEvent.input(await screen.findByPlaceholderText("Search Knowledge and sources"), {
      target: { value: "policy" },
    })
    await waitFor(() => expect(screen.getByText("Local Policy")).toBeInTheDocument())
    expect(screen.getByText("Drive Policy")).toBeInTheDocument()
    expect(screen.getByText(/incomplete results/i)).toBeInTheDocument()
    resetKnowledgeStore()
  })
})
