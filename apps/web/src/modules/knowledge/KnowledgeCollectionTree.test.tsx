// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import KnowledgeCollectionTree from "./KnowledgeCollectionTree"
import KnowledgeSidebar from "./KnowledgeSidebar"
import { resetKnowledgeStore } from "./knowledge-store"

afterEach(() => {
  resetKnowledgeStore()
  resetToastStore()
  clearAuth()
})

/** Choose an item of an open row menu (Kobalte selects on Enter). */
async function choose(testid: string) {
  const item = await screen.findByTestId(testid)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}

function jwt(payload: Record<string, unknown>): string {
  return `${btoa(JSON.stringify({ alg: "HS256" }))}.${btoa(JSON.stringify(payload))}.sig`
}

const tree = [
  {
    id: "c1",
    name: "Eng",
    parentId: null,
    documents: [],
    children: [
      {
        id: "c2",
        name: "RFCs",
        parentId: "c1",
        documents: [{ id: "d1", title: "RFC-001" }],
        children: [],
      },
    ],
  },
  {
    id: "c3",
    name: "Ops",
    parentId: null,
    documents: [{ id: "d2", title: "Runbook" }],
    children: [],
  },
]

describe("KnowledgeCollectionTree", () => {
  it("renders root folders + nested collapsed by default", () => {
    render(() => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={() => {}} />)
    expect(screen.getByTestId("knowledge-tree-folder-c1").textContent).toContain("Eng")
    expect(screen.getByTestId("knowledge-tree-folder-c3").textContent).toContain("Ops")
    expect(screen.queryByTestId("knowledge-tree-folder-c2")).not.toBeInTheDocument()
  })

  it("clicking the chevron expands and reveals children", () => {
    render(() => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={() => {}} />)
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    expect(screen.getByTestId("knowledge-tree-folder-c2")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c2"))
    expect(screen.getByTestId("knowledge-tree-doc-d1").textContent).toContain("RFC-001")
  })

  it("marks an externally-synced document leaf with a cloud badge (local docs unmarked)", () => {
    const synced = [
      {
        id: "c1",
        name: "GitLab Handbook",
        parentId: null,
        syncedSourceId: "ss-1",
        children: [],
        documents: [
          { id: "d1", title: "manual.md", syncedSourceId: "ss-1" },
          { id: "d2", title: "local note", syncedSourceId: null },
        ],
      },
    ]
    render(() => <KnowledgeCollectionTree tree={synced as never} onOpenDoc={() => {}} />)
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    expect(screen.getByTestId("knowledge-tree-doc-synced-badge-d1")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-tree-doc-synced-badge-d2")).not.toBeInTheDocument()
  })

  it("right-click on a folder opens its menu: New page, New folder, Rename, Move, Delete", async () => {
    const onCreateChild = vi.fn()
    const onRename = vi.fn()
    const onArchive = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={[{ id: "c1", name: "Eng", parentId: null, children: [], documents: [] }] as never}
        onOpenDoc={() => {}}
        onCreateChild={onCreateChild}
        onRename={onRename}
        onArchive={onArchive}
      />
    ))
    const folder = screen.getByTestId("knowledge-tree-folder-c1")
    fireEvent.contextMenu(folder)
    expect(await screen.findByTestId("knowledge-tree-menu-new-folder")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-tree-menu-new-page")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-tree-menu-move")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-tree-menu-delete")).toBeInTheDocument()
    await choose("knowledge-tree-menu-rename")
    expect(onRename).toHaveBeenCalledWith("c1")
  })

  it("'New folder' in a folder's context menu passes the folder's ownerUserId (scope inheritance)", async () => {
    const onCreateChild = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "Personal Notes",
              parentId: null,
              ownerUserId: "user-1",
              children: [],
              documents: [],
            },
          ] as never
        }
        onOpenDoc={() => {}}
        onCreateChild={onCreateChild}
      />
    ))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-folder-c1"))
    await choose("knowledge-tree-menu-new-folder")
    expect(onCreateChild).toHaveBeenCalledWith("c1", "user-1")
  })

  it("'New folder' on an org-shared folder passes null ownerUserId", async () => {
    const onCreateChild = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "Shared Docs",
              parentId: null,
              ownerUserId: null,
              children: [],
              documents: [],
            },
          ] as never
        }
        onOpenDoc={() => {}}
        onCreateChild={onCreateChild}
      />
    ))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-folder-c1"))
    await choose("knowledge-tree-menu-new-folder")
    expect(onCreateChild).toHaveBeenCalledWith("c1", null)
  })

  it("a page's menu offers Rename, Move to, Copy link, and Archive only with the scope", async () => {
    const onMoveRequest = vi.fn()
    const page = [
      {
        id: "c1",
        name: "Eng",
        parentId: null,
        children: [],
        documents: [{ id: "d1", title: "X" }],
      },
    ]
    const { unmount } = render(() => (
      <KnowledgeCollectionTree
        tree={page as never}
        onOpenDoc={() => {}}
        onMoveRequest={onMoveRequest}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    expect(await screen.findByTestId("knowledge-tree-menu-rename")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-tree-menu-copy-link")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-tree-menu-archive")).toBeNull()
    await choose("knowledge-tree-menu-move")
    expect(onMoveRequest).toHaveBeenCalledWith({
      kind: "doc",
      id: "d1",
      title: "X",
      fromCollectionId: "c1",
    })
    unmount()
    render(() => (
      <KnowledgeCollectionTree tree={page as never} onOpenDoc={() => {}} canArchiveDocs />
    ))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    expect(await screen.findByTestId("knowledge-tree-menu-archive")).toBeInTheDocument()
  })

  it("+ on a folder creates with collectionIds=[id]", async () => {
    setTokens(jwt({ sub: "me", userId: "me", orgId: "o1", scopes: ["*"] }), "r")
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
                documents: [],
              },
            ]
          : [],
      ),
      post: vi.fn(async () => ({ id: "new-doc", title: "Untitled" })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    fireEvent.click(await screen.findByTestId("knowledge-tree-new-page-c1"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/knowledge/documents",
        expect.objectContaining({ collectionIds: ["c1"], documentScope: "organization" }),
      ),
    )
  })

  it("menu opens by click, Enter and touch, Escape returns focus", async () => {
    render(() => (
      <KnowledgeCollectionTree
        tree={[{ id: "c1", name: "Eng", parentId: null, children: [], documents: [] }] as never}
        onOpenDoc={() => {}}
      />
    ))
    const trigger = screen.getByTestId("knowledge-tree-menu-c1")
    // Mouse: a primary-button press.
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 })
    expect(await screen.findByTestId("knowledge-tree-menu-rename")).toBeInTheDocument()
    // Escape closes it and gives focus back to the "…" button.
    fireEvent.keyDown(screen.getByTestId("knowledge-tree-menu-rename"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("knowledge-tree-menu-rename")).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
    // Keyboard.
    fireEvent.keyDown(trigger, { key: "Enter" })
    expect(await screen.findByTestId("knowledge-tree-menu-rename")).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId("knowledge-tree-menu-rename"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("knowledge-tree-menu-rename")).toBeNull())
    // Touch: the tap's press, then its click.
    fireEvent.pointerDown(trigger, { pointerType: "touch", button: 0 })
    fireEvent.click(trigger)
    expect(await screen.findByTestId("knowledge-tree-menu-rename")).toBeInTheDocument()
    // Leaving it with the pointer does not close it.
    fireEvent.pointerLeave(screen.getByTestId("knowledge-tree-menu-rename"))
    fireEvent.mouseLeave(screen.getByTestId("knowledge-tree-menu-rename"))
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.getByTestId("knowledge-tree-menu-rename")).toBeInTheDocument()
  })

  it("refused move shows the server message and the row stays", async () => {
    setTokens(jwt({ sub: "me", userId: "me", orgId: "o1", scopes: ["*"] }), "r")
    const tree = [
      {
        id: "c1",
        name: "Policies",
        parentId: null,
        ownerUserId: null,
        children: [],
        documents: [{ id: "d1", title: "Warranty" }],
      },
      {
        id: "c2",
        name: "Handbook",
        parentId: null,
        ownerUserId: null,
        children: [],
        documents: [],
      },
    ]
    const api = {
      get: vi.fn(async (path: string) => (path === "/knowledge/collections/tree" ? tree : [])),
      post: vi.fn(async (path: string) => {
        if (path === "/knowledge/documents/d1/move")
          throw new ApiError("You cannot do this on this page", 404, "NOT_FOUND")
        return {}
      }),
      delete: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    fireEvent.click(await screen.findByTestId("knowledge-tree-toggle-c1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    await choose("knowledge-tree-menu-move")
    fireEvent.click(await screen.findByTestId("knowledge-move-to-c2"))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain("You cannot do this on this page"),
    )
    // One request, never a remove then an add.
    expect(api.post).toHaveBeenCalledWith("/knowledge/documents/d1/move", {
      fromCollectionId: "c1",
      toCollectionId: "c2",
    })
    expect(api.delete).not.toHaveBeenCalled()
    expect(screen.getByTestId("knowledge-tree-doc-d1")).toBeInTheDocument()
  })

  it("B9: the section + is visible without focus, a folder name click opens or toggles it", async () => {
    const api = { get: vi.fn(async () => []), post: vi.fn() }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeSidebar />
      </ApiContext.Provider>
    ))
    for (const id of [
      "knowledge-sidebar-personal-new-folder",
      "knowledge-sidebar-shared-new-folder",
    ]) {
      expect(screen.getByTestId(id).className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    }
    resetKnowledgeStore()
    render(() => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={() => {}} />)
    fireEvent.click(screen.getByTestId("knowledge-tree-folder-c1"))
    expect(screen.getByTestId("knowledge-tree-folder-c2")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("knowledge-tree-folder-c1"))
    expect(screen.queryByTestId("knowledge-tree-folder-c2")).toBeNull()
  })

  it("dropping a document onto a folder calls onMoveDoc with the right ids", () => {
    const onMove = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "A",
              parentId: null,
              children: [],
              documents: [{ id: "d1", title: "X" }],
            },
            { id: "c2", name: "B", parentId: null, children: [], documents: [] },
          ] as never
        }
        onOpenDoc={() => {}}
        onMoveDoc={onMove}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    const docEl = screen.getByTestId("knowledge-tree-doc-d1")
    const folderB = screen.getByTestId("knowledge-tree-row-c2") as HTMLElement
    fireEvent.dragStart(docEl)
    fireEvent.dragOver(folderB)
    fireEvent.drop(folderB)
    expect(onMove).toHaveBeenCalledWith({
      docId: "d1",
      fromCollectionId: "c1",
      toCollectionId: "c2",
    })
  })

  it("dropping a document on the tree root removes it from its current folder", () => {
    const onMove = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "A",
              parentId: null,
              children: [],
              documents: [{ id: "d1", title: "X" }],
            },
          ] as never
        }
        onOpenDoc={() => {}}
        onMoveDoc={onMove}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-doc-d1"))
    const root = screen.getByTestId("knowledge-tree-root")
    fireEvent.dragOver(root)
    fireEvent.drop(root)
    expect(onMove).toHaveBeenCalledWith({
      docId: "d1",
      fromCollectionId: "c1",
      toCollectionId: null,
    })
  })

  it("dropping a folder onto another folder reparents it", () => {
    const onReparent = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            { id: "c1", name: "A", parentId: null, children: [], documents: [] },
            { id: "c2", name: "B", parentId: null, children: [], documents: [] },
          ] as never
        }
        onOpenDoc={() => {}}
        onReparentFolder={onReparent}
      />
    ))
    const a = screen.getByTestId("knowledge-tree-row-c1")
    const b = screen.getByTestId("knowledge-tree-row-c2")
    fireEvent.dragStart(a)
    fireEvent.dragOver(b)
    fireEvent.drop(b)
    expect(onReparent).toHaveBeenCalledWith({ folderId: "c1", newParentId: "c2" })
  })

  it("dropping a folder on the tree root clears its parent", () => {
    const onReparent = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "A",
              parentId: null,
              documents: [],
              children: [{ id: "c2", name: "B", parentId: "c1", documents: [], children: [] }],
            },
          ] as never
        }
        onOpenDoc={() => {}}
        onReparentFolder={onReparent}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-row-c2"))
    fireEvent.drop(screen.getByTestId("knowledge-tree-root"))
    expect(onReparent).toHaveBeenCalledWith({ folderId: "c2", newParentId: null })
  })

  it("does not dispatch reparent when target is a descendant of the source (cycle)", () => {
    const onReparent = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "A",
              parentId: null,
              documents: [],
              children: [{ id: "c2", name: "B", parentId: "c1", documents: [], children: [] }],
            },
          ] as never
        }
        onOpenDoc={() => {}}
        onReparentFolder={onReparent}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.dragStart(screen.getByTestId("knowledge-tree-row-c1"))
    fireEvent.drop(screen.getByTestId("knowledge-tree-row-c2"))
    expect(onReparent).not.toHaveBeenCalled()
  })

  it("arrow keys traverse the flat visible order of folders + docs", () => {
    render(() => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={() => {}} />)
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c2"))
    const c1 = screen.getByTestId("knowledge-tree-row-c1") as HTMLElement
    c1.focus()
    fireEvent.keyDown(c1, { key: "ArrowDown" })
    expect(document.activeElement?.getAttribute("data-testid")).toBe("knowledge-tree-row-c2")
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(document.activeElement?.getAttribute("data-testid")).toBe("knowledge-tree-doc-d1")
  })

  it("Enter on a focused doc opens it via onOpenDoc", () => {
    const onOpen = vi.fn()
    render(() => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={onOpen} />)
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c2"))
    const doc = screen.getByTestId("knowledge-tree-doc-d1") as HTMLElement
    doc.focus()
    fireEvent.keyDown(doc, { key: "Enter" })
    expect(onOpen).toHaveBeenCalledWith("d1", "RFC-001")
  })

  it("F2 on a focused folder triggers rename callback", () => {
    const onRename = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={[{ id: "c1", name: "Eng", parentId: null, children: [], documents: [] }] as never}
        onOpenDoc={() => {}}
        onRename={onRename}
      />
    ))
    const row = screen.getByTestId("knowledge-tree-row-c1") as HTMLElement
    row.focus()
    fireEvent.keyDown(row, { key: "F2" })
    expect(onRename).toHaveBeenCalledWith("c1")
  })
})
