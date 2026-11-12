// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Applying an edit written against an older version on top of the current one (service.ts
// planEdit). An edit's operations name what they change (a block, a dataset or a filter by
// its id, the title, the range, the description, the visibility), so when the dashboard
// moved on since the version the edit was written against, the edit still applies as long as
// no version saved in between changed one of the things it names. Two edits an agent filed
// one after the other, both waiting for an approval, then both land as the person approved
// them, in either order. A revert (it brings a whole saved version back) never applies on
// top of anything but the version it was written against, and neither does a whole-spec
// replace (dashboards_update, strict in service.ts).

import type { EditOperation } from "~/modules/dashboards/edit"

/** A saved version, as the rebase compares it with the one before. */
export interface RebaseVersion {
  version: number
  title: string
  /** Null for a version recorded before visibility was kept. */
  visibility: "personal" | "org" | null
  spec: Record<string, unknown>
  savedByName: string | null
}

/** Why an edit cannot apply on top of the newer saves. */
export interface RebaseConflict {
  /** 0-based index of the operation, or -1 when the edit as a whole is strict (a revert). */
  index: number
  /** What the operation changes, in words ("the block 'sales'"). */
  what: string
  /** The version that changed it after the edit's base. */
  version: number
  message: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** JSON with object keys sorted: two values are the same when this is. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const blocksOf = (spec: Record<string, unknown>) =>
  (Array.isArray(spec.blocks) ? spec.blocks : []).filter(isObject)
const filtersOf = (spec: Record<string, unknown>) =>
  (Array.isArray(spec.filters) ? spec.filters : []).filter(isObject)
const datasetsOf = (spec: Record<string, unknown>) => (isObject(spec.datasets) ? spec.datasets : {})

/** What a key names, in words. */
function words(key: string): string {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]
  switch (kind) {
    case "block":
      return `the block '${id}'`
    case "dataset":
      return `the dataset '${id}'`
    case "filter":
      return `the filter '${id}'`
    default:
      return (
        {
          "dash:title": "the title",
          "dash:description": "the description",
          "dash:range": "the default time range",
          "dash:visibility": "the visibility",
          "dash:order": "the order of the blocks (this operation places a block by index)",
          "dash:filterOrder": "the order of the filters (this operation places a filter by index)",
        }[key] ?? key
      )
  }
}

/** The dataset ids a block (or a block's changes) reads, wherever it names one. */
function datasetsNamed(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) datasetsNamed(v, out)
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "dataset" || k === "fromDataset") && typeof v === "string") out.add(v)
      else datasetsNamed(v, out)
    }
  }
  return out
}

/** The id duplicateBlock gives its copy by default, against `blocks` (as edit.ts copyId). */
function defaultCopyId(blocks: Record<string, unknown>[], base: string): string {
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`
    const id = `${base.slice(0, 40 - suffix.length)}${suffix}`
    if (!blocks.some((b) => b.id === id)) return id
  }
  return `${base}-copy`
}

/**
 * What each operation changes or relies on, as keys ("block:<id>", "dataset:<id>",
 * "filter:<id>", "dash:title", ...), in operation order. Null for an operation that never
 * applies on top of a newer save (revert).
 */
export function operationKeys(
  base: Record<string, unknown>,
  operations: readonly EditOperation[],
): Array<string[] | null> {
  // Ids the edit itself adds as it goes, so a later default copy id is computed as at apply.
  const blocks = blocksOf(base).map((b) => ({ id: b.id }) as Record<string, unknown>)
  return operations.map((op) => {
    switch (op.op) {
      case "addBlock": {
        const keys = [`block:${String(op.block.id)}`]
        for (const d of datasetsNamed(op.block)) keys.push(`dataset:${d}`)
        if (typeof op.position === "number") keys.push("dash:order")
        blocks.push({ id: op.block.id })
        return keys
      }
      case "updateBlock": {
        const keys = [`block:${op.blockId}`]
        for (const d of datasetsNamed(op.changes)) keys.push(`dataset:${d}`)
        return keys
      }
      case "removeBlock":
      case "resizeBlock":
        return [`block:${op.blockId}`]
      case "moveBlock":
        return [`block:${op.blockId}`, ...(typeof op.position === "number" ? ["dash:order"] : [])]
      case "duplicateBlock": {
        const id = op.newId ?? defaultCopyId(blocks, op.blockId)
        blocks.push({ id })
        return [
          `block:${op.blockId}`,
          `block:${id}`,
          ...(typeof op.position === "number" ? ["dash:order"] : []),
        ]
      }
      case "setTitle":
        return ["dash:title"]
      case "setDescription":
        return ["dash:description"]
      case "setTimeRange":
        return ["dash:range"]
      case "setVisibility":
        return ["dash:visibility"]
      case "setDataset":
      case "removeDataset":
        return [`dataset:${op.id}`]
      case "setFilter":
        return [
          `filter:${String(op.filter.id)}`,
          ...(op.position !== undefined ? ["dash:filterOrder"] : []),
        ]
      case "removeFilter":
        return [`filter:${op.id}`]
      case "revert":
        return null
    }
    return null
  })
}

/** The keys one save changed, from the version before it to its own. */
export function versionChanges(prev: RebaseVersion, next: RebaseVersion): Set<string> {
  const out = new Set<string>()
  if (prev.title !== next.title) out.add("dash:title")
  if (prev.visibility && next.visibility && prev.visibility !== next.visibility) {
    out.add("dash:visibility")
  }
  const a = prev.spec
  const b = next.spec
  if (stableJson(a.description) !== stableJson(b.description)) out.add("dash:description")
  if (stableJson([a.timeRange, a.compare]) !== stableJson([b.timeRange, b.compare]))
    out.add("dash:range")

  const aBlocks = new Map(blocksOf(a).map((x) => [String(x.id), stableJson(x)]))
  const bBlocks = new Map(blocksOf(b).map((x) => [String(x.id), stableJson(x)]))
  for (const id of new Set([...aBlocks.keys(), ...bBlocks.keys()])) {
    if (aBlocks.get(id) !== bBlocks.get(id)) out.add(`block:${id}`)
  }
  if (stableJson([...aBlocks.keys()]) !== stableJson([...bBlocks.keys()])) out.add("dash:order")

  const aSets = datasetsOf(a)
  const bSets = datasetsOf(b)
  for (const id of new Set([...Object.keys(aSets), ...Object.keys(bSets)])) {
    if (stableJson(aSets[id]) !== stableJson(bSets[id])) out.add(`dataset:${id}`)
  }

  const aFilters = new Map(filtersOf(a).map((x) => [String(x.id), stableJson(x)]))
  const bFilters = new Map(filtersOf(b).map((x) => [String(x.id), stableJson(x)]))
  for (const id of new Set([...aFilters.keys(), ...bFilters.keys()])) {
    if (aFilters.get(id) !== bFilters.get(id)) out.add(`filter:${id}`)
  }
  if (stableJson([...aFilters.keys()]) !== stableJson([...bFilters.keys()]))
    out.add("dash:filterOrder")
  return out
}

const opName = (op: EditOperation): string => {
  if ("blockId" in op) return `${op.op} '${op.blockId}'`
  if (op.op === "addBlock") return `addBlock '${String(op.block.id)}'`
  if (op.op === "setDataset" || op.op === "removeDataset" || op.op === "removeFilter") {
    return `${op.op} '${op.id}'`
  }
  if (op.op === "setFilter") return `setFilter '${String(op.filter.id)}'`
  return op.op
}

/**
 * Whether `operations`, written against `versions[0]`, can apply on top of the last of
 * `versions` (every version from the base to the current one, in order): null when they can,
 * else the first conflict. A missing version in between is a conflict too: what it changed
 * is unknown.
 */
export function rebaseConflict(
  operations: readonly EditOperation[],
  versions: readonly RebaseVersion[],
): RebaseConflict | null {
  const base = versions[0]!
  const current = versions[versions.length - 1]!
  const reread = `The dashboard is now at version ${current.version}: read it again (kernel__dashboards_get) and send the change against that version.`
  const keys = operationKeys(base.spec, operations)
  const strict = keys.indexOf(null)
  if (strict >= 0) {
    return {
      index: strict,
      what: "a whole saved version",
      version: current.version,
      message: `operation ${strict + 1} (revert) brings back a whole saved version, so it applies only to the version it was written against (${base.version}), not on top of the versions saved since. ${reread}`,
    }
  }
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1]!
    const next = versions[i]!
    if (next.version !== prev.version + 1) {
      return {
        index: -1,
        what: "the versions in between",
        version: prev.version + 1,
        message: `version ${prev.version + 1} is no longer kept, so what changed since version ${base.version} is unknown. ${reread}`,
      }
    }
    const changed = versionChanges(prev, next)
    for (const [index, opKeys] of keys.entries()) {
      const hit = opKeys?.find((k) => changed.has(k))
      if (!hit) continue
      const by = next.savedByName ? ` (saved by ${next.savedByName})` : ""
      return {
        index,
        what: words(hit),
        version: next.version,
        message: `operation ${index + 1} (${opName(operations[index]!)}) changes ${words(hit)}, which version ${next.version}${by} also changed after version ${base.version}, the version this edit was written against. ${reread}`,
      }
    }
  }
  return null
}
