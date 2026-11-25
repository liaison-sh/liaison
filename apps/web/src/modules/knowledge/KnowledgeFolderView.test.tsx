// SPDX-License-Identifier: FSL-1.1-ALv2
// A folder opened as a page (S20): its own text, then what is inside that the reader
// may open, only as the server listed it. The first keystroke makes the page once,
// however fast the next keys come, and none of them is lost. A synced folder, or a
// reader who may not start one, gets the list alone.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { liveSavers } from "./autosave"
import { _resetPageDrafts, type DraftStore, draftKey, type PageDraft, pageDrafts } from "./drafts"
import KnowledgeFolderView from "./KnowledgeFolderView"
import type { KnowledgeFolderPage } from "./knowledge-api"
import { loadCollectionsTree, resetKnowledgeStore } from "./knowledge-store"
import { resetPageFiles } from "./page-files"

const scopes = vi.hoisted(() => ({ held: new Set<string>() }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scopes.held.has(scope),
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
  let releaseView: (() => void) | null = null
  const api = {
    hold: false,
    failStart: false,
    /** The folder's answer waits until `releaseView()` (a slow refresh). */
    holdView: false,
    /** The folder's answer does not know of a page made meanwhile (a stale read). */
    viewStale: false,
    get: vi.fn(async (path: string): Promise<unknown> => {
      if (path === `/knowledge/collections/${FOLDER}/page`) {
        if (api.holdView) await new Promise<void>((r) => (releaseView = r))
        if (!page || api.viewStale) return { ...view }
        return { ...view, page: { ...page, canEdit: true }, canStartPage: false }
      }
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
        const created = !page
        page ??= { id: "p1", title: "Policies", body: body.body ?? "", revision: 1 }
        return { ...page, created }
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
    releaseView: () => releaseView?.(),
    page: () => page,
    /** Someone else made the folder's page (this reader's view has not seen it). */
    madeElsewhere: (row: { id: string; title: string; body: string; revision: number }) => {
      page = { ...row }
    },
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
  scopes.held = new Set(["knowledge:documents:create"])
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

  it("no New page for someone who may not create pages (as the tree's + button)", async () => {
    scopes.held = new Set()
    renderFolder(makeApi(folderView({ canStartPage: false })))
    expect(await screen.findByTestId("knowledge-folder-contents")).toBeTruthy()
    expect(screen.queryByTestId("knowledge-folder-new-page")).toBeNull()
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
        return {
          id: "p1",
          title: "Policies",
          body: "About.",
          revision: 1,
          canEdit: true,
          documentScope: "organization",
          status: "active",
        }
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

  it("a failed start keeps the text, says so with Copy text, and sends nothing per key", async () => {
    const api = makeApi(folderView())
    api.failStart = true
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const editor = editorOf(field)
    editor.view.focus()
    typeInto(editor, "A")
    expect(await screen.findByTestId("knowledge-folder-start-error")).toBeTruthy()
    expect(screen.getByTestId("knowledge-folder-start-copy")).toBeTruthy()
    typeInto(editor, "b")
    typeInto(editor, "c")
    await settled()
    const starts = () => api.post.mock.calls.filter(([p]) => String(p).endsWith("/page"))
    // One failed request, not one per key.
    expect(starts()).toHaveLength(1)
    expect(editor.getMarkdown().trim()).toBe("Abc")
    // The text is in this person's local draft for the folder, and the sign-out guard sees it.
    const unsaved = liveSavers().filter((s) => s.docId === FOLDER)
    expect(unsaved).toHaveLength(1)
    expect(unsaved[0]!.hasUnsaved()).toBe(true)
    await unsaved[0]!.persistDraft()
    const drafts = await pageDrafts().forUser("amina")
    expect(drafts.find((d) => d.docId === FOLDER)?.body).toBe("Abc")
    // Try again makes the page from all of it.
    api.failStart = false
    fireEvent.click(screen.getByTestId("knowledge-folder-start-retry"))
    const body = await screen.findByTestId("knowledge-doc-body-editor", {}, { timeout: 4000 })
    expect(editorOf(body).getMarkdown().trim()).toBe("Abc")
    expect(starts()).toHaveLength(2)
    await waitFor(() => expect(liveSavers().filter((s) => s.docId === FOLDER)).toHaveLength(0))
  })

  it("text typed in a folder and never sent comes back when the folder opens again", async () => {
    await pageDrafts().put({
      userId: "amina",
      docId: FOLDER,
      sessionId: "old-tab",
      title: "Policies",
      body: "Left from before",
      baseRevision: 0,
      baseHash: "",
      at: 1,
      beat: 1,
    })
    const api = makeApi(folderView())
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    await waitFor(() => expect(editorOf(field).getMarkdown().trim()).toBe("Left from before"))
    // Shown, not sent on its own: the person decides by typing on.
    expect(api.post.mock.calls.filter(([p]) => String(p).endsWith("/page"))).toHaveLength(0)
  })

  it("a page someone else made meanwhile is never saved over: the conflict choice opens", async () => {
    const api = makeApi(folderView())
    api.viewStale = true
    api.madeElsewhere({ id: "p1", title: "Policies", body: "Ana wrote this", revision: 3 })
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const editor = editorOf(field)
    editor.view.focus()
    typeInto(editor, "Ben's text")
    expect(
      await screen.findByTestId("knowledge-doc-conflict-banner", {}, { timeout: 4000 }),
    ).toBeTruthy()
    const body = screen.getByTestId("knowledge-doc-body-editor")
    expect(editorOf(body).getMarkdown().trim()).toBe("Ben's text")
    await new Promise((r) => setTimeout(r, 1_500))
    expect(api.patch).not.toHaveBeenCalled()
    expect(api.page()?.body).toBe("Ana wrote this")
  })

  it("the page appearing under a failed start keeps the typed text, as a conflict", async () => {
    const api = makeApi(folderView())
    api.failStart = true
    renderFolder(api)
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const editor = editorOf(field)
    editor.view.focus()
    typeInto(editor, "Mine")
    await screen.findByTestId("knowledge-folder-start-error")
    api.madeElsewhere({ id: "p1", title: "Policies", body: "Theirs", revision: 2 })
    await loadCollectionsTree(api as never)
    expect(
      await screen.findByTestId("knowledge-doc-conflict-banner", {}, { timeout: 4000 }),
    ).toBeTruthy()
    expect(editorOf(screen.getByTestId("knowledge-doc-body-editor")).getMarkdown().trim()).toBe(
      "Mine",
    )
    expect(api.patch).not.toHaveBeenCalled()
  })

  it("a tree change while the page is edited keeps the editor in place, focused", async () => {
    const api = makeApi(folderView())
    render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api as never}>
          <Suspense fallback={<div data-testid="tab-loading" />}>
            <KnowledgeFolderView entityId={FOLDER} />
          </Suspense>
        </ApiContext.Provider>
      </I18nProvider>
    ))
    const field = await screen.findByTestId("knowledge-folder-start-editor", {}, { timeout: 4000 })
    const start = editorOf(field)
    start.view.focus()
    typeInto(start, "First")
    const body = await screen.findByTestId("knowledge-doc-body-editor", {}, { timeout: 4000 })
    await waitFor(() => expect(body.contains(document.activeElement)).toBe(true))
    // The tree changes (the page made, a rename, a resync) while the folder's answer is slow.
    api.holdView = true
    void loadCollectionsTree(api as never)
    await settled()
    expect(screen.queryByTestId("tab-loading")).toBeNull()
    expect(body.isConnected).toBe(true)
    expect(body.contains(document.activeElement)).toBe(true)
    typeInto(editorOf(body), " and more")
    api.holdView = false
    api.releaseView()
    await settled()
    expect(screen.getByTestId("knowledge-doc-body-editor")).toBe(body)
    expect(editorOf(body).getMarkdown().trim()).toBe("First and more")
    await waitFor(() => expect(api.page()?.body).toBe("First and more"), { timeout: 4000 })
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
