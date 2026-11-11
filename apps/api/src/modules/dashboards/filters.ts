// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard filters (spec.filters): the values a viewer picks, and the two ways they
// reach a block. Pure: no I/O.
//
// - Source tokens: `{{filter.<id>}}` in a source's params (or a store query). A whole-string
//   token becomes the value (a multi filter's list stays a list); inside a longer string the
//   value is spliced in (a list joined by ","). An empty or unset value DROPS the param that
//   holds it (an object key, an array element): no value means "all", and a tool told nothing
//   reads everything. Filter tokens resolve before the date tokens (relative-dates.ts).
// - Row conditions: `map.where` runs on the source's rows before any aggregation, so a filter
//   works even when the tool has no param for it. A clause whose value is `{filter: id}` is
//   dropped while that filter is empty; a multi value turns eq into "in" and neq into "not in".
//
// Values travel as `Record<filterId, string[]>` (select and text: at most one item).

import type { DashboardSpec, FilterDef, WhereClause, WhereOp } from "~/modules/dashboards/spec"

/** A filter's values: select and text hold 0-1 item, multi any number; [] is "all". */
export type FilterValues = Record<string, string[]>

export const MAX_FILTER_VALUES = 50
export const MAX_FILTER_VALUE_LENGTH = 200

export class FilterValueError extends Error {}

const TOKEN = /\{\{filter\.([A-Za-z][A-Za-z0-9_]{0,39})\}\}/g
const WHOLE_TOKEN = /^\{\{filter\.([A-Za-z][A-Za-z0-9_]{0,39})\}\}$/

/** A filter's default as values. */
export function defaultValues(def: FilterDef): string[] {
  if (def.default === undefined) return []
  const list = Array.isArray(def.default) ? def.default : [def.default]
  return list.filter((v) => v !== "")
}

/** Every filter's default. */
export function defaultFilterValues(spec: Pick<DashboardSpec, "filters">): FilterValues {
  const out: FilterValues = {}
  for (const f of spec.filters ?? []) out[f.id] = defaultValues(f)
  return out
}

/**
 * The values a request asked for, checked against the spec, over the defaults: an absent
 * filter takes its default, a present empty one is "all". Throws FilterValueError on an unknown
 * filter, a value outside a static list, too many or too long values.
 */
export function normalizeFilterValues(
  spec: Pick<DashboardSpec, "filters">,
  asked: Record<string, string[]> | undefined,
): FilterValues {
  const defs = new Map((spec.filters ?? []).map((f) => [f.id, f]))
  const out = defaultFilterValues(spec)
  for (const [id, raw] of Object.entries(asked ?? {})) {
    const def = defs.get(id)
    if (!def) throw new FilterValueError(`no filter '${id}' on this dashboard`)
    const values = [...new Set(raw.map((v) => v.trim()).filter((v) => v !== ""))]
    if (values.length > MAX_FILTER_VALUES) {
      throw new FilterValueError(`filter '${id}' takes at most ${MAX_FILTER_VALUES} values`)
    }
    if (values.some((v) => v.length > MAX_FILTER_VALUE_LENGTH)) {
      throw new FilterValueError(
        `a value of filter '${id}' is longer than ${MAX_FILTER_VALUE_LENGTH}`,
      )
    }
    if (def.type !== "multi" && values.length > 1) {
      throw new FilterValueError(`filter '${id}' takes one value`)
    }
    if (Array.isArray(def.options)) {
      const allowed = new Set(def.options)
      const bad = values.find((v) => !allowed.has(v))
      if (bad !== undefined)
        throw new FilterValueError(`'${bad}' is not an option of filter '${id}'`)
    }
    out[id] = values
  }
  return out
}

/**
 * Saved values read back (another release, or a filter since removed or changed): whatever no
 * longer fits is left out rather than refused.
 */
export function sanitizeSavedFilterValues(
  spec: Pick<DashboardSpec, "filters">,
  saved: unknown,
): FilterValues {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {}
  const out: FilterValues = {}
  for (const [id, raw] of Object.entries(saved as Record<string, unknown>)) {
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) continue
    try {
      const one = normalizeFilterValues(spec, { [id]: raw as string[] })
      out[id] = one[id] ?? []
    } catch {
      // a filter gone or narrowed: forgotten
    }
  }
  return out
}

/** `value` with every filter token resolved; a param whose filter is empty is dropped. */
export function resolveFilterTokens<T>(value: T, values: FilterValues): T {
  const DROP = Symbol("drop")
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!v.includes("{{filter.")) return v
      const whole = WHOLE_TOKEN.exec(v)
      if (whole) {
        const got = values[whole[1]!] ?? []
        if (got.length === 0) return DROP
        return got.length === 1 ? got[0] : got
      }
      let empty = false
      const out = v.replace(TOKEN, (_raw, id: string) => {
        const got = values[id] ?? []
        if (got.length === 0) empty = true
        return got.join(",")
      })
      return empty ? DROP : out
    }
    if (Array.isArray(v)) return v.map(visit).filter((x) => x !== DROP)
    if (v && typeof v === "object") {
      const entries: [string, unknown][] = []
      for (const [k, x] of Object.entries(v)) {
        const r = visit(x)
        if (r !== DROP) entries.push([k, r])
      }
      return Object.fromEntries(entries)
    }
    return v
  }
  const out = visit(value)
  return (out === DROP ? {} : out) as T
}

/** A where clause with its value decided: ready for the rows. */
export interface ResolvedWhere {
  field: string
  op: WhereOp
  values: unknown[]
}

/** The block's where clauses with filter values put in; a clause on an empty filter is dropped. */
export function resolveWhere(
  where: WhereClause[] | undefined,
  values: FilterValues,
): ResolvedWhere[] {
  const out: ResolvedWhere[] = []
  for (const w of where ?? []) {
    const v = w.value
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const got = values[v.filter] ?? []
      if (got.length === 0) continue
      const op: WhereOp = got.length > 1 && w.op === "eq" ? "in" : w.op
      out.push({ field: w.field, op, values: got })
      continue
    }
    out.push({
      field: w.field,
      op: w.op,
      values: v === undefined ? [] : Array.isArray(v) ? v : [v],
    })
  }
  return out
}

function readPath(source: unknown, path: string): unknown {
  let cur: unknown = source
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined
      cur = cur[Number(part)]
      continue
    }
    if (typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)

function same(a: unknown, b: unknown): boolean {
  if (isEmpty(a)) return isEmpty(b)
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== null && nb !== null) return na === nb
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b)
  if (typeof a === "object") return false
  return String(a) === String(b)
}

/** -1, 0, 1, or null when the two cannot be ordered (an empty side). */
function order(a: unknown, b: unknown): number | null {
  if (isEmpty(a) || isEmpty(b)) return null
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== null && nb !== null) return Math.sign(na - nb)
  if (typeof a === "object" || typeof b === "object") return null
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Does one row meet one clause? A list field (tags) meets eq/in when any element does. */
export function matchesWhere(row: unknown, w: ResolvedWhere): boolean {
  const v = readPath(row, w.field)
  const items = Array.isArray(v) ? v : [v]
  switch (w.op) {
    case "empty":
      return isEmpty(v)
    case "notEmpty":
      return !isEmpty(v)
    case "eq":
    case "in":
      return w.values.some((x) => items.some((i) => same(i, x)))
    case "neq":
      return !w.values.some((x) => items.some((i) => same(i, x)))
    case "contains":
      return w.values.some((x) =>
        items.some(
          (i) =>
            i !== null &&
            i !== undefined &&
            typeof i !== "object" &&
            String(i).toLowerCase().includes(String(x).toLowerCase()),
        ),
      )
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const c = order(v, w.values[0])
      if (c === null) return false
      return w.op === "gt" ? c > 0 : w.op === "gte" ? c >= 0 : w.op === "lt" ? c < 0 : c <= 0
    }
  }
}

/** The rows that meet every clause. */
export function applyWhere<R>(rows: R[], where: ResolvedWhere[]): R[] {
  if (where.length === 0) return rows
  return rows.filter((r) => where.every((w) => matchesWhere(r, w)))
}

/** The filter ids a where list reads (for a source's projection and the card). */
export function whereFilterIds(where: WhereClause[] | undefined): string[] {
  const out: string[] = []
  for (const w of where ?? []) {
    const v = w.value
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(v.filter)
  }
  return out
}
