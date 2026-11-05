// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import KnowledgeCollectionTree from "./KnowledgeCollectionTree"

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

  it("right-click on a folder opens a context menu with New / Rename / Delete", () => {
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
    expect(screen.getByTestId("knowledge-tree-menu-new-folder")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("knowledge-tree-menu-rename"))
    expect(onRename).toHaveBeenCalledWith("c1")
  })

  it("'New folder' in a folder's context menu passes the folder's ownerUserId (scope inheritance)", () => {
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
    fireEvent.click(screen.getByTestId("knowledge-tree-menu-new-folder"))
    expect(onCreateChild).toHaveBeenCalledWith("c1", "user-1")
  })

  it("'New folder' on an org-shared folder passes null ownerUserId", () => {
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
    fireEvent.click(screen.getByTestId("knowledge-tree-menu-new-folder"))
    expect(onCreateChild).toHaveBeenCalledWith("c1", null)
  })

  it("right-click on a document row exposes a Move to... submenu listing folders", () => {
    const onMove = vi.fn()
    render(() => (
      <KnowledgeCollectionTree
        tree={
          [
            {
              id: "c1",
              name: "Eng",
              parentId: null,
              children: [],
              documents: [{ id: "d1", title: "X" }],
            },
            { id: "c2", name: "Ops", parentId: null, children: [], documents: [] },
          ] as never
        }
        onOpenDoc={() => {}}
        onMoveDoc={onMove}
      />
    ))
    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    fireEvent.contextMenu(screen.getByTestId("knowledge-tree-doc-d1"))
    fireEvent.click(screen.getByTestId("knowledge-tree-move-to-c2"))
    expect(onMove).toHaveBeenCalledWith({
      docId: "d1",
      fromCollectionId: "c1",
      toCollectionId: "c2",
    })
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
    expect(onOpen).toHaveBeenCalledWith("d1")
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
