// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import KnowledgeSidebar from "./KnowledgeSidebar"
import { resetKnowledgeStore } from "./knowledge-store"

afterEach(resetKnowledgeStore)

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe("KnowledgeSidebar — collection tree", () => {
  it("renders the collection tree, not a recent-docs list", async () => {
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/knowledge/collections/tree")
          return [
            {
              id: "c1",
              name: "Eng",
              parentId: null,
              children: [],
              documents: [{ id: "d1", title: "RFC-001" }],
            },
            {
              id: "__unfiled__",
              name: "Unfiled",
              parentId: null,
              virtual: true,
              children: [],
              documents: [{ id: "d2", title: "Loose note" }],
            },
          ]
        return []
      }),
      post: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(await screen.findByTestId("knowledge-tree-folder-c1")).toBeInTheDocument()
    expect(await screen.findByTestId("knowledge-tree-folder-__unfiled__")).toBeInTheDocument()
    // The sidebar exposes Personal + Shared section headers; the legacy
    // "recent-docs" surface is gone.
    expect(screen.getByText(/^personal$/i)).toBeInTheDocument()
    expect(screen.getByText(/^shared with org$/i)).toBeInTheDocument()
    expect(screen.queryByText(/recent docs/i)).not.toBeInTheDocument()
  })
})

describe("KnowledgeSidebar — consolidated search", () => {
  it("does not render the legacy `Search` nav row", () => {
    const api = { get: vi.fn(async () => []), post: vi.fn() }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(screen.queryByTestId("knowledge-nav-search")).not.toBeInTheDocument()
  })

  it("fires POST /knowledge/search after a debounce when the user types", async () => {
    const api = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({
        hits: [],
        sourceStatuses: [],
        cursors: {},
        duplicates: [],
        final: true,
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    const input = screen.getByTestId("knowledge-sidebar-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "deploy" } })
    await new Promise((r) => setTimeout(r, 250))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/search",
        expect.objectContaining({ query: "deploy" }),
      ),
    )
  })

  it("Enter triggers federated search immediately (no debounce)", async () => {
    const api = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({
        hits: [],
        sourceStatuses: [],
        cursors: {},
        duplicates: [],
        final: true,
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    const input = screen.getByTestId("knowledge-sidebar-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "deploy" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/search",
        expect.objectContaining({ query: "deploy" }),
      ),
    )
  })

  it("marks an externally-synced document hit with its source connector", async () => {
    const api = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({
        hits: [
          {
            source: "knowledge",
            sourceEntityId: "d1",
            title: "manual.md",
            type: "document",
            syncedSourceApp: "gitlab",
          },
          {
            source: "knowledge",
            sourceEntityId: "d2",
            title: "hand-written note",
            type: "document",
          },
        ],
        sourceStatuses: [],
        cursors: {},
        duplicates: [],
        final: true,
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    const input = screen.getByTestId("knowledge-sidebar-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "manual" } })
    fireEvent.keyDown(input, { key: "Enter" })
    // Synced doc carries a provenance chip naming the connector; the local doc does not.
    const chip = await screen.findByTestId("knowledge-search-result-synced-d1")
    expect(chip).toHaveTextContent("gitlab")
    expect(screen.queryByTestId("knowledge-search-result-synced-d2")).not.toBeInTheDocument()
  })
})

describe("KnowledgeSidebar — collapsed IA (no source-settings, conditional Unfiled)", () => {
  function basicApi() {
    return { get: vi.fn(async () => []), post: vi.fn() } as any
  }

  it("renders Personal + Shared sections — no Documents/Sources peers, no source-settings nav", () => {
    render(() => (
      <ApiContext.Provider value={basicApi() as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(screen.getByTestId("knowledge-sidebar-section-personal")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-sidebar-section-shared")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-sidebar-section-documents")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-sidebar-section-sources")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-nav-source-settings")).not.toBeInTheDocument()
  })

  it("Unfiled entry is hidden when unfiledCount = 0", async () => {
    const { loadKnowledgeHome } = await import("./knowledge-store")
    const api: any = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/home"
          ? {
              personal: [],
              recent: [],
              needsReview: [],
              sourceHealth: [],
              unfiledCount: 0,
            }
          : [],
      ),
      post: vi.fn(),
    }
    await loadKnowledgeHome(api)
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(screen.queryByTestId("knowledge-sidebar-unfiled")).not.toBeInTheDocument()
  })

  it("Unfiled entry shows the count when unfiledCount > 0", async () => {
    const { loadKnowledgeHome } = await import("./knowledge-store")
    const api: any = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/home"
          ? {
              personal: [],
              recent: [],
              needsReview: [],
              sourceHealth: [],
              unfiledCount: 3,
            }
          : [],
      ),
      post: vi.fn(),
    }
    await loadKnowledgeHome(api)
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(screen.getByTestId("knowledge-sidebar-unfiled")).toHaveTextContent("3")
  })
})

describe("KnowledgeSidebar — personal vs. org-shared folder creation", () => {
  afterEach(clearAuth)

  it("the Personal '+' button creates a folder owned by the current user", async () => {
    const jwt = makeJwt({
      userId: "user-1",
      orgId: "org-1",
      name: "Test User",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    const api = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({ id: "new-folder" })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    fireEvent.click(screen.getByTestId("knowledge-sidebar-personal-new-folder"))
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/collections",
        expect.objectContaining({ ownerUserId: "user-1", parentCollectionId: null }),
      ),
    )
  })

  it("the Shared-with-org '+' button creates a folder with ownerUserId: null", async () => {
    const jwt = makeJwt({
      userId: "user-1",
      orgId: "org-1",
      name: "Test User",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    const api = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({ id: "new-folder" })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(screen.getByTestId("knowledge-sidebar-shared-new-folder")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("knowledge-sidebar-shared-new-folder"))
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/collections",
        expect.objectContaining({ ownerUserId: null, parentCollectionId: null }),
      ),
    )
  })
})
