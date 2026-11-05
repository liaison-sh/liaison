// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Response projection and pagination. `project` selects the items at the
 * operation's JSON pointer and keeps, per item, only the allow-listed dotted
 * paths that end at a scalar or an array of scalars. Arrays met along a path
 * are walked explicitly (`lines.sku` keeps `sku` of every line); objects at a
 * leaf, inherited keys and prototype keys are never copied.
 *
 * A field map (`fields: { name: properties.name }`) reads each source path
 * the same way (an index segment picks one array element, any other segment
 * walks every element) and returns the leaf under its output name only.
 */
import {
  type FieldEntry,
  fieldEntries,
  MAX_ITEMS_PER_CALL,
  MAX_PAGES_PER_CALL,
  type Operation,
} from "./schema"

export type Scalar = string | number | boolean | null
export type ProjectedValue = Scalar | Scalar[] | ProjectedObject | ProjectedObject[]
export interface ProjectedObject {
  [key: string]: ProjectedValue
}

export interface ProjectResult {
  items: ProjectedObject[]
  /** True when the response held more items than the per-call cap. */
  truncated: boolean
}

const MAX_NESTED_ARRAY = MAX_ITEMS_PER_CALL

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
}

function ownGet(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}

/** RFC 6901 pointer lookup over own properties only. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc
  let cur: unknown = doc
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined
      cur = cur[Number(key)]
    } else if (isRecord(cur)) {
      cur = ownGet(cur, key)
    } else {
      return undefined
    }
    if (cur === undefined) return undefined
  }
  return cur
}

interface FieldTree {
  [segment: string]: FieldTree | true
}

function buildTree(fields: readonly string[]): FieldTree {
  const root: FieldTree = Object.create(null)
  for (const f of fields) {
    const segs = f.split(".")
    let node = root
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) {
        node[seg] = true
        return
      }
      const next = node[seg]
      if (next === true) return
      if (next === undefined) {
        const child: FieldTree = Object.create(null)
        node[seg] = child
        node = child
      } else {
        node = next
      }
    })
  }
  return root
}

function leaf(value: unknown): Scalar | Scalar[] | undefined {
  if (isScalar(value)) return value
  if (Array.isArray(value)) {
    const scalars = value.filter(isScalar).slice(0, MAX_NESTED_ARRAY)
    // An array of objects is object-valued: dropped, not turned into [].
    return scalars.length === 0 && value.length > 0 ? undefined : scalars
  }
  return undefined
}

function pick(source: Record<string, unknown>, tree: FieldTree): ProjectedObject {
  const out: ProjectedObject = {}
  for (const key of Object.keys(tree)) {
    const sub = tree[key]
    const value = ownGet(source, key)
    if (value === undefined || sub === undefined) continue
    if (sub === true) {
      const l = leaf(value)
      if (l !== undefined) out[key] = l
      continue
    }
    if (isRecord(value)) {
      const nested = pick(value, sub)
      if (Object.keys(nested).length > 0) out[key] = nested
    } else if (Array.isArray(value)) {
      const rows = value
        .filter(isRecord)
        .slice(0, MAX_NESTED_ARRAY)
        .map((v) => pick(v, sub))
      if (rows.length > 0) out[key] = rows
    }
  }
  return out
}

const INDEX_RE = /^(0|[1-9][0-9]{0,2})$/

/** The value at a source path: own keys only; arrays indexed or walked (scalars collected). */
function readSource(cur: unknown, segs: readonly string[], i: number): unknown {
  if (i === segs.length) return cur
  const seg = segs[i] ?? ""
  if (Array.isArray(cur)) {
    if (INDEX_RE.test(seg)) {
      const n = Number(seg)
      return n < cur.length ? readSource(cur[n], segs, i + 1) : undefined
    }
    const out: Scalar[] = []
    for (const el of cur.slice(0, MAX_NESTED_ARRAY)) {
      const v = readSource(el, segs, i)
      if (isScalar(v)) out.push(v)
      else if (Array.isArray(v)) out.push(...v.filter(isScalar))
    }
    return out.slice(0, MAX_NESTED_ARRAY)
  }
  if (isRecord(cur)) return readSource(ownGet(cur, seg), segs, i + 1)
  return undefined
}

/** Set `value` at the dotted output name (names are validated: no prototype key). */
function setOutput(out: ProjectedObject, name: string, value: Scalar | Scalar[]): void {
  const segs = name.split(".")
  let node = out
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg]
    if (next !== null && typeof next === "object" && !Array.isArray(next)) node = next
    else {
      const child: ProjectedObject = {}
      node[seg] = child
      node = child
    }
  }
  node[segs[segs.length - 1] ?? name] = value
}

function pickMapped(
  source: Record<string, unknown>,
  entries: readonly FieldEntry[],
): ProjectedObject {
  const out: ProjectedObject = {}
  for (const { out: name, source: path } of entries) {
    const l = leaf(readSource(source, path.split("."), 0))
    if (l !== undefined) setOutput(out, name, l)
  }
  return out
}

/** The raw item list at the operation's `items` pointer (an object counts as one item). */
export function selectItems(response: unknown, op: Pick<Operation, "items">): unknown[] {
  const at = resolvePointer(response, op.items ?? "")
  if (Array.isArray(at)) return at
  if (isRecord(at)) return [at]
  return []
}

/** Project a response to the operation's allow-list, capped at MAX_ITEMS_PER_CALL. */
export function project(
  response: unknown,
  op: Pick<Operation, "items" | "fields">,
  cap = MAX_ITEMS_PER_CALL,
): ProjectResult {
  const raw = selectItems(response, op).filter(isRecord)
  const limit = Math.min(cap, MAX_ITEMS_PER_CALL)
  const shape: (r: Record<string, unknown>) => ProjectedObject = Array.isArray(op.fields)
    ? (
        (tree) => (r) =>
          pick(r, tree)
      )(buildTree(op.fields))
    : (
        (entries) => (r) =>
          pickMapped(r, entries)
      )(fieldEntries(op))
  return { items: raw.slice(0, limit).map(shape), truncated: raw.length > limit }
}

/** Query pairs for the first page (page pagination sends page 1 and the size). */
export function firstPageQuery(op: Pick<Operation, "pagination">): [string, string][] {
  const p = op.pagination
  if (p?.type !== "page") return []
  const pairs: [string, string][] = [[p.param, "1"]]
  if (p.sizeParam) pairs.push([p.sizeParam, String(p.size)])
  return pairs
}

/**
 * Query pairs for the next page, or null when pagination stops.
 * `pagesFetched` counts pages already fetched; `lastPageCount` is the item
 * count of the last page (page pagination stops on a short page).
 */
export function nextPageQuery(
  op: Pick<Operation, "pagination">,
  lastResponse: unknown,
  pagesFetched: number,
  lastPageCount: number,
): [string, string][] | null {
  const p = op.pagination
  if (!p) return null
  const maxPages = Math.min(p.maxPages ?? MAX_PAGES_PER_CALL, MAX_PAGES_PER_CALL)
  if (pagesFetched >= maxPages) return null
  if (p.type === "cursor") {
    const cursor = resolvePointer(lastResponse, p.cursorPointer)
    if (typeof cursor === "number" && Number.isFinite(cursor)) return [[p.param, String(cursor)]]
    if (typeof cursor !== "string" || cursor === "" || cursor.length > 2048) return null
    return [[p.param, cursor]]
  }
  if (lastPageCount < p.size) return null
  const pairs: [string, string][] = [[p.param, String(pagesFetched + 1)]]
  if (p.sizeParam) pairs.push([p.sizeParam, String(p.size)])
  return pairs
}
