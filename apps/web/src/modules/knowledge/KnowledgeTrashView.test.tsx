// SPDX-License-Identifier: FSL-1.1-ALv2
// Trash (S19, D3, D4, B3): the list with who, when and days left, Restore, Delete
// for good for administrators only, "Move to trash" on a page with a 10 s Undo, and
// a trashed page opened by its link.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { liveSavers } from "./autosave"
import { _resetPageDrafts, type DraftStore, draftKey, type PageDraft } from "./drafts"
import KnowledgeDocumentView from "./KnowledgeDocumentView"
import KnowledgeSidebar from "./KnowledgeSidebar"
import KnowledgeTrashView from "./KnowledgeTrashView"
import type { KnowledgeTrashEntry } from "./knowledge-api"
import { resetKnowledgeStore } from "./knowledge-store"
import { moveToTrash, resetTrash } from "./trash"

const ARCHIVE = "knowledge:documents:archive"
const ADMIN = "knowledge:documents:admin"

const scopes = vi.hoisted(() => new Set<string>())
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scopes.has(scope),
  userFromToken: () => ({ userId: "amina", orgId: "o1", name: "Amina Cherif" }),
}))

const now = Date.now()
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()

function entries(): KnowledgeTrashEntry[] {
  return [
    {
      id: "e1",
      title: "Price list 2025",
      archivedAt: daysAgo(1),
      trashedAt: daysAgo(1),
      trashedBy: "amina",
      trashedByName: "Amina Cherif",
      daysLeft: 29,
    },
    {
      id: "e2",
      title: "Packing list",
      archivedAt: daysAgo(29),
      trashedAt: daysAgo(29),
      trashedBy: "lucas",
      trashedByName: "Lucas Pereira",
      daysLeft: 1,
    },
    {
      id: "e3",
      title: "Old handbook",
      archivedAt: daysAgo(200),
      trashedAt: null,
      trashedBy: null,
      trashedByName: null,
      daysLeft: null,
    },
  ]
}

/** A server holding a Trash list and one page that can go to Trash and back. */
function makeApi(opts: { page?: Record<string, unknown>; trashed?: boolean } = {}) {
  let trash = entries()
  let pageTrashed = opts.trashed ?? false
  const page = {
    id: "doc1",
    title: "Return procedure",
    body: "Steps.",
    revision: 1,
    documentScope: "organization",
    sensitivity: "internal",
    status: "active",
    canEdit: true,
    updatedAt: new Date(now).toISOString(),
    ...opts.page,
  }
  const docEntry = (): KnowledgeTrashEntry => ({
    id: "doc1",
    title: page.title,
    archivedAt: daysAgo(2),
    trashedAt: daysAgo(2),
    trashedBy: "lucas",
    trashedByName: "Lucas Pereira",
    daysLeft: 28,
  })
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/knowledge/trash") return pageTrashed ? [docEntry(), ...trash] : trash
      if (path === "/knowledge/trash/doc1") {
        if (pageTrashed) return docEntry()
        throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
      }
      if (path === "/knowledge/documents/doc1") {
        if (pageTrashed) throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
        return { ...page }
      }
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.endsWith("/versions")) return []
      if (path === "/knowledge/collections/tree") return []
      if (path === "/knowledge/home") return { unfiledCount: 0 }
      return []
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/knowledge/documents/doc1/trash") {
        pageTrashed = true
        return { ...page, status: "archived" }
      }
      if (path === "/knowledge/documents/doc1/restore") {
        pageTrashed = false
        return { ...page }
      }
      const restored = /^\/knowledge\/documents\/(e\d)\/restore$/.exec(path)
      if (restored) {
        trash = trash.filter((e) => e.id !== restored[1])
        return { id: restored[1] }
      }
      return {}
    }),
    patch: vi.fn(async () => ({ ...page })),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async (path: string) => {
      const id = path.split("/").pop() ?? ""
      trash = trash.filter((e) => e.id !== id)
      return { id, deleted: true }
    }),
    getEnvelope: vi.fn(async () => ({ data: [] })),
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

function wrap(api: ReturnType<typeof makeApi>, ui: () => unknown, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as never}>{ui() as never}</ApiContext.Provider>
    </I18nProvider>
  ))
}

const lastToast = () => toasts()[toasts().length - 1]

beforeEach(() => {
  scopes.clear()
  scopes.add("knowledge:documents:read")
  _resetPageDrafts(memoryDrafts())
})

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
  _resetPageDrafts(null)
  vi.useRealTimers()
  resetToastStore()
  resetTrash()
  resetKnowledgeStore()
})

describe("Trash list", () => {
  it("lists who, when and the days left; a page archived before Trash reads Kept", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi(), () => <KnowledgeTrashView />)
    const mine = await screen.findByTestId("knowledge-trash-row-e1")
    expect(mine).toHaveTextContent("Price list 2025")
    expect(mine).toHaveTextContent(/^.*You, /)
    expect(within(mine).getByTestId("knowledge-trash-days")).toHaveTextContent("29 days left")
    const theirs = screen.getByTestId("knowledge-trash-row-e2")
    expect(theirs).toHaveTextContent("Lucas Pereira")
    expect(within(theirs).getByTestId("knowledge-trash-days")).toHaveTextContent("1 day left")
    const kept = screen.getByTestId("knowledge-trash-row-e3")
    expect(within(kept).getByTestId("knowledge-trash-days")).toHaveTextContent("Kept")
  })

  it("shows the list in French", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi(), () => <KnowledgeTrashView />, "fr")
    const row = await screen.findByTestId("knowledge-trash-row-e1")
    expect(within(row).getByTestId("knowledge-trash-days")).toHaveTextContent("29 jours restants")
    expect(within(row).getByTestId("knowledge-trash-restore-e1")).toHaveTextContent("Restaurer")
    expect(
      within(screen.getByTestId("knowledge-trash-row-e3")).getByTestId("knowledge-trash-days"),
    ).toHaveTextContent("Conservée")
  })

  it("Restore calls the restore route and the row leaves the list", async () => {
    scopes.add(ARCHIVE)
    const api = makeApi()
    wrap(api, () => <KnowledgeTrashView />)
    fireEvent.click(await screen.findByTestId("knowledge-trash-restore-e2"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/e2/restore", {}),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("knowledge-trash-row-e2")).not.toBeInTheDocument(),
    )
    expect(lastToast()?.message).toContain("Packing list")
  })

  it("non-admin has no permanent delete control", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi(), () => <KnowledgeTrashView />)
    await screen.findByTestId("knowledge-trash-row-e1")
    expect(screen.queryByTestId("knowledge-trash-delete-e1")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-trash-delete-e2")).not.toBeInTheDocument()
  })

  it("admin: Delete for good asks first, then deletes; a kept page has no delete control", async () => {
    scopes.add(ARCHIVE)
    scopes.add(ADMIN)
    const api = makeApi()
    wrap(api, () => <KnowledgeTrashView />)
    fireEvent.click(await screen.findByTestId("knowledge-trash-delete-e1"))
    const dialog = await screen.findByTestId("knowledge-trash-delete-dialog")
    expect(dialog).toHaveTextContent("Price list 2025")
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("knowledge-trash-delete-confirm"))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/knowledge/documents/e1"))
    await waitFor(() =>
      expect(screen.queryByTestId("knowledge-trash-row-e1")).not.toBeInTheDocument(),
    )
    expect(screen.queryByTestId("knowledge-trash-delete-e3")).not.toBeInTheDocument()
  })

  it("Cancel in the delete prompt deletes nothing", async () => {
    scopes.add(ARCHIVE)
    scopes.add(ADMIN)
    const api = makeApi()
    wrap(api, () => <KnowledgeTrashView />)
    fireEvent.click(await screen.findByTestId("knowledge-trash-delete-e2"))
    fireEvent.click(await screen.findByTestId("knowledge-trash-delete-cancel"))
    await waitFor(() =>
      expect(screen.queryByTestId("knowledge-trash-delete-dialog")).not.toBeInTheDocument(),
    )
    expect(api.delete).not.toHaveBeenCalled()
    expect(screen.getByTestId("knowledge-trash-row-e2")).toBeInTheDocument()
  })

  it("a refused delete is said in French from its code, never in the server's English", async () => {
    scopes.add(ARCHIVE)
    scopes.add(ADMIN)
    const api = makeApi()
    api.delete.mockRejectedValueOnce(
      new ApiError("Only an administrator can delete a page for good", 403, "FORBIDDEN"),
    )
    wrap(api, () => <KnowledgeTrashView />, "fr")
    fireEvent.click(await screen.findByTestId("knowledge-trash-delete-e1"))
    fireEvent.click(await screen.findByTestId("knowledge-trash-delete-confirm"))
    await waitFor(() => expect(lastToast()?.type).toBe("error"))
    expect(lastToast()?.message).toBe(
      "Seul un administrateur peut supprimer une page définitivement.",
    )
    expect(screen.getByTestId("knowledge-trash-row-e1")).toBeInTheDocument()
  })

  it("an empty Trash says so", async () => {
    scopes.add(ARCHIVE)
    const api = makeApi()
    api.get.mockImplementation(async () => [])
    wrap(api, () => <KnowledgeTrashView />)
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-trash-empty")).toHaveTextContent("Trash is empty."),
    )
  })
})

describe("Trash entry in the sidebar", () => {
  it("shows Trash with its count to whoever may restore pages", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi(), () => <KnowledgeSidebar />)
    const entry = await screen.findByTestId("knowledge-sidebar-trash")
    await waitFor(() => expect(entry).toHaveTextContent("3"))
  })

  it("without the archive scope there is no Trash entry", async () => {
    wrap(makeApi(), () => <KnowledgeSidebar />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("knowledge-sidebar-trash")).not.toBeInTheDocument()
  })
})

describe("Move to trash on a page", () => {
  const openMenu = () => fireEvent.click(screen.getByTestId("knowledge-doc-menu"))

  it("moves the page to Trash, says so with Undo, and the tab shows its Trash card", async () => {
    scopes.add(ARCHIVE)
    const api = makeApi()
    wrap(api, () => <KnowledgeDocumentView entityId="doc1" />)
    await screen.findByTestId("knowledge-document-view")
    openMenu()
    const item = await screen.findByTestId("knowledge-doc-trash")
    expect(item).toHaveTextContent("Move to trash")
    fireEvent.click(item)
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/doc1/trash", {}),
    )
    await waitFor(() => expect(lastToast()?.action?.label).toBe("Undo"))
    expect(lastToast()?.message).toContain("Return procedure")
    expect(lastToast()?.countdownMs).toBe(10_000)
    expect(await screen.findByTestId("knowledge-doc-trash-card")).toBeInTheDocument()
  })

  it("B3: an archived page opened by link shows Restore and restoring reopens it", async () => {
    scopes.add(ARCHIVE)
    const api = makeApi({ trashed: true })
    wrap(api, () => <KnowledgeDocumentView entityId="doc1" />)
    const card = await screen.findByTestId("knowledge-doc-trash-card")
    expect(card).toHaveTextContent("Return procedure")
    expect(card).toHaveTextContent("28 days left")
    expect(screen.queryByTestId("knowledge-doc-not-found")).not.toBeInTheDocument()
    fireEvent.click(within(card).getByTestId("knowledge-doc-trash-restore"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/doc1/restore", {}),
    )
    expect(await screen.findByTestId("knowledge-document-view")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-doc-trash-card")).not.toBeInTheDocument()
  })

  it("a trashed page the person cannot restore shows the plain not-found", async () => {
    const api = makeApi({ trashed: true })
    api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      throw new ApiError("Knowledge item not found", 404, "NOT_FOUND")
    })
    wrap(api, () => <KnowledgeDocumentView entityId="doc1" />)
    expect(await screen.findByTestId("knowledge-doc-not-found")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-doc-trash-card")).not.toBeInTheDocument()
  })

  it("a synced row has no trash item", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi({ page: { syncedSourceId: "s1" } }), () => (
      <KnowledgeDocumentView entityId="doc1" />
    ))
    await screen.findByTestId("knowledge-document-view")
    openMenu()
    await screen.findByTestId("knowledge-doc-verify")
    expect(screen.queryByTestId("knowledge-doc-trash")).not.toBeInTheDocument()
  })

  it("a reader of the page has no trash item", async () => {
    scopes.add(ARCHIVE)
    wrap(makeApi({ page: { canEdit: false } }), () => <KnowledgeDocumentView entityId="doc1" />)
    await screen.findByTestId("knowledge-document-view")
    openMenu()
    await screen.findByTestId("knowledge-doc-verify")
    expect(screen.queryByTestId("knowledge-doc-trash")).not.toBeInTheDocument()
  })

  it("without the archive scope there is no trash item and no Archive either", async () => {
    wrap(makeApi(), () => <KnowledgeDocumentView entityId="doc1" />)
    await screen.findByTestId("knowledge-document-view")
    openMenu()
    const verify = await screen.findByTestId("knowledge-doc-verify")
    expect(screen.queryByTestId("knowledge-doc-trash")).not.toBeInTheDocument()
    expect(verify.parentElement).not.toHaveTextContent(/archive/i)
  })

  it("a refused move to Trash is said in French from its code", async () => {
    scopes.add(ARCHIVE)
    const api = makeApi()
    wrap(api, () => <KnowledgeDocumentView entityId="doc1" />, "fr")
    await screen.findByTestId("knowledge-document-view")
    api.post.mockRejectedValueOnce(
      new ApiError("This page is synced from another source", 400, "VALIDATION"),
    )
    openMenu()
    fireEvent.click(await screen.findByTestId("knowledge-doc-trash"))
    expect(await screen.findByTestId("knowledge-doc-error")).toHaveTextContent(
      "Cette page est synchronisée depuis une autre source : gérez-la là-bas.",
    )
    expect(screen.getByTestId("knowledge-document-view")).toBeInTheDocument()
  })
})

describe("Undo after Move to trash", () => {
  const t = (key: string, params?: Record<string, string>) =>
    params?.title ? `${key}:${params.title}` : key

  it("Undo within 10 s calls restore; gone at 11 s", async () => {
    vi.useFakeTimers()
    const api = makeApi()
    await moveToTrash(api as never, { id: "doc1", title: "Return procedure" }, t)
    expect(api.post).toHaveBeenCalledWith("/knowledge/documents/doc1/trash", {})
    vi.advanceTimersByTime(9_900)
    const toast = lastToast()
    expect(toast?.action?.label).toBe("knowledge.trash.undo")
    toast?.action?.onClick()
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/knowledge/documents/doc1/restore", {}),
    )

    resetToastStore()
    await moveToTrash(api as never, { id: "doc1", title: "Return procedure" }, t)
    expect(toasts()).toHaveLength(1)
    vi.advanceTimersByTime(11_000)
    expect(toasts()).toHaveLength(0)
  })
})
