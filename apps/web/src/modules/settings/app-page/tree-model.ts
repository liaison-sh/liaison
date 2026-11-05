// SPDX-License-Identifier: FSL-1.1-ALv2
// The tree block's model, pure: rows from the list tool → nested nodes, moves
// that respect maxDepth and never enter their own subtree, archive of a
// subtree, the change count of the dirty bar, and the ONE payload the reorder
// tool takes (§R1 P2-7: `{ baseVersion, nodes: [{ id | tempId, parentId |
// parentTempId, name, sortOrder, archived? }] }`).

export interface TreeNode {
  /** `id` for a stored node, `tempId` for a new one. */
  key: string
  id?: string
  tempId?: string
  name: string
  children: TreeNode[]
}

export interface SavedPlace {
  name: string
  parentKey: string | null
  index: number
}

export type SavedIndex = Map<string, SavedPlace>

export interface ReorderNode {
  id?: string
  tempId?: string
  parentId?: string | null
  parentTempId?: string
  name: string
  sortOrder: number
  archived?: true
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null
}

/** Nested live nodes from list rows (camelCase or snake_case; archived rows and their subtrees left out). */
export function treeFromRows(rows: Array<Record<string, unknown>>): TreeNode[] {
  interface Flat {
    id: string
    parentId: string | null
    name: string
    sortOrder: number
  }
  const live: Flat[] = []
  for (const r of rows) {
    const id = str(r.id)
    if (!id) continue
    if (r.archived_at || r.archivedAt || r.archived === true) continue
    const order = r.sortOrder ?? r.sort_order
    live.push({
      id,
      parentId: str(r.parentId ?? r.parent_id),
      name: typeof r.name === "string" ? r.name : id,
      sortOrder: typeof order === "number" ? order : 0,
    })
  }
  const byParent = new Map<string | null, Flat[]>()
  const ids = new Set(live.map((n) => n.id))
  for (const n of live) {
    // A node whose parent is archived or missing hides with it.
    const parent =
      n.parentId !== null && ids.has(n.parentId)
        ? n.parentId
        : n.parentId === null
          ? null
          : undefined
    if (parent === undefined) continue
    const list = byParent.get(parent) ?? []
    list.push(n)
    byParent.set(parent, list)
  }
  const build = (parent: string | null, seen: Set<string>): TreeNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .filter((n) => !seen.has(n.id))
      .map((n) => {
        const next = new Set(seen).add(n.id)
        return { key: n.id, id: n.id, name: n.name, children: build(n.id, next) }
      })
  return build(null, new Set())
}

/** Where every node sits now. */
export function indexTree(roots: TreeNode[]): SavedIndex {
  const out: SavedIndex = new Map()
  const walk = (list: TreeNode[], parentKey: string | null) =>
    list.forEach((n, index) => {
      out.set(n.key, { name: n.name, parentKey, index })
      walk(n.children, n.key)
    })
  walk(roots, null)
  return out
}

export function cloneTree(roots: TreeNode[]): TreeNode[] {
  return roots.map((n) => ({ ...n, children: cloneTree(n.children) }))
}

export interface Found {
  node: TreeNode
  parent: TreeNode | null
  siblings: TreeNode[]
  index: number
  depth: number
}

export function findNode(roots: TreeNode[], key: string): Found | null {
  const walk = (list: TreeNode[], parent: TreeNode | null, depth: number): Found | null => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      if (node.key === key) return { node, parent, siblings: list, index: i, depth }
      const r = walk(node.children, node, depth + 1)
      if (r) return r
    }
    return null
  }
  return walk(roots, null, 1)
}

/** Levels a subtree spans (a leaf is 1). */
export function heightOf(node: TreeNode): number {
  return 1 + Math.max(0, ...node.children.map(heightOf))
}

function contains(node: TreeNode, key: string): boolean {
  return node.key === key || node.children.some((c) => contains(c, key))
}

export interface MoveTarget {
  /** null = top level. */
  parentKey: string | null
  /** Position among the new siblings (before removal of the moved node). Omitted = last. */
  beforeKey?: string
}

/** Can `key` go under `parentKey` within `maxDepth`, outside its own subtree? */
export function canMove(
  roots: TreeNode[],
  key: string,
  parentKey: string | null,
  maxDepth: number,
): boolean {
  const moving = findNode(roots, key)
  if (!moving) return false
  if (parentKey === null) return heightOf(moving.node) <= maxDepth
  if (contains(moving.node, parentKey)) return false
  const parent = findNode(roots, parentKey)
  if (!parent) return false
  return parent.depth + heightOf(moving.node) <= maxDepth
}

/** The tree with `key` moved, or null when the move is not allowed. */
export function moveNode(
  roots: TreeNode[],
  key: string,
  target: MoveTarget,
  maxDepth: number,
): TreeNode[] | null {
  if (target.beforeKey === key) return null
  if (!canMove(roots, key, target.parentKey, maxDepth)) return null
  const next = cloneTree(roots)
  const from = findNode(next, key)
  if (!from) return null
  from.siblings.splice(from.index, 1)
  const list =
    target.parentKey === null ? next : (findNode(next, target.parentKey)?.node.children ?? null)
  if (!list) return null
  const at = target.beforeKey ? list.findIndex((n) => n.key === target.beforeKey) : -1
  if (at >= 0) list.splice(at, 0, from.node)
  else list.push(from.node)
  return next
}

/** Move a node one place up or down among its siblings. */
export function shiftNode(roots: TreeNode[], key: string, delta: -1 | 1): TreeNode[] | null {
  const next = cloneTree(roots)
  const f = findNode(next, key)
  if (!f) return null
  const to = f.index + delta
  if (to < 0 || to >= f.siblings.length) return null
  const [n] = f.siblings.splice(f.index, 1)
  f.siblings.splice(to, 0, n)
  return next
}

/** The tree without `key`, and every node of its subtree (to archive). */
export function removeSubtree(
  roots: TreeNode[],
  key: string,
): { roots: TreeNode[]; removed: TreeNode[] } | null {
  const next = cloneTree(roots)
  const f = findNode(next, key)
  if (!f) return null
  f.siblings.splice(f.index, 1)
  const removed: TreeNode[] = []
  const collect = (n: TreeNode) => {
    removed.push(n)
    n.children.forEach(collect)
  }
  collect(f.node)
  return { roots: next, removed }
}

export function renameNode(roots: TreeNode[], key: string, name: string): TreeNode[] {
  const next = cloneTree(roots)
  const f = findNode(next, key)
  if (f) f.node.name = name
  return next
}

/** Nodes changed (name, parent or position), new or archived since `saved`. */
export function countChanges(saved: SavedIndex, roots: TreeNode[], archived: TreeNode[]): number {
  let count = 0
  for (const [key, place] of indexTree(roots)) {
    const was = saved.get(key)
    if (
      !was ||
      was.name !== place.name ||
      was.parentKey !== place.parentKey ||
      was.index !== place.index
    ) {
      count++
    }
  }
  return count + archived.filter((n) => n.id !== undefined).length
}

/** The whole tree as the reorder tool takes it: live nodes depth-first, then archived ones. */
export function reorderPayload(
  roots: TreeNode[],
  archived: TreeNode[],
  saved: SavedIndex,
): ReorderNode[] {
  const out: ReorderNode[] = []
  const walk = (list: TreeNode[], parent: TreeNode | null) =>
    list.forEach((n, sortOrder) => {
      out.push({
        ...(n.id !== undefined ? { id: n.id } : { tempId: n.tempId ?? n.key }),
        ...(parent === null
          ? { parentId: null }
          : parent.id !== undefined
            ? { parentId: parent.id }
            : { parentTempId: parent.tempId ?? parent.key }),
        name: n.name,
        sortOrder,
      })
      walk(n.children, n)
    })
  walk(roots, null)
  for (const n of archived) {
    if (n.id === undefined) continue
    const was = saved.get(n.key)
    out.push({
      id: n.id,
      parentId: was?.parentKey ?? null,
      name: was?.name ?? n.name,
      sortOrder: was?.index ?? 0,
      archived: true,
    })
  }
  return out
}
