// SPDX-License-Identifier: FSL-1.1-ALv2
// A folder opened as a page (S20): its own text, then what is inside that the reader
// may open, only as the server listed it. The first keystroke makes the page once,
// however fast the next keys come, and none of them is lost. A synced folder, or a
// reader who may not start one, gets the list alone.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { liveSavers } from "./autosave"
import { _resetPageDrafts, type DraftStore, draftKey, type PageDraft } from "./drafts"
import KnowledgeFolderView from "./KnowledgeFolderView"
import type { KnowledgeFolderPage } from "./knowledge-api"
import { resetKnowledgeStore } from "./knowledge-store"
import { resetPageFiles } from "./page-files"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: () => false,
  userFromToken: () => ({ userId: "amina", orgId: "o1", name: "Amina Cherif" }),
}))

const tabs = vi.hoisted(() => ({ opened: [] as Array<Record<string, unknown>> }))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: (tab: Record<string, unknown>) => {
    tabs.opened.push(tab)
  },
}))

const FOLDER = "f0000000-0000-4000-8000-000000000001"

function folderView(over: Partial<KnowledgeFolderPage> = {}): KnowledgeFolderPage {
  return {
    folder: { id: FOLDER, name: "Policies", parentId: null, ownerUserId: null, synced: false },
    page: null,
    canStartPage: true,
    folders: [],
    pages: [],
    more: false,
    ...over,
  }
}

/** A server with one folder, its page made on the first POST, and a log. */
function makeApi(view: KnowledgeFolderPage) {
  let page: { id: string; title: string; body: string; revision: number } | null = view.page
    ? { ...view.page }
    : null
  let release: (() => void) | null = null
  const api = {
    hold: false,
    failStart: false,
    get: vi.fn(async (path: string) => {
      if (path === `/knowledge/collections/${FOLDER}/page`) return { ...view }
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.endsWith("/versions")) return []
      if (path === "/knowledge/collections/tree") return []
      if (page && path === `/knowledge/documents/${page.id}`)
        return { ...page, canEdit: true, documentScope: "organization", status: "active" }
      if (path.startsWith("/knowledge/documents/")) throw new ApiError("Not found", 404)
      return []
    }),
    post: vi.fn(async (path: string, body: { body?: string }) => {
      if (path === `/knowledge/collections/${FOLDER}/page`) {
        if (api.hold) await new Promise<void>((r) => (release = r))
        if (api.failStart) throw new ApiError("Nope", 500)
        page ??= { id: "p1", title: "Policies", body: body.body ?? "", revision: 1 }
        return { ...page }
      }
      if (path === "/knowledge/documents") return { id: "new1", title: "Untitled" }
      return {}
    }),
    patch: vi.fn(async (_path: string, body: { title: string; body: string; revision: number }) => {
      if (!page || body.revision !== page.revision) throw new ApiError("Revision conflict", 409)
      page = { ...page, title: body.title, body: body.body, revision: page.revision + 1 }
      return { ...page }
    }),
    put: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async () => ({ data: [] })),
    release: () => release?.(),
    page: () => page,
  }
  return api
}

function memoryDrafts(): DraftStore {
  const map = new Map<string, PageDraft>()
  return {
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

/** Let the lazily loaded editor mount, so its absence means something. */
const settled = () => new Promise((r) => setTimeout(r, 300))

function renderFolder(api: ReturnType<typeof makeApi>, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as never}>
        <KnowledgeFolderView entityId={FOLDER} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

beforeEach(() => {
  tabs.opened = []
  _resetPageDrafts(memoryDrafts())
})

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
  _resetPageDrafts(null)
  resetKnowledgeStore()
  resetPageFiles()
  setShellTier("desktop")
})

describe("what is inside", () => {
  it("lists the folders and pages the server listed; each opens in its tab", async () => {
    const api = makeApi(
      folderView({
        folders: [{ id: "f2", name: "Returns" }],
        pages: [{ id: "d1", title: "Refund rules" }],
      }),
    )
    renderFolder(api)
    fireEvent.click(await screen.findByTestId("knowledge-folder-item-folder-f2"))
    fireEvent.click(screen.getByTestId("knowledge-folder-item-page-d1"))
    expect(tabs.opened).toEqual([
      { type: "knowledge:folder", entityId: "f2", label: "Returns" },
      { type: "knowledge:document", entityId: "d1", label: "Refund rules" },
    ])
    expect(screen.getByTestId("knowledge-folder-title").textContent).toBe("Policies")
  })

  it("never lists the folder's own page among what is inside", async () => {
    const api = makeApi(
      folderView({
        page: { id: "p1", title: "Policies", body: "About.", revision: 1, canEdit: false },
        pages: [
          { id: "p1", title: "Policies" },
          { id: "d1", title: "Refund rules" },
        ],
      }),
    )
    renderFolder(api)
    await screen.findByTestId("knowledge-folder-item-page-d1")
    expect(screen.queryByTestId("knowledge-folder-item-page-p1")).toBeNull()
  })

  it("names nothing it was not given: a reader without the page sees the list alone", async () => {
    const api = makeApi(
      folderView({ canStartPage: false, pages: [{ id: "d1", title: "Refund rules" }] }),
    )
    const { container } = renderFolder(api)
    await screen.findByTestId("knowledge-folder-item-page-d1")
    await settled()
    expect(screen.queryByTestId("knowledge-folder-start-editor")).toBeNull()
    expect(screen.queryByTestId("knowledge-document-view")).toBeNull()
    // Only the folder's name and the listed page are named on screen.
    const names = [...container.querySelectorAll("h1, li")].map((el) => el.textContent?.trim())
    expect(names).toEqual(["Policies", "Refund rules"])
  })

  it("empty: says so, and New page files a page in the folder", async () => {
    const api = makeApi(folderView({ folder: { ...folderView().folder, ownerUserId: "amina" } }))
    renderFolder(api)
    expect((await screen.findByTestId("knowledge-folder-empty")).textContent).toBe(
      "Nothing here yet.",
    )
    fireEvent.click(screen.getByTestId("knowledge-folder-new-page"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents", {
        title: "Untitled",
        documentScope: "organization",
        // A personal folder's page is private, like the folder.
        orgAccess: "none",
        collectionIds: [FOLDER],
      }),
    )
    await waitFor(() => expect(tabs.opened.at(-1)?.entityId).toBe("new1"))
  })

  it("a synced folder has no page and no New page, whatever the answer says", async () => {
    const api = makeApi(
      folderView({
        folder: { ...folderView().folder, synced: true },
        canStartPage: true,
        pages: [{ id: "d1", title: "Synced doc" }],
      }),
    )
    renderFolder(api)
    await screen.findByTestId("knowledge-folder-item-page-d1")
    await settled()
    expect(screen.queryByTestId("knowledge-folder-start-editor")).toBeNull()
    expect(screen.queryByTestId("knowledge-folder-new-page")).toBeNull()
  })

  it("a folder that is gone, or never was the reader's, says so", async () => {
    const api = makeApi(folderView())
    api.get.mockImplementationOnce(async () => {
      throw new ApiError("Not found", 404)
    })
    renderFolder(api)
    expect(await screen.findByTestId("knowledge-folder-not-found")).toBeTruthy()
  })

  it("in French", async () => {
    renderFolder(makeApi(folderView()), "fr")
    expect((await screen.findByTestId("knowledge-folder-empty")).textContent).toBe(
      "Rien ici pour l'instant.",
    )
    expect(screen.getByTestId("knowledge-folder-new-page").textContent).toBe("Nouvelle page")
  })
})

describe("the folder's own page", () => {
  it("shows the page and the list under its text", async () => {
    const api = makeApi(
      folderView({
        page: { id: "p1", title: "Policies", body: "About.", revision: 1, canEdit: true },
        pages: [{ id: "d1", title: "Refund rules" }],
      }),
    )
    // The page itself is read by its id.
    api.get.mockImplementation(async (path: string) => {
      if (path === `/knowledge/collections/${FOLDER}/page`)
        return folderView({
          page: { id: "p1", title: "Policies", body: "About.", revision: 1, canEdit: true },
          pages: [{ id: "d1", title: "Refund rules" }],
        })
      if (path === "/knowledge/documents/p1")
        return { id: "p1", title: "Policies", body: "About.", revision: 1, canEdit: true }
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      return []
    })
    renderFolder(api)
    const view = await screen.findByTestId("knowledge-document-view")
    expect(view.getAttribute("data-document-id")).toBe("p1")
    expect(view.querySelector('[data-testid="knowledge-folder-contents"]')).not.toBeNull()
    expect(screen.getByTestId("knowledge-folder-item-page-d1")).toBeTruthy()
  })

  it("the first keystroke makes one page even with two fast edits; no key is lost", async () => {
    const api = makeApi(folderView())
    api.hold = true
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const editor = editorOf(field)
    editor.view.focus()
    typeInto(editor, "A")
    typeInto(editor, "b")
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    typeInto(editor, "c")
    api.release()
    // The page opens on everything typed, and the keys after the first are saved.
    const body = await screen.findByTestId("knowledge-doc-body-editor", {}, { timeout: 4000 })
    expect(editorOf(body).getMarkdown().trim()).toBe("Abc")
    const starts = api.post.mock.calls.filter(([p]) => String(p).endsWith("/page"))
    expect(starts).toHaveLength(1)
    expect(starts[0]?.[1]).toEqual({ body: "A" })
    await waitFor(() => expect(api.page()?.body).toBe("Abc"), { timeout: 4000 })
  })

  it("a failed start keeps the text and the next keystroke tries again", async () => {
    const api = makeApi(folderView())
    api.failStart = true
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const editor = editorOf(field)
    editor.view.focus()
    typeInto(editor, "A")
    expect(await screen.findByTestId("knowledge-folder-start-error")).toBeTruthy()
    expect(editor.getMarkdown().trim()).toBe("A")
    api.failStart = false
    typeInto(editor, "b")
    const body = await screen.findByTestId("knowledge-doc-body-editor", {}, { timeout: 4000 })
    expect(editorOf(body).getMarkdown().trim()).toBe("Ab")
  })
})

describe("on a phone", () => {
  it("the list and the first text fit the screen, with rows a finger can hit", async () => {
    setShellTier("phone")
    renderFolder(makeApi(folderView({ pages: [{ id: "d1", title: "Refund rules" }] })))
    const row = await screen.findByTestId("knowledge-folder-item-page-d1")
    expect(row.className).toContain("[@media(pointer:coarse)]:min-h-11")
    expect(
      await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 }),
    ).toBeTruthy()
    const body = screen.getByTestId("knowledge-folder-contents").parentElement!
    expect(body.className).toContain("px-4")
    expect(body.className).not.toContain("max-w-2xl")
  })
})
