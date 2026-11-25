// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Link,
  Pencil,
  Plus,
  Trash2,
} from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import type { CollectionTreeNode } from "./knowledge-api"
import {
  isFolderOpen,
  setTreeDrag,
  setTreeDropTarget,
  toggleFolder,
  treeDrag,
  treeDropTarget,
} from "./knowledge-store"
import RowMenu, { type RowMenuItem } from "./RowMenu"

export interface MoveDocArgs {
  docId: string
  fromCollectionId: string | null
  toCollectionId: string | null
}

export interface ReparentFolderArgs {
  folderId: string
  newParentId: string | null
  /** Set on a drop at a section's top level: the section it lands in. */
  section?: "personal" | "shared"
}

/** What "Move to…" was chosen on. */
export type MoveRequest =
  | { kind: "doc"; id: string; title: string; fromCollectionId: string | null }
  | { kind: "folder"; id: string; title: string }

export interface KnowledgeCollectionTreeProps {
  tree: CollectionTreeNode[]
  /** The sidebar section this tree draws; a drop on its top level lands there. */
  section?: "personal" | "shared"
  /** The page open in the active tab: its row is marked. */
  activeDocId?: string | null
  onOpenDoc: (docId: string, title?: string) => void
  /** A folder's name opens its folder page (the chevron shows what is inside). */
  onOpenFolder?: (id: string, name: string) => void
  onCreateChild?: (parentId: string | null, ownerUserId: string | null) => void
  /** "+" on a folder row: a new page in it (`personal` for a folder of mine). */
  onNewPage?: (folderId: string | null, personal: boolean) => void
  onRename?: (id: string) => void
  onRenameDoc?: (docId: string) => void
  /** Delete a folder (its content moves to its parent). */
  onArchive?: (id: string) => void
  /** Move a page to Trash (with its Undo). */
  onTrashDoc?: (docId: string, title: string) => void
  /** Move to trash is offered only to holders of the archive scope. */
  canTrashDocs?: boolean
  /** May the reader make, rename, move and delete folders, and file pages in
   *  them? The sidebar passes the reader's scopes; left out, it is allowed. */
  canManageFolders?: boolean
  /** May the reader make pages? As `canManageFolders`. */
  canCreatePages?: boolean
  onCopyLink?: (docId: string) => void
  onMoveRequest?: (item: MoveRequest) => void
  onMoveDoc?: (args: MoveDocArgs) => void
  onReparentFolder?: (args: ReparentFolderArgs) => void
}

function findNode(tree: CollectionTreeNode[], id: string): CollectionTreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n
    const c = findNode(n.children, id)
    if (c) return c
  }
  return null
}

function isDescendant(
  tree: CollectionTreeNode[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const ancestor = findNode(tree, ancestorId)
  if (!ancestor) return false
  const stack = [...ancestor.children]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.id === candidateId) return true
    stack.push(...n.children)
  }
  return false
}

/** The root drop zone's id in the shared drag state. */
const rootDropId = (section: string | undefined) => `__root__:${section ?? "tree"}`

const KnowledgeCollectionTree: Component<KnowledgeCollectionTreeProps> = (props) => {
  function dropOnto(toCollectionId: string | null) {
    const p = treeDrag()
    setTreeDrag(null)
    setTreeDropTarget(null)
    if (!p) return
    if (p.kind === "doc") {
      if (p.fromCollectionId === toCollectionId) return
      props.onMoveDoc?.({
        docId: p.id,
        fromCollectionId: p.fromCollectionId,
        toCollectionId,
      })
    } else if (p.kind === "folder") {
      if (p.id === toCollectionId) return
      if (toCollectionId && isDescendant(props.tree, p.id, toCollectionId)) return
      props.onReparentFolder?.({
        folderId: p.id,
        newParentId: toCollectionId,
        ...(toCollectionId === null && props.section ? { section: props.section } : {}),
      })
    }
  }

  return (
    <div
      data-testid="knowledge-tree-root"
      classList={{
        "rounded ring-1 ring-accent/40": treeDropTarget() === rootDropId(props.section),
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (treeDrag()) setTreeDropTarget(rootDropId(props.section))
      }}
      onDrop={(e) => {
        e.preventDefault()
        dropOnto(null)
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
        const root = e.currentTarget as HTMLElement
        const rows = Array.from(
          root.querySelectorAll<HTMLElement>(
            '[data-testid^="knowledge-tree-row-"], [data-testid^="knowledge-tree-doc-"]',
          ),
        ).filter((el) => el.tabIndex >= 0)
        const active = document.activeElement as HTMLElement | null
        const idx = active ? rows.indexOf(active) : -1
        if (idx === -1) return
        const next = e.key === "ArrowDown" ? rows[idx + 1] : rows[idx - 1]
        if (next) {
          e.preventDefault()
          next.focus()
        }
      }}
    >
      <ul class="flex flex-col gap-0.5">
        <For each={props.tree}>
          {(node) => <CollectionRow node={node} depth={0} tree={props} onDrop={dropOnto} />}
        </For>
      </ul>
    </div>
  )
}

/** Hover and focus show a row's buttons on desktop; a finger always sees them. */
/** On touch a row's buttons are a finger's size (44px), set here because the
 *  phone navigator sheet sits outside the shell that carries the touch floor. */
function rowButtonClass(): string {
  const base =
    "flex shrink-0 items-center justify-center rounded text-text-tertiary transition-opacity hover:bg-surface-active hover:text-text-secondary"
  return shellTier() === "desktop"
    ? `${base} h-5 w-5 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[expanded]:opacity-100 pointer-coarse:opacity-100`
    : `${base} h-11 w-11`
}

function toggleClass(): string {
  return shellTier() === "desktop"
    ? "shrink-0 text-text-tertiary"
    : "flex h-11 w-11 shrink-0 items-center justify-center text-text-tertiary"
}

interface CollectionRowProps {
  node: CollectionTreeNode
  depth: number
  tree: KnowledgeCollectionTreeProps
  onDrop: (toCollectionId: string | null) => void
}

const CollectionRow: Component<CollectionRowProps> = (props) => {
  const i18n = useI18n()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const node = () => props.node
  const open = () => isFolderOpen(node().id)
  const hasChildren = () => node().children.length > 0 || node().documents.length > 0
  const synced = () => Boolean(node().syncedSourceId)
  /** Folders hold the reader's own name; the two buckets are named here. */
  const name = () =>
    node().kind === "personal_notes" || node().id === "__personal_notes__"
      ? i18n.t("knowledge.personalNotes")
      : node().kind === "unfiled" || node().id === "__unfiled__"
        ? i18n.t("knowledge.unfiled")
        : node().name
  const isPersonalBucket = () =>
    node().kind === "personal_notes" || node().id === "__personal_notes__"
  const manage = () => props.tree.canManageFolders !== false
  const create = () => props.tree.canCreatePages !== false
  /** A page made in a real folder is filed there: both rights. */
  const canNewPage = () => create() && (node().virtual ? isPersonalBucket() : !synced() && manage())
  /** The folder's own menu: never on a bucket or a synced tree. */
  const hasMenu = () => !node().virtual && !synced() && manage()
  const ownerOf = () => node().ownerUserId ?? null

  const folderItems = (): RowMenuItem[] => {
    const t = props.tree
    const id = node().id
    return [
      ...(create()
        ? [
            {
              id: "new-page",
              label: i18n.t("knowledge.newPage"),
              icon: FilePlus,
              onSelect: () => t.onNewPage?.(id, ownerOf() !== null),
            },
          ]
        : []),
      {
        id: "new-folder",
        label: i18n.t("knowledge.newFolder"),
        icon: FolderPlus,
        onSelect: () => t.onCreateChild?.(id, ownerOf()),
      },
      {
        id: "rename",
        label: i18n.t("kernel.common.rename"),
        icon: Pencil,
        separatorBefore: true,
        onSelect: () => t.onRename?.(id),
      },
      {
        id: "move",
        label: i18n.t("knowledge.moveToEllipsis"),
        icon: FolderInput,
        onSelect: () => t.onMoveRequest?.({ kind: "folder", id, title: node().name }),
      },
      {
        id: "delete",
        label: i18n.t("knowledge.deleteFolder"),
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        onSelect: () => t.onArchive?.(id),
      },
    ]
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return
    if (e.key === "F2" && hasMenu()) {
      e.preventDefault()
      props.tree.onRename?.(node().id)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      toggleFolder(node().id)
    }
  }

  return (
    <li>
      <div
        data-testid={`knowledge-tree-row-${node().id}`}
        tabindex={0}
        draggable={hasMenu()}
        class="group/row flex items-center gap-1 rounded px-2 py-1 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
        classList={{
          "bg-surface-active ring-1 ring-accent/40":
            !node().virtual && treeDropTarget() === node().id,
        }}
        style={{ "padding-left": `${0.5 + props.depth}rem` }}
        onContextMenu={(e) => {
          if (!hasMenu()) return
          e.preventDefault()
          setMenuOpen(true)
        }}
        onKeyDown={onKeyDown}
        onDragStart={(e) => {
          if (!hasMenu()) return
          e.stopPropagation()
          setTreeDrag({ kind: "folder", id: node().id, fromCollectionId: null })
        }}
        onDragEnd={() => {
          setTreeDrag(null)
          setTreeDropTarget(null)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (treeDrag() && !node().virtual) setTreeDropTarget(node().id)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!node().virtual) props.onDrop(node().id)
          else {
            setTreeDrag(null)
            setTreeDropTarget(null)
          }
        }}
      >
        <span data-keep-navigator class="flex shrink-0">
          <button
            type="button"
            data-testid={`knowledge-tree-toggle-${node().id}`}
            aria-label={i18n.t(open() ? "knowledge.closeFolder" : "knowledge.folderPage.showInside", {
              name: name(),
            })}
            aria-expanded={open() ? "true" : "false"}
            onClick={() => toggleFolder(node().id)}
            class={toggleClass()}
          >
            <Show when={open()} fallback={<ChevronRight size={12} />}>
              <ChevronDown size={12} />
            </Show>
          </button>
        </span>
        {/* The name opens the folder's page; a virtual bucket only folds. */}
        <button
          type="button"
          data-keep-navigator
          // The row itself is the keyboard stop; this is its pointer target.
          tabIndex={-1}
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left outline-none"
          onClick={() => {
            // Unfiled and the personal-notes bucket are not folders: they only fold.
            if (node().virtual || !props.tree.onOpenFolder) toggleFolder(node().id)
            else props.tree.onOpenFolder(node().id, name())
          }}
        >
          <Folder size={12} class="shrink-0 text-text-tertiary" />
          <span
            data-testid={`knowledge-tree-folder-${node().id}`}
            class="min-w-0 truncate text-[13px] text-text"
          >
            {name()}
          </span>
        </button>
        <Show when={node().syncedSourceId}>
          <span
            data-testid={`knowledge-collection-synced-badge-${node().id}`}
            class="ml-1 text-[10px] text-text-tertiary opacity-70"
            title={i18n.t("knowledge.syncedFromExternalSource")}
            role="img"
            aria-label={i18n.t("knowledge.syncedCollection")}
          >
            ☁
          </span>
        </Show>
        <Show when={canNewPage() && props.tree.onNewPage}>
          <button
            type="button"
            data-testid={`knowledge-tree-new-page-${node().id}`}
            aria-label={i18n.t("knowledge.newPageIn", { name: name() })}
            title={i18n.t("knowledge.newPageIn", { name: name() })}
            class={rowButtonClass()}
            onClick={() =>
              props.tree.onNewPage?.(
                node().virtual ? null : node().id,
                isPersonalBucket() || ownerOf() !== null,
              )
            }
          >
            <Plus size={12} />
          </button>
        </Show>
        <Show when={hasMenu()}>
          <RowMenu
            label={i18n.t("knowledge.actionsFor", { name: name() })}
            triggerTestId={`knowledge-tree-menu-${node().id}`}
            items={folderItems()}
            open={menuOpen()}
            onOpenChange={setMenuOpen}
            triggerClass={rowButtonClass()}
          />
        </Show>
      </div>
      <Show when={open() && hasChildren()}>
        <ul>
          <For each={node().children}>
            {(c) => (
              <CollectionRow
                node={c}
                depth={props.depth + 1}
                tree={props.tree}
                onDrop={props.onDrop}
              />
            )}
          </For>
          <For each={node().documents}>
            {(d) => (
              <DocRow
                doc={d}
                depth={props.depth}
                folderId={node().virtual ? null : node().id}
                tree={props.tree}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  )
}

const DocRow: Component<{
  doc: CollectionTreeNode["documents"][number]
  depth: number
  folderId: string | null
  tree: KnowledgeCollectionTreeProps
}> = (props) => {
  const i18n = useI18n()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const active = () => props.tree.activeDocId === props.doc.id
  const synced = () => Boolean(props.doc.syncedSourceId)
  /** Rename, move and Move to trash need the right to edit the page (the server
   *  says, per page); moving also needs the folder right. */
  const editable = () => !synced() && props.doc.canEdit !== false
  const movable = () => editable() && props.tree.canManageFolders !== false
  const items = (): RowMenuItem[] => {
    const t = props.tree
    const id = props.doc.id
    const copy: RowMenuItem = {
      id: "copy-link",
      label: i18n.t("knowledge.copyLink"),
      icon: Link,
      onSelect: () => t.onCopyLink?.(id),
    }
    if (!editable()) return [copy]
    return [
      {
        id: "rename",
        label: i18n.t("kernel.common.rename"),
        icon: Pencil,
        onSelect: () => t.onRenameDoc?.(id),
      },
      ...(movable()
        ? [
            {
              id: "move",
              label: i18n.t("knowledge.moveToEllipsis"),
              icon: FolderInput,
              onSelect: () =>
                t.onMoveRequest?.({
                  kind: "doc",
                  id,
                  title: props.doc.title,
                  fromCollectionId: props.folderId,
                }),
            },
          ]
        : []),
      copy,
      ...(t.canTrashDocs
        ? [
            {
              id: "trash",
              label: i18n.t("knowledge.trash.moveToTrash"),
              icon: Trash2,
              separatorBefore: true,
              onSelect: () => t.onTrashDoc?.(id, props.doc.title),
            },
          ]
        : []),
    ]
  }

  return (
    <li
      class="group/row flex cursor-pointer items-center gap-1 rounded px-2 py-1 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
      classList={{ "bg-surface-active font-medium": active() }}
      style={{ "padding-left": `${1.5 + props.depth}rem` }}
      data-testid={`knowledge-tree-doc-${props.doc.id}`}
      aria-current={active() ? "page" : undefined}
      tabindex={0}
      draggable={movable()}
      onClick={(e) => {
        // The menu's items are portalled out of the row, but Solid hands their
        // clicks to it all the same: only a click inside the row's own DOM, and
        // not on its "…" button, opens the page.
        const target = e.target
        if (!(target instanceof Node) || !e.currentTarget.contains(target)) return
        if (target instanceof Element && target.closest("[data-row-menu]")) return
        props.tree.onOpenDoc(props.doc.id, props.doc.title)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter") {
          e.preventDefault()
          props.tree.onOpenDoc(props.doc.id, props.doc.title)
        } else if (e.key === "F2" && editable()) {
          e.preventDefault()
          props.tree.onRenameDoc?.(props.doc.id)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
      onDragStart={(e) => {
        e.stopPropagation()
        if (!movable()) return
        setTreeDrag({ kind: "doc", id: props.doc.id, fromCollectionId: props.folderId })
      }}
      onDragEnd={() => {
        setTreeDrag(null)
        setTreeDropTarget(null)
      }}
    >
      <FileText size={12} class="shrink-0 text-text-tertiary" />
      <span class="min-w-0 flex-1 truncate text-[13px] text-text">{props.doc.title}</span>
      <Show when={props.doc.syncedSourceId}>
        <span
          data-testid={`knowledge-tree-doc-synced-badge-${props.doc.id}`}
          class="ml-1 text-[10px] text-text-tertiary opacity-70"
          title={i18n.t("knowledge.syncedFromExternalSource")}
          role="img"
          aria-label={i18n.t("knowledge.syncedDocument")}
        >
          ☁
        </span>
      </Show>
      {/* The menu's clicks are its own, never "open this page" (see onClick). */}
      <span data-row-menu class="flex shrink-0">
        <RowMenu
          label={i18n.t("knowledge.actionsFor", { name: props.doc.title })}
          triggerTestId={`knowledge-tree-doc-menu-${props.doc.id}`}
          items={items()}
          open={menuOpen()}
          onOpenChange={setMenuOpen}
          triggerClass={rowButtonClass()}
        />
      </span>
    </li>
  )
}

export default KnowledgeCollectionTree
