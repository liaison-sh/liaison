// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setAttentionApi } from "~/modules/shell/attention-store"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { handleKnowledgeCollectionWsEvent, handleKnowledgeDocumentWsEvent } from "./exports"
import KnowledgeSidebar from "./KnowledgeSidebar"
import KnowledgeWorkspace from "./KnowledgeWorkspace"
import {
  knowledgeStore,
  loadKnowledgeHome,
  resetKnowledgeStore,
  TREE_RELOAD_DEBOUNCE_MS,
} from "./knowledge-store"

afterEach(resetKnowledgeStore)

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

/** The tree's Unfiled bucket holding `count` pages. */
function unfiledNode(count: number) {
  return {
    id: "__unfiled__",
    kind: "unfiled",
    name: "Unfiled",
    parentId: null,
    ownerUserId: null,
    virtual: true,
    children: [],
    documents: Array.from({ length: count }, (_, i) => ({ id: `u${i}`, title: `Loose ${i}` })),
  }
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

  it("Unfiled entry shows the count of the tree's Unfiled pages", async () => {
    const api: any = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree" ? [unfiledNode(3)] : [],
      ),
      post: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    expect(await screen.findByTestId("knowledge-sidebar-unfiled")).toHaveTextContent("3")
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
      scopes: ["knowledge:collections:manage"],
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
      scopes: ["knowledge:collections:manage"],
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

describe("KnowledgeSidebar — organise (K1)", () => {
  afterEach(() => {
    clearAuth()
    resetToastStore()
    setAttentionApi(null)
    resetTabStore()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function signIn() {
    setTokens(
      makeJwt({
        userId: "me",
        orgId: "org-1",
        name: "Me",
        roles: [],
        scopes: ["*"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
  }

  function renderSidebar(api: unknown, locale: "en" | "fr" = "en") {
    return render(() => (
      <I18nProvider initialLocale={locale}>
        <ApiContext.Provider value={api as never}>
          <KnowledgeSidebar />
        </ApiContext.Provider>
      </I18nProvider>
    ))
  }

  it("no console.error path: every rejected call renders a toast", async () => {
    signIn()
    const errors = vi.spyOn(console, "error")
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "c1",
                name: "Policies",
                parentId: null,
                ownerUserId: null,
                children: [],
                documents: [{ id: "d1", title: "Warranty" }],
              },
            ]
          : [],
      ),
      post: vi.fn(async () => {
        throw new ApiError("Refused by the server", 403, "FORBIDDEN")
      }),
      patch: vi.fn(async () => {
        throw new ApiError("Refused by the server", 403, "FORBIDDEN")
      }),
    }
    renderSidebar(api)
    // New folder.
    fireEvent.click(screen.getByTestId("knowledge-sidebar-shared-new-folder"))
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() => expect(toasts()).toHaveLength(1))
    // New page in a folder.
    fireEvent.click(await screen.findByTestId("knowledge-tree-new-page-c1"))
    await waitFor(() => expect(toasts()).toHaveLength(2))
    // Rename and delete a folder.
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-folder-c1"))
    const rename = await screen.findByTestId("knowledge-tree-menu-rename")
    rename.focus()
    fireEvent.keyDown(rename, { key: "Enter" })
    fireEvent.input(await screen.findByTestId("knowledge-folder-name-input"), {
      target: { value: "Rules" },
    })
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() => expect(toasts()).toHaveLength(3))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-folder-c1"))
    const del = await screen.findByTestId("knowledge-tree-menu-delete")
    del.focus()
    fireEvent.keyDown(del, { key: "Enter" })
    fireEvent.click(await screen.findByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() => expect(toasts().length).toBeGreaterThanOrEqual(3))
    // A known refusal (403) is said in the client's own words, never the server's.
    expect(toasts().every((t) => t.type === "error")).toBe(true)
    expect(toasts().map((t) => t.message)).toContain("The folder could not be changed.")
    expect(toasts().map((t) => t.message)).toContain("The page could not be created.")
    expect(toasts().some((t) => t.message === "Refused by the server")).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it("M3: a reader without the folder or page rights is offered neither", async () => {
    setTokens(
      makeJwt({
        userId: "me",
        orgId: "org-1",
        name: "Me",
        roles: [],
        scopes: ["knowledge:documents:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "c1",
                name: "Policies",
                parentId: null,
                ownerUserId: null,
                children: [],
                documents: [{ id: "d1", title: "Warranty", canEdit: false }],
              },
            ]
          : [],
      ),
      post: vi.fn(),
    }
    renderSidebar(api)
    expect(await screen.findByTestId("knowledge-tree-folder-c1")).toBeInTheDocument()
    for (const id of [
      "knowledge-sidebar-personal-new-folder",
      "knowledge-sidebar-shared-new-folder",
      "knowledge-sidebar-new-page",
      "knowledge-tree-new-page-c1",
      "knowledge-tree-menu-c1",
    ])
      expect(screen.queryByTestId(id)).toBeNull()
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    expect(await screen.findByTestId("knowledge-tree-menu-copy-link")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-tree-menu-rename")).toBeNull()
    expect(screen.queryByTestId("knowledge-tree-menu-move")).toBeNull()
  })

  it("M2: French readers see French refusals; an unknown refusal keeps the server's words", async () => {
    signIn()
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "c1",
                name: "Politiques",
                parentId: null,
                ownerUserId: null,
                children: [],
                documents: [{ id: "d1", title: "Garantie", canEdit: true }],
              },
              {
                id: "c2",
                name: "Manuel",
                parentId: null,
                ownerUserId: null,
                children: [],
                documents: [],
              },
            ]
          : [],
      ),
      post: vi.fn(async (path: string) => {
        if (path === "/knowledge/documents/d1/move")
          throw new ApiError("You cannot do this on this page", 404, "NOT_FOUND")
        if (path === "/knowledge/collections")
          throw new ApiError("Something new went wrong", 422, "SOMETHING_NEW")
        return {}
      }),
      patch: vi.fn(async () => {
        throw new ApiError(
          "This folder is synced from another app. Change it there, or stop the sync first.",
          400,
          "VALIDATION",
          undefined,
          { reason: "synced_folder" },
        )
      }),
    }
    renderSidebar(api, "fr")
    // A refused move (the page's 404): the client's sentence, in French.
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-c1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    const move = await screen.findByTestId("knowledge-tree-menu-move")
    move.focus()
    fireEvent.keyDown(move, { key: "Enter" })
    fireEvent.click(await screen.findByTestId("knowledge-move-to-c2"))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain(
        "Vous ne pouvez pas faire cela sur cette page.",
      ),
    )
    // A named refusal (a synced folder): its French sentence.
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-folder-c2"))
    const rename = await screen.findByTestId("knowledge-tree-menu-rename")
    rename.focus()
    fireEvent.keyDown(rename, { key: "Enter" })
    fireEvent.input(await screen.findByTestId("knowledge-folder-name-input"), {
      target: { value: "Guide" },
    })
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain(
        "Ce dossier est synchronisé depuis une autre application. Modifiez-le là-bas, ou arrêtez d'abord la synchronisation.",
      ),
    )
    // A refusal the client does not know: the server's words, the only ones there are.
    fireEvent.click(screen.getByTestId("knowledge-sidebar-shared-new-folder"))
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain("Something new went wrong"),
    )
    expect(toasts().some((t) => /cannot do this|synced from another app/.test(t.message))).toBe(
      false,
    )
  })

  it("B5: rename and archive of the open page update its row; a collection or membership frame reloads the tree once for a burst", async () => {
    signIn()
    let title = "Untitled"
    let filed = true
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/knowledge/collections/tree")
          return [
            {
              id: "c1",
              name: "Policies",
              parentId: null,
              ownerUserId: null,
              children: [],
              documents: filed ? [{ id: "d1", title }] : [],
            },
          ]
        if (path === "/knowledge/documents/d1") return { id: "d1", title, body: "", revision: 2 }
        return []
      }),
      post: vi.fn(),
    }
    setAttentionApi(api as never)
    renderSidebar(api)
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-c1"))
    expect(screen.getByTestId("knowledge-tree-doc-d1")).toHaveTextContent("Untitled")

    vi.useFakeTimers({ shouldAdvanceTime: true })
    // The page's own update frame (this reader renamed it in its tab).
    title = "Warranty policy"
    await handleKnowledgeDocumentWsEvent("update", { entityId: "d1" })
    await vi.advanceTimersByTimeAsync(TREE_RELOAD_DEBOUNCE_MS + 10)
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-tree-doc-d1")).toHaveTextContent("Warranty policy"),
    )
    // Archived: its row leaves the tree.
    filed = false
    await handleKnowledgeDocumentWsEvent("archive", { entityId: "d1" })
    await vi.advanceTimersByTimeAsync(TREE_RELOAD_DEBOUNCE_MS + 10)
    await waitFor(() => expect(screen.queryByTestId("knowledge-tree-doc-d1")).toBeNull())

    // A burst of folder and membership frames: one reload.
    const treeLoads = () =>
      api.get.mock.calls.filter(([p]) => p === "/knowledge/collections/tree").length
    const before = treeLoads()
    handleKnowledgeCollectionWsEvent("create", { id: "c2" })
    handleKnowledgeCollectionWsEvent("update", { id: "c2" })
    handleKnowledgeCollectionWsEvent("create", { collectionId: "c2" })
    handleKnowledgeCollectionWsEvent("delete", { collectionId: "c1" })
    await vi.advanceTimersByTimeAsync(TREE_RELOAD_DEBOUNCE_MS + 10)
    expect(treeLoads()).toBe(before + 1)
  })

  it("B6: Unfiled toggles off, Home returns from Unfiled and Search, from a page tab the click shows the list", async () => {
    signIn()
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/knowledge/home")
          return { recent: [], needsReview: [], unfiled: [], unfiledCount: 2 }
        if (path === "/knowledge/collections/tree") return [unfiledNode(2)]
        return []
      }),
      post: vi.fn(async () => ({ hits: [], sourceStatuses: [], final: true })),
    }
    await loadKnowledgeHome(api as never)
    openTab({ type: "knowledge:document", entityId: "d9", label: "A page" })
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
        <KnowledgeWorkspace />
      </ApiContext.Provider>
    ))
    // From a page tab: the click brings the list forward.
    fireEvent.click(await screen.findByTestId("knowledge-sidebar-unfiled"))
    const active = () => tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    expect(active()?.type).toBe("knowledge:home")
    expect(knowledgeStore.view).toBe("unfiled")
    expect(screen.getByTestId("knowledge-sidebar-unfiled")).toHaveAttribute("aria-current", "page")
    // A second click goes back to Home.
    fireEvent.click(screen.getByTestId("knowledge-sidebar-unfiled"))
    expect(knowledgeStore.view).toBe("home")
    // Home returns from Unfiled.
    fireEvent.click(screen.getByTestId("knowledge-sidebar-unfiled"))
    fireEvent.click(await screen.findByTestId("knowledge-view-home"))
    expect(knowledgeStore.view).toBe("home")
    // Search opens from the sidebar (Enter) and Home returns from it.
    const input = screen.getByTestId("knowledge-sidebar-search-input")
    fireEvent.input(input, { target: { value: "warranty" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(knowledgeStore.view).toBe("search"))
    fireEvent.click(await screen.findByTestId("knowledge-view-home"))
    expect(knowledgeStore.view).toBe("home")
  })

  it("B12: no hardcoded English (virtual nodes, New folder)", async () => {
    signIn()
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "__personal_notes__",
                kind: "personal_notes",
                name: "Personal notes",
                parentId: null,
                ownerUserId: "me",
                virtual: true,
                children: [],
                documents: [{ id: "d1", title: "Mine" }],
              },
              {
                id: "__unfiled__",
                kind: "unfiled",
                name: "Unfiled",
                parentId: null,
                ownerUserId: null,
                virtual: true,
                children: [],
                documents: [{ id: "d2", title: "Loose" }],
              },
            ]
          : [],
      ),
      post: vi.fn(),
    }
    renderSidebar(api, "fr")
    expect(await screen.findByTestId("knowledge-tree-folder-__personal_notes__")).toHaveTextContent(
      "Notes personnelles",
    )
    expect(screen.getByTestId("knowledge-tree-folder-__unfiled__")).toHaveTextContent("Non classés")
    fireEvent.click(screen.getByTestId("knowledge-sidebar-shared-new-folder"))
    expect((screen.getByTestId("knowledge-folder-name-input") as HTMLInputElement).value).toBe(
      "Nouveau dossier",
    )
  })

  // ---- Moving across sections (edges 10 and 11), open folders ----------

  /** Ana's personal folder holding a page, and a shared folder. */
  function crossTree() {
    return [
      {
        id: "p1",
        name: "Mine",
        parentId: null,
        ownerUserId: "me",
        children: [],
        documents: [{ id: "d1", title: "Draft", canEdit: true }],
      },
      {
        id: "s1",
        name: "Policies",
        parentId: null,
        ownerUserId: null,
        children: [],
        documents: [],
      },
    ]
  }

  function moveApi() {
    return {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree" ? crossTree() : [],
      ),
      post: vi.fn(async () => ({ id: "d1" })),
      patch: vi.fn(async () => ({ id: "p1" })),
    }
  }

  async function chooseItem(testid: string) {
    const item = await screen.findByTestId(testid)
    item.focus()
    fireEvent.keyDown(item, { key: "Enter" })
  }

  it("edge 10: Move to a Shared folder asks and says the page keeps its sharing; Back returns; Move sends one request", async () => {
    signIn()
    const api = moveApi()
    renderSidebar(api)
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-p1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    await chooseItem("knowledge-tree-menu-move")
    fireEvent.click(await screen.findByTestId("knowledge-move-to-s1"))
    expect(await screen.findByTestId("knowledge-move-audience")).toHaveTextContent(
      "A folder does not change who sees a page",
    )
    expect(api.post).not.toHaveBeenCalled()
    // Back: the list again, nothing sent.
    fireEvent.click(screen.getByTestId("knowledge-move-back"))
    expect(await screen.findByTestId("knowledge-move-search")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-move-audience")).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
    // Within the section: no question. Across: asked, then one request.
    fireEvent.click(screen.getByTestId("knowledge-move-to-s1"))
    fireEvent.click(await screen.findByTestId("knowledge-move-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/d1/move", {
        fromCollectionId: "p1",
        toCollectionId: "s1",
      }),
    )
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("edge 11: a personal folder moved to Shared's top level asks who will see it, then is shared", async () => {
    signIn()
    const api = moveApi()
    renderSidebar(api)
    fireEvent.contextMenu(await screen.findByTestId("knowledge-tree-folder-p1"))
    await chooseItem("knowledge-tree-menu-move")
    fireEvent.click(await screen.findByTestId("knowledge-move-to-shared-root"))
    expect(await screen.findByTestId("knowledge-move-audience")).toHaveTextContent(
      "Everyone in the organization will see this folder",
    )
    expect(api.patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("knowledge-move-confirm"))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/knowledge/collections/p1", {
        parentCollectionId: null,
        ownerUserId: null,
      }),
    )
  })

  it("edges 10 and 11 by drag: crossing sections asks first, within a section it does not", async () => {
    signIn()
    const api = moveApi()
    renderSidebar(api)
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-p1"))
    // A page dragged from Personal onto a Shared folder: asked, nothing sent.
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-doc-d1"))
    fireEvent.dragOver(screen.getByTestId("knowledge-tree-row-s1"))
    fireEvent.drop(screen.getByTestId("knowledge-tree-row-s1"))
    expect(await screen.findByTestId("knowledge-move-audience")).toHaveTextContent(
      "A folder does not change who sees a page",
    )
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/d1/move", {
        fromCollectionId: "p1",
        toCollectionId: "s1",
      }),
    )
    await waitFor(() => expect(screen.queryByTestId("knowledge-move-audience")).toBeNull())
    // The personal folder dropped on Shared's top level: asked, then shared.
    const sharedRoot = screen
      .getByTestId("knowledge-sidebar-section-shared")
      .querySelector('[data-testid="knowledge-tree-root"]') as HTMLElement
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-row-p1"))
    fireEvent.dragOver(sharedRoot)
    fireEvent.drop(sharedRoot)
    expect(await screen.findByTestId("knowledge-move-audience")).toHaveTextContent(
      "Everyone in the organization will see this folder",
    )
    expect(api.patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/knowledge/collections/p1", {
        parentCollectionId: null,
        ownerUserId: null,
      }),
    )
    await waitFor(() => expect(screen.queryByTestId("knowledge-move-audience")).toBeNull())
    // Within Personal: straight through, no question.
    const personalRoot = screen
      .getByTestId("knowledge-sidebar-section-personal")
      .querySelector('[data-testid="knowledge-tree-root"]') as HTMLElement
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-doc-d1"))
    fireEvent.drop(personalRoot)
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/d1/move", {
        fromCollectionId: "p1",
        toCollectionId: null,
      }),
    )
    expect(screen.queryByTestId("knowledge-move-audience")).toBeNull()
  })

  it("opening a page in a closed nested folder opens its folders, and marks its row", async () => {
    signIn()
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "c1",
                name: "Eng",
                parentId: null,
                ownerUserId: null,
                documents: [],
                children: [
                  {
                    id: "c2",
                    name: "RFCs",
                    parentId: "c1",
                    ownerUserId: null,
                    children: [],
                    documents: [{ id: "d1", title: "RFC-001", canEdit: true }],
                  },
                ],
              },
            ]
          : [],
      ),
      post: vi.fn(),
    }
    renderSidebar(api)
    expect(await screen.findByTestId("knowledge-tree-folder-c1")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-tree-doc-d1")).toBeNull()
    openTab({ type: "knowledge:document", entityId: "d1", label: "RFC-001" })
    expect(await screen.findByTestId("knowledge-tree-doc-d1")).toHaveAttribute(
      "aria-current",
      "page",
    )
    expect(screen.getByTestId("knowledge-tree-toggle-c1")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("knowledge-tree-toggle-c2")).toHaveAttribute("aria-expanded", "true")
    localStorage.clear()
  })

  it("open folders survive a remount for the same person, not for another", async () => {
    localStorage.clear()
    signIn()
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "c1",
                name: "Eng",
                parentId: null,
                ownerUserId: null,
                children: [],
                documents: [{ id: "d1", title: "RFC-001", canEdit: true }],
              },
            ]
          : [],
      ),
      post: vi.fn(),
    }
    try {
      const first = renderSidebar(api)
      fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-c1"))
      expect(screen.getByTestId("knowledge-tree-doc-d1")).toBeInTheDocument()
      first.unmount()
      resetKnowledgeStore()
      // The same person, a new page load: still open.
      const again = renderSidebar(api)
      expect(await screen.findByTestId("knowledge-tree-doc-d1")).toBeInTheDocument()
      again.unmount()
      resetKnowledgeStore()
      // Someone else in this browser: their own, closed.
      setTokens(
        makeJwt({
          userId: "other",
          orgId: "org-1",
          name: "Other",
          roles: [],
          scopes: ["*"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      )
      renderSidebar(api)
      expect(await screen.findByTestId("knowledge-tree-folder-c1")).toBeInTheDocument()
      expect(screen.queryByTestId("knowledge-tree-doc-d1")).toBeNull()
    } finally {
      localStorage.clear()
    }
  })

  it("L1: the bottom Unfiled count is the tree's, and follows it", async () => {
    signIn()
    let unfiled = [
      { id: "u1", title: "Loose", canEdit: true },
      { id: "u2", title: "Looser", canEdit: true },
    ]
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/knowledge/collections/tree")
          return unfiled.length
            ? [
                {
                  id: "__unfiled__",
                  kind: "unfiled",
                  name: "Unfiled",
                  parentId: null,
                  ownerUserId: null,
                  virtual: true,
                  children: [],
                  documents: unfiled,
                },
              ]
            : []
        return []
      }),
      post: vi.fn(),
    }
    setAttentionApi(api as never)
    renderSidebar(api)
    // Home never shown: the count is there all the same, the tree's own.
    expect(await screen.findByTestId("knowledge-sidebar-unfiled")).toHaveTextContent("2")
    vi.useFakeTimers({ shouldAdvanceTime: true })
    unfiled = [...unfiled, { id: "u3", title: "Loosest", canEdit: true }]
    handleKnowledgeCollectionWsEvent("delete", { id: "c9" })
    await vi.advanceTimersByTimeAsync(TREE_RELOAD_DEBOUNCE_MS + 10)
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-sidebar-unfiled")).toHaveTextContent("3"),
    )
    unfiled = []
    handleKnowledgeCollectionWsEvent("create", { id: "c9" })
    await vi.advanceTimersByTimeAsync(TREE_RELOAD_DEBOUNCE_MS + 10)
    await waitFor(() => expect(screen.queryByTestId("knowledge-sidebar-unfiled")).toBeNull())
  })

  it("L4: a page in Personal notes is not offered Unfiled, where moving would do nothing", async () => {
    signIn()
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/collections/tree"
          ? [
              {
                id: "__personal_notes__",
                kind: "personal_notes",
                name: "Personal notes",
                parentId: null,
                ownerUserId: "me",
                virtual: true,
                children: [],
                documents: [{ id: "d1", title: "Mine", canEdit: true }],
              },
              ...crossTree().slice(1),
            ]
          : [],
      ),
      post: vi.fn(),
    }
    renderSidebar(api)
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-__personal_notes__"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    await chooseItem("knowledge-tree-menu-move")
    expect(await screen.findByTestId("knowledge-move-to-s1")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-move-to-root")).toBeNull()
  })

  it("L6: an empty name keeps the dialog open and sends nothing", async () => {
    signIn()
    const api = { get: vi.fn(async () => []), post: vi.fn(async () => ({ id: "x" })) }
    renderSidebar(api)
    fireEvent.click(screen.getByTestId("knowledge-sidebar-shared-new-folder"))
    fireEvent.input(screen.getByTestId("knowledge-folder-name-input"), {
      target: { value: "   " },
    })
    fireEvent.click(screen.getByTestId("knowledge-folder-dialog-confirm"))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId("knowledge-folder-name-input")).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})
