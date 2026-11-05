// SPDX-License-Identifier: FSL-1.1-ALv2

import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { CollectionTreeNode } from "./knowledge-api"

export interface MoveDocArgs {
  docId: string
  fromCollectionId: string | null
  toCollectionId: string | null
}

export interface KnowledgeCollectionTreeProps {
  tree: CollectionTreeNode[]
  onOpenDoc: (docId: string) => void
  onCreateChild?: (parentId: string | null, ownerUserId: string | null) => void
  onRename?: (id: string) => void
  onArchive?: (id: string) => void
  onMoveDoc?: (args: MoveDocArgs) => void
  onReparentFolder?: (args: { folderId: string; newParentId: string | null }) => void
}

interface FolderMenuState {
  kind: "folder"
  id: string
  x: number
  y: number
}

interface DocMenuState {
  kind: "doc"
  id: string
  fromCollectionId: string | null
  x: number
  y: number
}

type MenuState = FolderMenuState | DocMenuState

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

function flattenFolders(
  tree: CollectionTreeNode[],
  acc: Array<{ id: string; name: string }> = [],
): Array<{ id: string; name: string }> {
  for (const n of tree) {
    if (!n.virtual) acc.push({ id: n.id, name: n.name })
    flattenFolders(n.children, acc)
  }
  return acc
}

interface DragPayload {
  kind: "doc" | "folder"
  id: string
  fromCollectionId: string | null
}

const KnowledgeCollectionTree: Component<KnowledgeCollectionTreeProps> = (props) => {
  const i18n = useI18n()
  const [menu, setMenu] = createSignal<MenuState | null>(null)
  let dragPayload: DragPayload | null = null

  function startDoc(docId: string, fromCollectionId: string | null) {
    dragPayload = { kind: "doc", id: docId, fromCollectionId }
  }

  function startFolder(folderId: string) {
    dragPayload = { kind: "folder", id: folderId, fromCollectionId: null }
  }

  function dropOnto(toCollectionId: string | null) {
    const p = dragPayload
    dragPayload = null
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
      props.onReparentFolder?.({ folderId: p.id, newParentId: toCollectionId })
    }
  }

  function openFolderMenu(node: CollectionTreeNode, e: MouseEvent) {
    if (node.virtual) return
    e.preventDefault()
    setMenu({ kind: "folder", id: node.id, x: e.clientX, y: e.clientY })
  }

  function openDocMenu(docId: string, fromCollectionId: string | null, e: MouseEvent) {
    e.preventDefault()
    setMenu({ kind: "doc", id: docId, fromCollectionId, x: e.clientX, y: e.clientY })
  }

  function closeMenu() {
    setMenu(null)
  }

  const folders = () => flattenFolders(props.tree)

  return (
    <div
      data-testid="knowledge-tree-root"
      onDragOver={(e) => e.preventDefault()}
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
          {(node) => (
            <CollectionRow
              node={node}
              depth={0}
              onOpenDoc={props.onOpenDoc}
              onRename={props.onRename}
              onContextMenu={openFolderMenu}
              onDocContextMenu={openDocMenu}
              onStartDocDrag={startDoc}
              onStartFolderDrag={startFolder}
              onDropOnFolder={dropOnto}
              currentCollectionId={null}
            />
          )}
        </For>
      </ul>
      <Show when={menu()?.kind === "folder" ? (menu() as FolderMenuState) : null}>
        {(m) => (
          <div
            data-testid="knowledge-tree-context-menu"
            class="fixed z-50 min-w-[160px] rounded-md border border-border-subtle bg-surface py-1 shadow-md"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onMouseLeave={closeMenu}
          >
            <MenuItem
              testid="knowledge-tree-menu-new-folder"
              label={i18n.t("knowledge.newFolder")}
              onClick={() => {
                const node = findNode(props.tree, m().id)
                props.onCreateChild?.(m().id, node?.ownerUserId ?? null)
                closeMenu()
              }}
            />
            <MenuItem
              testid="knowledge-tree-menu-rename"
              label={i18n.t("kernel.common.rename")}
              onClick={() => {
                props.onRename?.(m().id)
                closeMenu()
              }}
            />
            <MenuItem
              testid="knowledge-tree-menu-delete"
              label={i18n.t("kernel.common.delete")}
              onClick={() => {
                props.onArchive?.(m().id)
                closeMenu()
              }}
            />
          </div>
        )}
      </Show>
      <Show when={menu()?.kind === "doc" ? (menu() as DocMenuState) : null}>
        {(m) => (
          <div
            data-testid="knowledge-tree-doc-context-menu"
            class="fixed z-50 min-w-[180px] rounded-md border border-border-subtle bg-surface py-1 shadow-md"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onMouseLeave={closeMenu}
          >
            <div class="px-3 py-1 text-[11px] uppercase tracking-wide text-text-tertiary">
              {i18n.t("knowledge.moveTo")}
            </div>
            <For each={folders()}>
              {(f) => (
                <MenuItem
                  testid={`knowledge-tree-move-to-${f.id}`}
                  label={f.name}
                  onClick={() => {
                    props.onMoveDoc?.({
                      docId: m().id,
                      fromCollectionId: m().fromCollectionId,
                      toCollectionId: f.id,
                    })
                    closeMenu()
                  }}
                />
              )}
            </For>
            <MenuItem
              testid="knowledge-tree-move-to-root"
              label={i18n.t("knowledge.unfiled")}
              onClick={() => {
                props.onMoveDoc?.({
                  docId: m().id,
                  fromCollectionId: m().fromCollectionId,
                  toCollectionId: null,
                })
                closeMenu()
              }}
            />
          </div>
        )}
      </Show>
    </div>
  )
}

const MenuItem: Component<{ testid: string; label: string; onClick: () => void }> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    class="block w-full px-3 py-1.5 text-left text-[13px] text-text hover:bg-surface-hover"
    onClick={props.onClick}
  >
    {props.label}
  </button>
)

interface CollectionRowProps {
  node: CollectionTreeNode
  depth: number
  onOpenDoc: (id: string) => void
  onRename?: (id: string) => void
  onContextMenu: (node: CollectionTreeNode, e: MouseEvent) => void
  onDocContextMenu: (docId: string, fromCollectionId: string | null, e: MouseEvent) => void
  onStartDocDrag: (docId: string, fromCollectionId: string | null) => void
  onStartFolderDrag: (folderId: string) => void
  onDropOnFolder: (toCollectionId: string | null) => void
  currentCollectionId: string | null
}

const CollectionRow: Component<CollectionRowProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const hasChildren = () => props.node.children.length > 0 || props.node.documents.length > 0

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "F2" && !props.node.virtual) {
      e.preventDefault()
      props.onRename?.(props.node.id)
    }
  }

  return (
    <li>
      <div
        data-testid={`knowledge-tree-row-${props.node.id}`}
        tabindex={0}
        draggable={!props.node.virtual}
        class="flex items-center gap-1 rounded px-2 py-1 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
        style={{ "padding-left": `${0.5 + props.depth}rem` }}
        onContextMenu={(e) => props.onContextMenu(props.node, e)}
        onKeyDown={onKeyDown}
        onDragStart={(e) => {
          if (props.node.virtual) return
          e.stopPropagation()
          props.onStartFolderDrag(props.node.id)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!props.node.virtual) props.onDropOnFolder(props.node.id)
        }}
      >
        <button
          type="button"
          data-testid={`knowledge-tree-toggle-${props.node.id}`}
          onClick={() => setOpen(!open())}
          class="shrink-0 text-text-tertiary"
        >
          <Show when={open()} fallback={<ChevronRight size={12} />}>
            <ChevronDown size={12} />
          </Show>
        </button>
        <Folder size={12} class="shrink-0 text-text-tertiary" />
        <span data-testid={`knowledge-tree-folder-${props.node.id}`} class="text-[13px] text-text">
          {props.node.name}
        </span>
        <Show when={props.node.syncedSourceId}>
          <span
            data-testid={`knowledge-collection-synced-badge-${props.node.id}`}
            class="ml-1 text-[10px] text-text-tertiary opacity-70"
            title={i18n.t("knowledge.syncedFromExternalSource")}
            role="img"
            aria-label={i18n.t("knowledge.syncedCollection")}
          >
            ☁
          </span>
        </Show>
      </div>
      <Show when={open() && hasChildren()}>
        <ul>
          <For each={props.node.children}>
            {(c) => (
              <CollectionRow
                node={c}
                depth={props.depth + 1}
                onOpenDoc={props.onOpenDoc}
                onRename={props.onRename}
                onContextMenu={props.onContextMenu}
                onDocContextMenu={props.onDocContextMenu}
                onStartDocDrag={props.onStartDocDrag}
                onStartFolderDrag={props.onStartFolderDrag}
                onDropOnFolder={props.onDropOnFolder}
                currentCollectionId={props.node.virtual ? null : props.node.id}
              />
            )}
          </For>
          <For each={props.node.documents}>
            {(d) => (
              <li
                class="flex cursor-pointer items-center gap-1 rounded px-2 py-1 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
                style={{ "padding-left": `${1.5 + props.depth}rem` }}
                data-testid={`knowledge-tree-doc-${d.id}`}
                tabindex={0}
                draggable={true}
                onClick={() => props.onOpenDoc(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    props.onOpenDoc(d.id)
                  }
                }}
                onContextMenu={(e) =>
                  props.onDocContextMenu(d.id, props.node.virtual ? null : props.node.id, e)
                }
                onDragStart={(e) => {
                  e.stopPropagation()
                  props.onStartDocDrag(d.id, props.node.virtual ? null : props.node.id)
                }}
              >
                <FileText size={12} class="shrink-0 text-text-tertiary" />
                <span class="text-[13px] text-text">{d.title}</span>
                <Show when={d.syncedSourceId}>
                  <span
                    data-testid={`knowledge-tree-doc-synced-badge-${d.id}`}
                    class="ml-1 text-[10px] text-text-tertiary opacity-70"
                    title={i18n.t("knowledge.syncedFromExternalSource")}
                    role="img"
                    aria-label={i18n.t("knowledge.syncedDocument")}
                  >
                    ☁
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  )
}

export default KnowledgeCollectionTree
