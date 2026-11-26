// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { editorOf, setMarkdown } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { liveSavers } from "./autosave"
import { _resetPageDrafts, type DraftStore, draftKey, type PageDraft } from "./drafts"
import KnowledgeDocumentView from "./KnowledgeDocumentView"
import { resetKnowledgeStore, setKnowledgeStoreDocument } from "./knowledge-store"
import { resetPageFiles } from "./page-files"

// The viewer's scopes: the attachments section follows knowledge:attachments:download.
const scopes = vi.hoisted(() => new Set(["knowledge:attachments:download"]))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scopes.has(scope),
  userFromToken: () => ({ userId: "amina", orgId: "o1", name: "Amina Cherif" }),
}))

interface Page {
  id: string
  title: string
  body: string
  revision: number
  [k: string]: unknown
}

/** A server with one page: revisions, versions, and a log of what was sent. */
function makeApi(over: Partial<Page> = {}) {
  let page: Page = {
    id: "doc1",
    title: "Hello",
    body: "# H1\n\nFirst line.",
    revision: 1,
    reviewStatus: "verified",
    documentScope: "organization",
    sensitivity: "internal",
    ownerUserId: "alice",
    status: "active",
    canEdit: true,
    updatedAt: new Date().toISOString(),
    ...over,
  }
  const versions = [
    {
      id: "v1",
      kind: "edit",
      title: "Hello",
      authorType: "user",
      authorId: "lucas",
      authorName: "Lucas Pereira",
      agentId: null,
      revision: 1,
      baseRevision: 0,
      startedAt: "2026-11-24T10:00:00.000Z",
      createdAt: "2026-11-24T10:00:00.000Z",
      updatedAt: "2026-11-24T10:00:00.000Z",
    },
  ]
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.endsWith("/sharing")) return { orgAccess: "none", shares: [] }
      if (path === "/knowledge/members" || path === "/knowledge/roles") return []
      if (path.startsWith("/files")) return []
      if (path.endsWith("/versions")) return versions
      if (path.includes("/versions/")) return { ...versions[0], body: "Old text." }
      return { ...page }
    }),
    post: vi.fn(async (path: string, body: { revision?: number }) => {
      if (path.endsWith("/restore") && path.includes("/versions/")) {
        page = { ...page, body: "Old text.", revision: page.revision + 1 }
        return { ...page }
      }
      void body
      return { id: "unapplied1" }
    }),
    patch: vi.fn(async (path: string, body: { title: string; body: string; revision: number }) => {
      void path
      if (body.revision !== page.revision) throw new ApiError("Revision conflict", 409)
      page = { ...page, title: body.title, body: body.body, revision: page.revision + 1 }
      return { ...page }
    }),
    put: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async (_path: string) => ({ data: [] })),
    /** Someone else saves the page. */
    theyWrite(text: string) {
      page = { ...page, body: text, revision: page.revision + 1 }
      return { ...page }
    },
    page: () => page,
  }
  return api
}

function memoryDrafts(): DraftStore & { map: Map<string, PageDraft> } {
  const map = new Map<string, PageDraft>()
  return {
    map,
    async put(d) {
      map.set(draftKey(d), { ...d })
    },
    async remove(key) {
      map.delete(key)
    },
    async forUser(userId) {
      return [...map.values()].filter((d) => d.userId === userId)
    },
    writeShadow(d) {
      map.set(draftKey(d), { ...d })
    },
  }
}

let drafts: ReturnType<typeof memoryDrafts>

function renderView(
  api: ReturnType<typeof makeApi>,
  entityId = "doc1",
  locale: "en" | "fr" = "en",
) {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as never}>
        <KnowledgeDocumentView entityId={entityId} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

const SAVE_WAIT = { timeout: 4_000 }

async function bodyField() {
  return screen.findByTestId("knowledge-doc-body-editor", {}, SAVE_WAIT)
}

const patchPaths = (api: ReturnType<typeof makeApi>) =>
  api.patch.mock.calls.map(([path]) => String(path))

beforeEach(() => {
  drafts = memoryDrafts()
  _resetPageDrafts(drafts)
})

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
  _resetPageDrafts(null)
  resetKnowledgeStore()
  resetPageFiles()
  scopes.add("knowledge:attachments:download")
})

describe("KnowledgeDocumentView: a reader", () => {
  it("sees the rendered text: no editor, no save state, a checklist that does not tick", async () => {
    renderView(makeApi({ canEdit: false, body: "# H1\n\n- [ ] call back\n- [x] done" }))
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    expect(rendered.querySelector("h1")?.textContent?.trim()).toBe("H1")
    // A checklist is drawn, not a control: nothing to tick, nothing sent.
    expect(rendered.querySelectorAll(".md-task-box")).toHaveLength(2)
    expect(rendered.querySelectorAll("input")).toHaveLength(0)
    fireEvent.click(rendered.querySelector(".md-task-box")!)
    expect(rendered.querySelectorAll(".md-task-done")).toHaveLength(1)
    expect(screen.queryByTestId("knowledge-doc-body-editor")).toBeNull()
    expect(screen.queryByTestId("save-state")).toBeNull()
    expect(screen.getByTestId("knowledge-doc-title").getAttribute("contenteditable")).toBe("false")
    expect(screen.queryByTestId("knowledge-doc-edit")).toBeNull()
  })

  it("a synced page is read only, with no history", async () => {
    renderView(makeApi({ syncedSourceId: "src1", syncedSourceApp: "google-drive" }))
    await screen.findByTestId("knowledge-doc-synced-banner")
    expect(screen.queryByTestId("knowledge-doc-body-editor")).toBeNull()
    expect(screen.queryByTestId("save-state")).toBeNull()
  })
})

describe("KnowledgeDocumentView: an editor", () => {
  it("edits on click: the editor is there at once, with no Edit, Save or Cancel", async () => {
    renderView(makeApi())
    const field = await bodyField()
    expect(field.querySelector("h1")?.textContent).toBe("H1")
    expect(screen.queryByTestId("knowledge-doc-edit")).toBeNull()
    expect(screen.queryByTestId("knowledge-doc-save")).toBeNull()
    expect(screen.queryByTestId("knowledge-doc-cancel-edit")).toBeNull()
    expect(screen.getByTestId("knowledge-doc-title").getAttribute("contenteditable")).toBe("true")
    expect(screen.getByTestId("save-state").textContent).toBe("Saved")
  })

  it("opening and leaving sends nothing", async () => {
    const api = makeApi()
    const view = renderView(api)
    await bodyField()
    await new Promise((r) => setTimeout(r, 1_200))
    view.unmount()
    await new Promise((r) => setTimeout(r, 50))
    expect(api.patch).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it("saves typed text by itself with ?autosave=1 and its session, then says Saved", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    setMarkdown(field, "# H1\n\nFirst line. More.")
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1), SAVE_WAIT)
    expect(patchPaths(api)[0]).toMatch(
      /^\/knowledge\/documents\/doc1\?autosave=1&session=[0-9a-f-]{36}$/,
    )
    expect(api.patch.mock.calls[0]![1]).toMatchObject({ revision: 1, title: "Hello" })
    expect(String(api.patch.mock.calls[0]![1].body)).toContain("More.")
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("Saved"))
    expect(screen.getByTestId("knowledge-doc-edited").textContent).toMatch(/^Edited by you/)
  })

  it("the title saves the same way", async () => {
    const api = makeApi()
    renderView(api)
    await bodyField()
    const title = screen.getByTestId("knowledge-doc-title")
    title.textContent = "Returns policy"
    fireEvent.input(title)
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1), SAVE_WAIT)
    expect(api.patch.mock.calls[0]![1]).toMatchObject({ title: "Returns policy" })
  })

  it("a new, empty Untitled page opens with its title selected, so typing names it", async () => {
    renderView(makeApi({ title: "Untitled", body: "" }))
    await bodyField()
    const title = screen.getByTestId("knowledge-doc-title")
    await waitFor(() => expect(document.activeElement).toBe(title))
    expect(window.getSelection()?.toString()).toBe("Untitled")
  })

  it("a page with a title or with text does not take the caret", async () => {
    renderView(makeApi())
    await bodyField()
    await new Promise((r) => setTimeout(r, 100))
    expect(document.activeElement).not.toBe(screen.getByTestId("knowledge-doc-title"))
  })

  it("the selection survives a save acknowledgement", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    setMarkdown(field, "# H1\n\nFirst line, edited.")
    const editor = editorOf(field)
    editor.commands.setTextSelection({ from: 5, to: 9 })
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1), SAVE_WAIT)
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("Saved"))
    expect(editor.state.selection.from).toBe(5)
    expect(editor.state.selection.to).toBe(9)
  })

  it("someone else's save while I typed: conflict, my text kept on screen", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    api.theyWrite("Their text.")
    setMarkdown(field, "My text.")
    await screen.findByTestId("knowledge-doc-conflict-banner", {}, SAVE_WAIT)
    expect(screen.getByTestId("save-state").textContent).toBe(
      "Not saved: someone else saved this page",
    )
    expect(field.textContent).toContain("My text.")
    // Lucas is the newest author in the page's history.
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-doc-conflict-banner").textContent).toContain(
        "Lucas Pereira saved this page",
      ),
    )
  })

  it("Keep mine sends fresh=1 at their revision", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    api.theyWrite("Their text.")
    setMarkdown(field, "My text.")
    fireEvent.click(await screen.findByTestId("conflict-open", {}, SAVE_WAIT))
    fireEvent.click(await screen.findByTestId("conflict-mine"))
    await waitFor(() => expect(patchPaths(api).at(-1)).toContain("&fresh=1"))
    expect(api.patch.mock.calls.at(-1)![1]).toMatchObject({ revision: 2 })
    expect(api.page().body).toContain("My text.")
    await waitFor(() => expect(screen.queryByTestId("knowledge-doc-conflict-banner")).toBeNull())
  })

  it("Take theirs puts my text in Page history and shows theirs", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    api.theyWrite("Their text.")
    setMarkdown(field, "My text.")
    fireEvent.click(await screen.findByTestId("conflict-open", {}, SAVE_WAIT))
    fireEvent.click(await screen.findByTestId("conflict-theirs"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/versions",
        expect.objectContaining({ body: "My text.", baseRevision: 1 }),
        expect.anything(),
      ),
    )
    await waitFor(() => expect(field.textContent).toContain("Their text."))
  })

  it("See both shows the two texts with the choices", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    api.theyWrite("Their text.")
    setMarkdown(field, "My text.")
    fireEvent.click(await screen.findByTestId("conflict-open", {}, SAVE_WAIT))
    fireEvent.click(await screen.findByTestId("conflict-both"))
    const dialog = await screen.findByTestId("conflict-dialog")
    expect(dialog.getAttribute("data-mode")).toBe("both")
    expect(dialog.textContent).toContain("My text.")
    expect(dialog.textContent).toContain("Their text.")
    expect(screen.getByTestId("conflict-both-mine")).toBeInTheDocument()
  })

  it("conflict then close the tab: my text is posted to Page history (D7)", async () => {
    const api = makeApi()
    const view = renderView(api)
    const field = await bodyField()
    api.theyWrite("Their text.")
    setMarkdown(field, "My text.")
    await screen.findByTestId("knowledge-doc-conflict-banner", {}, SAVE_WAIT)
    view.unmount()
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/versions",
        expect.objectContaining({ body: "My text.", baseRevision: 1 }),
        expect.anything(),
      ),
    )
  })

  it("leaving with unsaved text saves it first", async () => {
    const api = makeApi()
    const view = renderView(api)
    const field = await bodyField()
    setMarkdown(field, "Typed just before leaving.")
    view.unmount()
    await waitFor(() => expect(api.page().body).toBe("Typed just before leaving."))
  })

  it("a remote save is taken in place while nothing is unsaved", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    setKnowledgeStoreDocument(api.theyWrite("Their newer text."))
    await waitFor(() => expect(field.textContent).toContain("Their newer text."))
    expect(api.patch).not.toHaveBeenCalled()
  })

  it("page gone while typing: the text stays, the notice offers Copy (edge 3)", async () => {
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    api.patch.mockImplementation(async () => {
      throw new ApiError("Knowledge item not found", 404)
    })
    setMarkdown(field, "Words I must not lose.")
    await screen.findByTestId("knowledge-doc-no-access", {}, SAVE_WAIT)
    expect(screen.getByTestId("knowledge-doc-copy-text")).toBeInTheDocument()
    expect(field.textContent).toContain("Words I must not lose.")
    await waitFor(() =>
      expect([...drafts.map.values()].some((d) => d.body.includes("Words I must not lose."))).toBe(
        true,
      ),
    )
  })

  it("a draft left by a closed tab is put back and saved", async () => {
    await drafts.put({
      userId: "amina",
      docId: "doc1",
      sessionId: "closed-tab",
      title: "Hello",
      body: "Text from the closed tab.",
      baseRevision: 1,
      baseHash: "",
      at: Date.now() - 60_000,
      beat: Date.now() - 60_000,
    })
    const api = makeApi()
    renderView(api)
    const field = await bodyField()
    expect(field.textContent).toContain("Text from the closed tab.")
    await waitFor(() => expect(api.page().body).toBe("Text from the closed tab."), SAVE_WAIT)
    await waitFor(() => expect(drafts.map.size).toBe(0))
  })

  it("Page history: list, compare, restore with the current revision", async () => {
    const api = makeApi()
    renderView(api)
    await bodyField()
    fireEvent.click(screen.getByTestId("knowledge-doc-menu"))
    fireEvent.click(await screen.findByTestId("knowledge-doc-history"))
    const history = await screen.findByTestId("page-history")
    await waitFor(() => expect(screen.getAllByTestId("history-version")).toHaveLength(2))
    const items = screen.getAllByTestId("history-version")
    expect(items[1]!.textContent).toContain("Lucas Pereira")
    fireEvent.click(items[1]!)
    await waitFor(() =>
      expect(screen.getByTestId("history-diff").textContent).toContain("Old text."),
    )
    fireEvent.click(screen.getByTestId("history-restore"))
    fireEvent.click(await screen.findByTestId("history-restore-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/documents/doc1/versions/v1/restore",
        { revision: 1 },
        expect.anything(),
      ),
    )
    await waitFor(() => expect(history.isConnected).toBe(false))
    expect((await bodyField()).textContent).toContain("Old text.")
  })

  it("the review badge is a translated label, never the raw value", async () => {
    renderView(makeApi({ reviewStatus: "needs_review" }), "doc1", "fr")
    expect((await screen.findByTestId("knowledge-doc-review-status")).textContent).toBe("À revoir")
  })
})

describe("KnowledgeDocumentView: around the text", () => {
  it("renders the attachment list for knowledge documents (MF-6)", async () => {
    renderView(makeApi())
    expect(await screen.findByTestId("knowledge-attachment-list")).toBeInTheDocument()
  })

  it("a viewer without the attachments scope gets no section and asks for no files", async () => {
    scopes.delete("knowledge:attachments:download")
    const api = makeApi()
    renderView(api)
    await screen.findByTestId("knowledge-doc-title")
    expect(screen.queryByTestId("knowledge-attachment-list")).toBeNull()
    expect(api.getEnvelope.mock.calls.some(([path]) => String(path).startsWith("/files"))).toBe(
      false,
    )
  })

  it("personal note isolation: 404 says the page cannot be opened, under a neutral tab label (MF-3, T23)", async () => {
    const { openTab, tabStore } = await import("~/modules/shell/tab-store")
    openTab({ type: "knowledge:document", entityId: "alices-id", label: "Denied doc" })
    const api = makeApi()
    api.get.mockImplementation(async () => {
      throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
    })
    renderView(api, "alices-id")
    expect(await screen.findByTestId("knowledge-doc-not-found")).toBeInTheDocument()
    // A calm state, in the tab that was opened: the link's title is not kept on it.
    expect(screen.getByText("You can't open this page")).toBeInTheDocument()
    const tab = () => tabStore.tabs.find((t) => t.entityId === "alices-id")
    expect(tab()?.label).toBe("Page you cannot open")
    fireEvent.click(screen.getByTestId("knowledge-doc-not-found-close"))
    expect(tab()).toBeUndefined()
  })

  it("hides the review chip on personal pages", async () => {
    renderView(
      makeApi({ documentScope: "personal", sensitivity: undefined, reviewStatus: "unverified" }),
    )
    await screen.findByTestId("knowledge-doc-title")
    expect(screen.queryByTestId("knowledge-doc-review-status")).toBeNull()
  })

  it("shows a Share button that opens the share dialog", async () => {
    renderView(makeApi())
    fireEvent.click(await screen.findByTestId("knowledge-share-button"))
    expect(await screen.findByTestId("knowledge-share-dialog")).toBeInTheDocument()
  })

  it("B11: the badge changes after Verify without a reload", async () => {
    let review = "needs_review"
    const api = makeApi({ reviewStatus: review })
    const get = api.get.getMockImplementation() as (path: string) => Promise<object>
    const post = api.post.getMockImplementation() as (
      path: string,
      body: { revision?: number },
    ) => Promise<object>
    api.get.mockImplementation(async (path: string) => {
      const out = await get(path)
      return (
        path === "/knowledge/documents/doc1" ? { ...out, reviewStatus: review } : out
      ) as never
    })
    api.post.mockImplementation(async (path: string, body: { revision?: number }) => {
      if (path.endsWith("/verify")) review = "verified"
      return (await post(path, body)) as never
    })
    renderView(api)
    expect(await screen.findByTestId("knowledge-doc-review-status")).toHaveTextContent(
      "Needs review",
    )
    fireEvent.click(screen.getByTestId("knowledge-doc-menu"))
    fireEvent.click(await screen.findByText("Verify"))
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-doc-review-status")).toHaveTextContent("Verified"),
    )
  })

  it("B12: the references count reads in the reader's language", async () => {
    const api = makeApi()
    const get = api.get.getMockImplementation() as (path: string) => Promise<object>
    api.get.mockImplementation(
      async (path: string) =>
        (path.endsWith("/backlinks")
          ? {
              backlinks: [
                { app: "knowledge", entityType: "document", entityId: "a", title: "A" },
                { app: "knowledge", entityType: "document", entityId: "b", title: "B" },
              ],
            }
          : await get(path)) as never,
    )
    renderView(api, "doc1", "fr")
    expect(await screen.findByText("2 références")).toBeInTheDocument()
  })
})

describe("KnowledgeDocumentView: images and files (S11, S12)", () => {
  const A = "11111111-1111-4111-8111-111111111111"
  const B = "22222222-2222-4222-8222-222222222222"
  const token = (id: string) => `![](liaison-file:${id})`

  /** The page's files answered by the files API, its pictures by the inline route. */
  function withFiles(api: ReturnType<typeof makeApi>) {
    const get = api.get.getMockImplementation()!
    const files = vi.fn(async (path: string): Promise<unknown> => {
      const m = /^\/files\/([0-9a-f-]{36})\/metadata$/.exec(path)
      if (m) return { id: m[1], filename: "chart.png", mimeType: "image/png", sizeBytes: 10 }
      return get(path)
    })
    api.get.mockImplementation(files as unknown as typeof get)
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/picture")
    URL.revokeObjectURL = vi.fn()
    return Object.assign(api, {
      rawGet: vi.fn(
        async () => new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
      ),
    })
  }

  it("a reader sees the page's picture through the files API, and no add control", async () => {
    const api = withFiles(makeApi({ canEdit: false, body: `Look: ${token(A)}` }))
    renderView(api)
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    await waitFor(() =>
      expect(rendered.querySelector("img")?.getAttribute("src")).toBe(
        "blob:http://localhost/picture",
      ),
    )
    expect(api.get).toHaveBeenCalledWith(`/files/${A}/metadata`, { suppressGlobalError: true })
    expect(api.rawGet).toHaveBeenCalledWith(`/files/${A}/inline`, { suppressGlobalError: true })
    expect(screen.queryByTestId("knowledge-attachment-add")).toBeNull()
    expect(screen.queryByTestId("rich-editor.tool-image")).toBeNull()
  })

  it("a writer has the Image and File tools and Add a file", async () => {
    renderView(withFiles(makeApi()))
    await bodyField()
    expect(await screen.findByTestId("rich-editor.tool-image")).toBeTruthy()
    expect(screen.getByTestId("rich-editor.tool-file")).toBeTruthy()
    expect(screen.getByTestId("knowledge-attachment-add").textContent).toBe("Add a file")
  })

  it("the save copied another page's file: the editor takes the copy's id, nothing more is sent", async () => {
    const api = withFiles(makeApi({ body: "Start." }))
    const patch = api.patch.getMockImplementation()!
    api.patch.mockImplementation(async (path, body) => {
      const copied = { ...body, body: body.body.replace(A, B) }
      const row = await patch(path, copied)
      return { ...row, fileIdMap: body.body.includes(A) ? { [A]: B } : undefined }
    })
    renderView(api)
    const field = await bodyField()
    setMarkdown(field, `Start. ${token(A)}`)
    await waitFor(
      () => expect(screen.getByTestId("save-state").textContent).toBe("Saved"),
      SAVE_WAIT,
    )
    const editor = editorOf(field)
    const ids: string[] = []
    editor.state.doc.descendants((n) => {
      if (n.type.name === "liaisonFile") ids.push(n.attrs.id)
    })
    expect(ids).toEqual([B])
    await new Promise((r) => setTimeout(r, 1_500))
    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.page().body).toBe(`Start. ${token(B)}`)
  })

  it("phone: a writer adds a file from the Sources sheet", async () => {
    setShellTier("phone")
    try {
      renderView(withFiles(makeApi()))
      await bodyField()
      expect(screen.queryByTestId("knowledge-attachment-add")).toBeNull()
      fireEvent.click(screen.getByTestId("knowledge-doc-sources-open"))
      expect((await screen.findByTestId("knowledge-attachment-add")).textContent).toBe("Add a file")
    } finally {
      setShellTier("desktop")
    }
  })

  it("FR: the add control and the unavailable label are French", async () => {
    const api = withFiles(makeApi({ canEdit: false, body: token(A) }))
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/files/")) throw new ApiError("nf", 404)
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      return { ...api.page(), canEdit: false, body: token(A) }
    })
    renderView(api, "doc1", "fr")
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    await waitFor(() => expect(rendered.textContent).toContain("Image non disponible"))
  })
})
