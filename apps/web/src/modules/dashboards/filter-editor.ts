// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FILTERS MADE BY PEOPLE, the plain logic: a person with edit rights adds a filter on a field the
// blocks' rows carry, names it, picks its kind and the blocks it narrows; renames it; removes it.
// Each is a list of edit operations (`POST /dashboards/:id/edit`), versioned like any change:
// - the filter itself (`setFilter`): a select or a multi lists the field's values read from a
//   block's own source or dataset (`{fromSource, field}` / `{fromDataset, field}`), a text
//   filter takes what the person types;
// - each chosen block (or blended layer) gets a row condition on the field reading the filter's
//   value (`map.where`: equal for a select or a multi, contains for a text), so the rows narrow
//   without touching the source;
// - a removal drops those conditions first, then the filter.
import type {
  DashboardBlockMap,
  DashboardBlockSpec,
  DashboardFilterDef,
  DashboardLayerSpec,
  DashboardSpec,
  EditOperation,
  FilterType,
} from "./dashboards-client"

/** What a filter can apply to: a block, or one layer of a blended chart. */
export interface FilterTarget {
  blockId: string
  layerId?: string
}

/** A field some blocks' rows carry, and those blocks. */
export interface FilterField {
  field: string
  targets: FilterTarget[]
}

export interface NewFilter {
  label: string
  type: FilterType
  field: string
  targets: FilterTarget[]
}

/** The server's bound on filters per dashboard (api spec.ts). */
export const MAX_FILTERS = 8
/** The server's bound on a filter's label. */
export const MAX_FILTER_LABEL = 60

const FILTER_ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** A key that tells targets apart. */
export const targetKey = (t: FilterTarget) => (t.layerId ? `${t.blockId}~${t.layerId}` : t.blockId)

/**
 * A new filter's id from its label: letters, digits and _ ("Sales channel" -> "sales_channel"),
 * starting with a letter, unique among `taken`.
 */
export function filterIdFrom(label: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "")
      .slice(0, 32) || "filter"
  let id = base
  for (let n = 2; used.has(id) || !FILTER_ID.test(id); n++) id = `${base}_${n}`
  return id
}

/** Every block (or blended layer) that reads rows: what a filter can apply to. */
export function filterTargets(spec: DashboardSpec): FilterTarget[] {
  const out: FilterTarget[] = []
  for (const b of spec.blocks) {
    if (b.type === "text") continue
    if (b.layers?.length) for (const l of b.layers) out.push({ blockId: b.id, layerId: l.id })
    else out.push({ blockId: b.id })
  }
  return out
}

/** The fields the targets' rows carry, each with the targets that carry it, sorted by field. */
export function fieldsFrom(read: { target: FilterTarget; fields: string[] }[]): FilterField[] {
  const by = new Map<string, FilterTarget[]>()
  for (const r of read) {
    for (const f of r.fields) {
      const list = by.get(f) ?? []
      list.push(r.target)
      by.set(f, list)
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, targets]) => ({ field, targets }))
}

/** The block or layer a target names, with its map and where its rows come from. */
function partOf(
  spec: DashboardSpec,
  t: FilterTarget,
): { block: DashboardBlockSpec; layer?: DashboardLayerSpec } | null {
  const block = spec.blocks.find((b) => b.id === t.blockId)
  if (!block) return null
  if (!t.layerId) return { block }
  const layer = block.layers?.find((l) => l.id === t.layerId)
  return layer ? { block, layer } : null
}

const readsAFilter = (v: unknown) => JSON.stringify(v ?? null).includes("{{filter.")

/**
 * Where a select's or a multi's values come from: the first target reading a shared dataset, or
 * a source that reads no filter itself (an option list cannot depend on a filter). Null: none.
 */
export function optionsFor(
  spec: DashboardSpec,
  field: string,
  targets: FilterTarget[],
): DashboardFilterDef["options"] | null {
  for (const t of targets) {
    const p = partOf(spec, t)
    if (!p) continue
    const from = p.layer ?? p.block
    if (from.dataset) return { fromDataset: from.dataset, field }
    if (from.source && !readsAFilter(from.source)) return { fromSource: from.source, field }
  }
  return null
}

type Where = { field: string; op: string; value?: unknown }

const whereOf = (map: DashboardBlockMap | undefined): Where[] =>
  Array.isArray(map?.where) ? (map.where as Where[]) : []

const readsFilter = (w: Where, id: string) =>
  !!w.value &&
  typeof w.value === "object" &&
  !Array.isArray(w.value) &&
  (w.value as { filter?: unknown }).filter === id

/**
 * The operations that add `f`: the filter, then a row condition on each chosen block or layer.
 * Null when a select or a multi has nowhere to read its values from.
 */
export function addFilterOps(spec: DashboardSpec, f: NewFilter): EditOperation[] | null {
  const id = filterIdFrom(
    f.label,
    (spec.filters ?? []).map((x) => x.id),
  )
  const label = f.label.trim().slice(0, MAX_FILTER_LABEL)
  let def: DashboardFilterDef
  if (f.type === "text") def = { id, label, type: "text" }
  else {
    const options = optionsFor(spec, f.field, f.targets)
    if (!options) return null
    def = { id, label, type: f.type, options }
  }
  const clause: Where = {
    field: f.field,
    op: f.type === "text" ? "contains" : "eq",
    value: { filter: id },
  }
  return [{ op: "setFilter", filter: def }, ...whereOps(spec, f.targets, (w) => [...w, clause])]
}

/** Renames a filter: the same filter, its label changed. */
export function renameFilterOp(def: DashboardFilterDef, label: string): EditOperation {
  return { op: "setFilter", filter: { ...def, label: label.trim().slice(0, MAX_FILTER_LABEL) } }
}

/** Removes a filter: the row conditions reading it first, then the filter. */
export function removeFilterOps(spec: DashboardSpec, id: string): EditOperation[] {
  const targets = filterTargets(spec).filter((t) => {
    const p = partOf(spec, t)
    return !!p && whereOf((p.layer ?? p.block).map).some((w) => readsFilter(w, id))
  })
  return [
    ...whereOps(spec, targets, (w) => w.filter((x) => !readsFilter(x, id))),
    { op: "removeFilter", id },
  ]
}

/** The blocks or layers a filter narrows today (a row condition reads it). */
export function targetsOfFilter(spec: DashboardSpec, id: string): FilterTarget[] {
  return filterTargets(spec).filter((t) => {
    const p = partOf(spec, t)
    return !!p && whereOf((p.layer ?? p.block).map).some((w) => readsFilter(w, id))
  })
}

/** One updateBlock per block touched: its map's where changed, or its layers' (sent whole). */
function whereOps(
  spec: DashboardSpec,
  targets: FilterTarget[],
  change: (where: Where[]) => Where[],
): EditOperation[] {
  const ops: EditOperation[] = []
  const blocks = [...new Set(targets.map((t) => t.blockId))]
  for (const blockId of blocks) {
    const block = spec.blocks.find((b) => b.id === blockId)
    if (!block) continue
    const mine = targets.filter((t) => t.blockId === blockId)
    if (block.layers?.length) {
      const layerIds = new Set(mine.map((t) => t.layerId))
      const layers = block.layers.map((l) => {
        if (!layerIds.has(l.id)) return l
        const where = change(whereOf(l.map))
        const { where: _old, ...rest } = l.map
        return { ...l, map: where.length ? { ...rest, where } : rest }
      })
      ops.push({ op: "updateBlock", blockId, changes: { layers } })
    } else {
      const where = change(whereOf(block.map))
      ops.push({
        op: "updateBlock",
        blockId,
        changes: { map: { where: where.length ? where : null } },
      })
    }
  }
  return ops
}
