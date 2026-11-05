// SPDX-License-Identifier: FSL-1.1-ALv2
// A tree block (S14): drag to reorder and re-parent, inline rename on click,
// collapse, a row menu (Rename, Add inside, Move up/down, Move to…, Archive) as
// the keyboard path, add at each allowed level, and ONE dirty Save/Discard bar
// that sends the whole tree to the reorder tool on the version it was loaded
// at; a 409 means someone else saved first. No numeric order fields, no
// per-row Save.
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import { DirtyBar } from "./DirtyBar"
import { useAppPage } from "./page-context"
import { callAppTool, rowsOf } from "./settings-api"
import {
  canMove,
  cloneTree,
  countChanges,
  findNode,
  indexTree,
  type MoveTarget,
  moveNode,
  removeSubtree,
  renameNode,
  reorderPayload,
  type SavedIndex,
  shiftNode,
  type TreeNode,
  treeFromRows,
} from "./tree-model"
import type { SettingsTreeBlock } from "./types"

const P = "kernel.settingsPage"

const CONFLICT_CODES = new Set(["conflict", "version_conflict", "stale_version", "stale"])

interface Loaded {
  version: unknown
  roots: TreeNode[]
}

export const TreeBlock: Component<{
  app: string
  block: SettingsTreeBlock
  blockId: string
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const page = useAppPage()
  const [loaded, { refetch }] = createResource(
    () => page?.reloadToken() ?? 0,
    async (): Promise<Loaded> => {
      const out = await callAppTool(api, props.app, props.block.ops.list, {})
      if (out.kind !== "ok") throw new Error(out.kind === "error" ? out.message : "pending")
      const data = out.data
      const version =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? ((data as { version?: unknown }).version ?? null)
          : null
      return { version, roots: treeFromRows(rowsOf(data)) }
    },
  )

  const [roots, setRoots] = createSignal<TreeNode[]>([])
  const [saved, setSaved] = createSignal<SavedIndex>(new Map())
  const [archived, setArchived] = createSignal<TreeNode[]>([])
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = createSignal<string | null>(null)
  const [editText, setEditText] = createSignal("")
  const [dragKey, setDragKey] = createSignal<string | null>(null)
  const [overKey, setOverKey] = createSignal<string | null>(null)
  const [conflict, setConflict] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  let tempCounter = 0

  function reset(data: Loaded): void {
    setRoots(data.roots)
    setSaved(indexTree(data.roots))
    setArchived([])
    setEditing(null)
    setConflict(false)
    setSaveError(null)
  }
  // A fresh load replaces the local tree (the edit is gone either way: saved or discarded).
  createEffect(on(loaded, (data) => data && reset(data)))

  const changeCount = () => countChanges(saved(), roots(), archived())
  const dirty = () => changeCount() > 0
  createEffect(() => page?.setDirty(props.blockId, dirty()))

  const maxDepth = () => props.block.maxDepth

  function apply(next: TreeNode[] | null, refusedHint?: boolean): void {
    if (next) {
      setRoots(next)
      setPending(false)
    } else if (refusedHint) {
      addToast({ message: i18n.t(`${P}.tooDeep`, { max: maxDepth() }), type: "info" })
    }
  }

  function move(key: string, target: MoveTarget): void {
    const self = target.beforeKey === key || target.parentKey === key
    apply(moveNode(roots(), key, target, maxDepth()), !self)
  }

  function startRename(node: TreeNode): void {
    setEditing(node.key)
    setEditText(node.name)
  }

  function finishRename(commit: boolean): void {
    const key = editing()
    if (!key) return
    setEditing(null)
    const name = editText().trim()
    const f = findNode(roots(), key)
    if (!f) return
    const isNew = f.node.id === undefined
    if (!commit || !name) {
      // An unnamed new node is dropped; a stored one keeps its name.
      if (isNew && !f.node.name) {
        const r = removeSubtree(roots(), key)
        if (r) setRoots(r.roots)
      }
      return
    }
    if (name !== f.node.name) setRoots(renameNode(roots(), key, name))
  }

  function addNode(parentKey: string | null): void {
    tempCounter += 1
    const key = `new-${tempCounter}`
    const node: TreeNode = { key, tempId: key, name: "", children: [] }
    if (parentKey === null) {
      setRoots([...roots(), node])
    } else {
      const copy = cloneTree(roots())
      const parent = findNode(copy, parentKey)
      if (!parent) return
      parent.node.children.push(node)
      setRoots(copy)
      setCollapsed((c) => {
        const s = new Set(c)
        s.delete(parentKey)
        return s
      })
    }
    setEditing(key)
    setEditText("")
  }

  function archiveNode(key: string): void {
    const r = removeSubtree(roots(), key)
    if (!r) return
    setRoots(r.roots)
    setArchived((a) => [...a, ...r.removed])
  }

  function discard(): void {
    const data = loaded()
    if (data) reset(data)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    setConflict(false)
    const out = await callAppTool(api, props.app, props.block.ops.reorder, {
      baseVersion: loaded()?.version ?? null,
      nodes: reorderPayload(roots(), archived(), saved()),
    })
    setSaving(false)
    if (out.kind === "pending") {
      setPending(true)
      return
    }
    if (out.kind === "error") {
      if (out.status === 409 || CONFLICT_CODES.has(out.code)) setConflict(true)
      else setSaveError(out.message)
      return
    }
    addToast({ message: i18n.t(`${P}.savedToast`), type: "success" })
    void refetch()
  }

  function reload(): void {
    setConflict(false)
    void refetch()
  }

  function onDrop(e: DragEvent, target: MoveTarget): void {
    e.preventDefault()
    const key = dragKey()
    setDragKey(null)
    setOverKey(null)
    if (!key) return
    move(key, target)
  }

  const dropZone = (id: string, target: () => MoveTarget, depth: number): JSX.Element => (
    <div
      data-testid={id}
      class="h-1.5 rounded-full transition-colors"
      classList={{ "bg-accent/40": overKey() === id && dragKey() !== null }}
      style={{ "margin-left": `${4 + (depth - 1) * 22}px` }}
      onDragOver={(e) => {
        e.preventDefault()
        setOverKey(id)
      }}
      onDragLeave={() => setOverKey(null)}
      onDrop={(e) => onDrop(e, target())}
    />
  )

  const renderList = (list: TreeNode[], parentKey: string | null, depth: number): JSX.Element => (
    <ul role={depth === 1 ? "tree" : "group"} class="list-none">
      <For each={list}>
        {(node) => {
          const hasKids = () => node.children.length > 0
          const isCollapsed = () => collapsed().has(node.key)
          const canNestHere = () => {
            const k = dragKey()
            return k !== null && canMove(roots(), k, node.key, maxDepth())
          }
          return (
            <li
              role="treeitem"
              aria-label={node.name}
              aria-expanded={hasKids() ? !isCollapsed() : undefined}
            >
              {dropZone(
                `tree-drop-before-${node.key}`,
                () => ({ parentKey, beforeKey: node.key }),
                depth,
              )}
              <div
                class="group flex min-h-9 items-center gap-1 rounded-sm py-0.5 pr-2 hover:bg-surface-hover"
                classList={{ "ring-1 ring-accent/50": overKey() === node.key && canNestHere() }}
                style={{ "padding-left": `${4 + (depth - 1) * 22}px` }}
                draggable={editing() !== node.key}
                data-testid={`tree-row-${node.key}`}
                data-depth={String(depth)}
                onDragStart={(e) => {
                  setDragKey(node.key)
                  e.dataTransfer?.setData("text/plain", node.key)
                }}
                onDragEnd={() => {
                  setDragKey(null)
                  setOverKey(null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverKey(node.key)
                }}
                onDrop={(e) => onDrop(e, { parentKey: node.key })}
              >
                <span
                  class="inline-flex cursor-grab px-0.5 text-text-tertiary"
                  title={i18n.t(`${P}.dragHint`)}
                  aria-hidden="true"
                >
                  ⋮⋮
                </span>
                <Show when={hasKids()} fallback={<span class="inline-block w-[22px]" />}>
                  <button
                    type="button"
                    class="inline-flex h-[22px] w-[22px] items-center justify-center rounded-sm text-text-tertiary"
                    aria-expanded={!isCollapsed()}
                    aria-label={i18n.t(isCollapsed() ? `${P}.expand` : `${P}.collapse`)}
                    data-testid={`tree-toggle-${node.key}`}
                    onClick={() =>
                      setCollapsed((c) => {
                        const s = new Set(c)
                        if (s.has(node.key)) s.delete(node.key)
                        else s.add(node.key)
                        return s
                      })
                    }
                  >
                    <span
                      class="inline-block transition-transform"
                      classList={{ "-rotate-90": isCollapsed() }}
                    >
                      ▾
                    </span>
                  </button>
                </Show>
                <Show
                  when={editing() === node.key}
                  fallback={
                    <button
                      type="button"
                      class="min-w-0 flex-1 cursor-text truncate rounded-sm px-1.5 py-0.5 text-left text-[13px] hover:bg-surface-active"
                      data-testid={`tree-name-${node.key}`}
                      onClick={() => startRename(node)}
                    >
                      {node.name}
                    </button>
                  }
                >
                  <input
                    class="min-w-0 flex-1 rounded-sm border border-accent-muted bg-bg px-1.5 py-0.5 text-[13px] outline-none"
                    data-testid="tree-rename-input"
                    aria-label={i18n.t(`${P}.rename`)}
                    placeholder={i18n.t(`${P}.newItem`)}
                    value={editText()}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onInput={(e) => setEditText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishRename(true)
                      else if (e.key === "Escape") finishRename(false)
                    }}
                    onBlur={() => finishRename(true)}
                  />
                </Show>
                <RowMenu
                  node={node}
                  depth={depth}
                  roots={roots()}
                  maxDepth={maxDepth()}
                  onRename={() => startRename(node)}
                  onAddChild={() => addNode(node.key)}
                  onShift={(d) => apply(shiftNode(roots(), node.key, d))}
                  onMove={(parent) => move(node.key, { parentKey: parent })}
                  onArchive={() => archiveNode(node.key)}
                />
              </div>
              <Show when={hasKids() && !isCollapsed()}>
                {renderList(node.children, node.key, depth + 1)}
              </Show>
            </li>
          )
        }}
      </For>
      <li aria-hidden="true">
        {dropZone(`tree-drop-end-${parentKey ?? "root"}`, () => ({ parentKey }), depth)}
      </li>
    </ul>
  )

  return (
    <div class="flex flex-col gap-2" data-testid={`settings-block-${props.blockId}`}>
      <div class="rounded-lg border border-border bg-surface p-1.5">
        <Show
          when={!loaded.error}
          fallback={
            <div class="flex items-center gap-2 px-3 py-2 text-[13px] text-text-secondary">
              {i18n.t(`${P}.listFailed`)}
              <Button size="sm" variant="ghost" onClick={reload}>
                {i18n.t(`${P}.retry`)}
              </Button>
            </div>
          }
        >
          <Show when={roots().length > 0 || loaded.loading}>{renderList(roots(), null, 1)}</Show>
          <Show when={!loaded.loading && roots().length === 0}>
            <div class="px-3 py-2 text-[13px] text-text-tertiary">{i18n.t(`${P}.empty`)}</div>
          </Show>
          <div class="px-1 pt-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="tree-add-root"
              onClick={() => addNode(null)}
            >
              + {i18n.t(`${P}.add`)}
            </Button>
          </div>
        </Show>
      </div>
      <Show when={conflict()}>
        <div
          class="flex items-center gap-2 rounded-md border border-warning-border bg-warning-glow px-3 py-2 text-[13px]"
          data-testid="tree-conflict"
        >
          <span class="min-w-0 flex-1">{i18n.t(`${P}.conflict`)}</span>
          <Button size="sm" variant="outline" data-testid="tree-reload" onClick={reload}>
            {i18n.t(`${P}.reload`)}
          </Button>
        </div>
      </Show>
      <Show when={pending()}>
        <div class="text-xs text-text-secondary" data-testid="tree-pending">
          {i18n.t(`${P}.waitingApproval`)}
        </div>
      </Show>
      <Show when={saveError()}>
        <div class="text-xs text-error" data-testid="tree-error">
          {saveError()}
        </div>
      </Show>
      <Show when={dirty() && !pending()}>
        <DirtyBar
          testId="tree"
          count={changeCount()}
          saving={saving()}
          onDiscard={discard}
          onSave={() => void save()}
        />
      </Show>
    </div>
  )
}

const RowMenu: Component<{
  node: TreeNode
  depth: number
  roots: TreeNode[]
  maxDepth: number
  onRename: () => void
  onAddChild: () => void
  onShift: (delta: -1 | 1) => void
  onMove: (parentKey: string | null) => void
  onArchive: () => void
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  /** Every place the node may move to, besides where it is. */
  const targets = () => {
    const out: Array<{ key: string | null; name: string }> = []
    const here = findNode(props.roots, props.node.key)?.parent?.key ?? null
    if (here !== null && canMove(props.roots, props.node.key, null, props.maxDepth)) {
      out.push({ key: null, name: i18n.t(`${P}.topLevel`) })
    }
    const walk = (list: TreeNode[]) => {
      for (const n of list) {
        if (n.key !== here && canMove(props.roots, props.node.key, n.key, props.maxDepth)) {
          out.push({ key: n.key, name: n.name || i18n.t(`${P}.newItem`) })
        }
        walk(n.children)
      }
    }
    walk(props.roots)
    return out
  }
  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger
        class="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary opacity-70 hover:bg-surface-active hover:text-text group-hover:opacity-100"
        aria-label={i18n.t(`${P}.moreActions`)}
        data-testid={`tree-menu-${props.node.key}`}
      >
        ⋯
      </PopupMenu.Trigger>
      <PopupMenu.Content>
        <PopupMenu.Item onSelect={props.onRename}>{i18n.t(`${P}.rename`)}</PopupMenu.Item>
        <Show when={props.depth < props.maxDepth}>
          <PopupMenu.Item onSelect={props.onAddChild}>{i18n.t(`${P}.addInside`)}</PopupMenu.Item>
        </Show>
        <PopupMenu.Item onSelect={() => props.onShift(-1)}>{i18n.t(`${P}.moveUp`)}</PopupMenu.Item>
        <PopupMenu.Item onSelect={() => props.onShift(1)}>{i18n.t(`${P}.moveDown`)}</PopupMenu.Item>
        <Show when={targets().length > 0}>
          <PopupMenu.Separator />
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t(`${P}.moveTo`)}</PopupMenu.Label>
            <For each={targets()}>
              {(t) => (
                <PopupMenu.Item
                  data-testid={`tree-move-${props.node.key}-${t.key ?? "root"}`}
                  onSelect={() => props.onMove(t.key)}
                >
                  {t.name}
                </PopupMenu.Item>
              )}
            </For>
          </PopupMenu.Group>
        </Show>
        <PopupMenu.Separator />
        <PopupMenu.Item
          variant="danger"
          data-testid={`tree-archive-${props.node.key}`}
          onSelect={props.onArchive}
        >
          {i18n.t(`${P}.archive`)}
        </PopupMenu.Item>
      </PopupMenu.Content>
    </PopupMenu>
  )
}
