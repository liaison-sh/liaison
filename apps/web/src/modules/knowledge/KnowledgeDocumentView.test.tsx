// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { editorOf, setMarkdown } from "~/modules/editor/test-helpers"
import { ApiContext } from "~/modules/shell/ApiContext"
import KnowledgeDocumentView from "./KnowledgeDocumentView"
import { resetKnowledgeStore } from "./knowledge-store"

// The viewer's scopes: the attachments section follows knowledge:attachments:download.
const scopes = vi.hoisted(() => new Set(["knowledge:attachments:download"]))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scopes.has(scope),
}))

interface ApiStub {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  getEnvelope: ReturnType<typeof vi.fn>
}

function makeApi(doc: Record<string, unknown> = {}): ApiStub {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.endsWith("/sharing")) return { orgAccess: "none", shares: [] }
      if (path === "/knowledge/members") return []
      // The share dialog also lists roles; an unrouted path would fall through
      // to the document payload, which is not iterable.
      if (path === "/knowledge/roles") return []
      return {
        id: "doc1",
        title: "Hello",
        body: "# H1",
        revision: 1,
        reviewStatus: "verified",
        documentScope: "personal",
        ownerUserId: "alice",
        status: "active",
        canEdit: true,
        ...doc,
      }
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ revision: 2 })),
    put: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  }
}

function renderView(api: ApiStub, entityId = "doc1") {
  return render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeDocumentView entityId={entityId} />
    </ApiContext.Provider>
  ))
}

afterEach(() => {
  resetKnowledgeStore()
  scopes.add("knowledge:attachments:download")
})

describe("KnowledgeDocumentView", () => {
  it("renders the body as parsed markdown by default (read mode)", async () => {
    const api = makeApi()
    renderView(api)
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    // Markdown `# H1` should become an actual <h1> in the DOM, not raw text.
    expect(rendered.querySelector("h1")?.textContent?.trim()).toBe("H1")
    expect(rendered.innerHTML).not.toContain("# H1")
    expect((await screen.findByTestId("knowledge-doc-title")).textContent).toBe("Hello")
    // The contenteditable raw-source editor is hidden until Edit is clicked.
    expect(screen.queryByTestId("knowledge-doc-body-editor")).not.toBeInTheDocument()
  })

  it("offers Edit, and an editable title, only to whoever the server says may edit", async () => {
    renderView(makeApi({ canEdit: false }))
    await screen.findByTestId("knowledge-doc-body-rendered")
    expect(screen.queryByTestId("knowledge-doc-edit")).toBeNull()
    expect(screen.getByTestId("knowledge-doc-title").getAttribute("contenteditable")).toBe("false")
  })

  it("at phone width an editable document still offers Edit (the tour's edit step needs it)", async () => {
    const { DESKTOP_QUERY, PHONE_QUERY, syncShellTier } = await import("~/modules/shell/shell-tier")
    const tier = (answer: string) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === answer,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }))
      syncShellTier()
    }
    tier(PHONE_QUERY)
    try {
      renderView(makeApi())
      fireEvent.click(await screen.findByTestId("knowledge-doc-edit"))
      expect(await screen.findByTestId("knowledge-doc-body-editor")).toBeInTheDocument()
    } finally {
      tier(DESKTOP_QUERY)
      vi.unstubAllGlobals()
    }
  })

  it("Edit opens the document editor on the formatted text, not its markdown", async () => {
    renderView(makeApi())
    fireEvent.click(await screen.findByTestId("knowledge-doc-edit"))
    const field = await screen.findByTestId("knowledge-doc-body-editor")
    expect(field.querySelector("h1")?.textContent).toBe("H1")
    expect(field.textContent).not.toContain("#")
    expect(screen.getByTestId("rich-editor.tool-table")).toBeInTheDocument()
  })

  it("saving an unedited document sends nothing", async () => {
    const api = makeApi()
    renderView(api)
    fireEvent.click(await screen.findByTestId("knowledge-doc-edit"))
    await screen.findByTestId("knowledge-doc-body-editor")
    fireEvent.click(screen.getByTestId("knowledge-doc-save"))
    await screen.findByTestId("knowledge-doc-body-rendered")
    expect(api.patch).not.toHaveBeenCalled()
  })

  it("saves the edit as markdown at the revision it was opened at, shown at once", async () => {
    const api = makeApi()
    let answer!: () => void
    api.patch.mockImplementation(() => new Promise((resolve) => (answer = () => resolve({}))))
    renderView(api)
    fireEvent.click(await screen.findByTestId("knowledge-doc-edit"))
    setMarkdown(await screen.findByTestId("knowledge-doc-body-editor"), "# H1\n\nLe **taux**")
    fireEvent.click(screen.getByTestId("knowledge-doc-save"))
    expect(api.patch).toHaveBeenCalledWith("/knowledge/documents/doc1", {
      body: "# H1\n\nLe **taux**",
      revision: 1,
    })
    // Before the server answers, the reader already sees the saved text.
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    expect(rendered.querySelector("strong")?.textContent).toBe("taux")
    answer()
    await waitFor(() => expect(screen.queryByTestId("knowledge-doc-saving")).toBeNull())
  })

  it("a save refused for a newer revision keeps the edit and says so", async () => {
    const api = makeApi()
    api.patch.mockRejectedValue(new ApiError("Revision conflict", 409, "REVISION_CONFLICT"))
    renderView(api)
    fireEvent.click(await screen.findByTestId("knowledge-doc-edit"))
    setMarkdown(await screen.findByTestId("knowledge-doc-body-editor"), "Ma version")
    fireEvent.click(screen.getByTestId("knowledge-doc-save"))
    const banner = await screen.findByTestId("knowledge-doc-conflict-banner")
    // Above the scrolling text, not at its top: Save is pressed scrolled down.
    expect(screen.getByTestId("knowledge-doc-body").contains(banner)).toBe(false)
    const field = await screen.findByTestId("knowledge-doc-body-editor")
    expect(editorOf(field).getText()).toBe("Ma version")
    expect(screen.getByTestId("knowledge-doc-save")).toBeDisabled()

    const reads = api.get.mock.calls.filter(([path]) => path === "/knowledge/documents/doc1").length
    fireEvent.click(screen.getByTestId("knowledge-doc-load-latest"))
    await screen.findByTestId("knowledge-doc-body-rendered")
    expect(
      api.get.mock.calls.filter(([path]) => path === "/knowledge/documents/doc1").length,
    ).toBeGreaterThan(reads)
  })

  it("renders attachment list with parentApp=knowledge (MF-6)", async () => {
    const api = makeApi()
    // FileList calls api.get('/files') — return an empty list.
    api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.startsWith("/files")) return []
      return {
        id: "doc1",
        title: "Hello",
        body: "",
        revision: 1,
        documentScope: "personal",
        status: "active",
      }
    })
    renderView(api)
    expect(await screen.findByTestId("knowledge-attachment-list")).toBeInTheDocument()
  })

  it("a viewer without the attachments scope gets no section and asks for no files", async () => {
    scopes.delete("knowledge:attachments:download")
    const api = makeApi()
    renderView(api)
    await screen.findByText("Hello")
    expect(screen.queryByTestId("knowledge-attachment-list")).toBeNull()
    expect(api.getEnvelope.mock.calls.some(([path]) => String(path).startsWith("/files"))).toBe(
      false,
    )
  })

  it("personal note isolation: 404 renders not-found (MF-3)", async () => {
    const api = makeApi()
    api.get.mockImplementation(async () => {
      throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
    })
    renderView(api, "alices-id")
    expect(await screen.findByTestId("knowledge-doc-not-found")).toBeInTheDocument()
  })

  it("404 evicts the dangling knowledge:document tab (T23)", async () => {
    const { openTab, tabStore } = await import("~/modules/shell/tab-store")
    openTab({ type: "knowledge:document", entityId: "alices-id", label: "Denied doc" })
    expect(tabStore.tabs.some((t) => t.entityId === "alices-id")).toBe(true)

    const api = makeApi()
    api.get.mockImplementation(async () => {
      throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
    })
    renderView(api, "alices-id")
    await screen.findByTestId("knowledge-doc-not-found")
    expect(tabStore.tabs.some((t) => t.entityId === "alices-id")).toBe(false)
  })

  it("hides the review-status chip on personal-scope documents", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      return {
        id: "doc1",
        title: "Hello",
        body: "# H1",
        revision: 1,
        reviewStatus: "unverified",
        documentScope: "personal",
        ownerUserId: "alice",
        status: "active",
      }
    })
    renderView(api)
    await screen.findByTestId("knowledge-doc-title")
    expect(screen.queryByTestId("knowledge-doc-review-status")).not.toBeInTheDocument()
  })

  it("shows the review-status chip on organization-scope documents", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      return {
        id: "doc1",
        title: "Hello",
        body: "# H1",
        revision: 1,
        reviewStatus: "unverified",
        documentScope: "organization",
        ownerUserId: "alice",
        status: "active",
        sensitivity: "internal",
      }
    })
    renderView(api)
    expect((await screen.findByTestId("knowledge-doc-review-status")).textContent).toBe(
      "unverified",
    )
  })

  it("shows a Share button that opens the share dialog", async () => {
    const api = makeApi()
    renderView(api)
    await screen.findByTestId("knowledge-doc-title")
    const shareButton = await screen.findByTestId("knowledge-share-button")
    expect(screen.queryByTestId("knowledge-share-dialog")).not.toBeInTheDocument()
    fireEvent.click(shareButton)
    expect(await screen.findByTestId("knowledge-share-dialog")).toBeInTheDocument()
  })
})
