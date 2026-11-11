// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD FILTERS, as the web app handles them: the values in a URL
// (`?f.market=FR&f.channel=b2b&f.channel=dtc`, `f.market=` for all), which
// values a dashboard opens on (per filter: the link's, else the person's
// remembered ones, else the dashboard's defaults, as for the range), and how a
// filter's value reads on its button.
import type { DashboardFilterDef, FilterValues } from "./dashboards-client"

const PREFIX = "f."

/** The values the link carries, for the dashboard's filters only (others are ignored). */
export function filtersFromQuery(search: string, defs: DashboardFilterDef[]): FilterValues {
  const q = new URLSearchParams(search)
  const out: FilterValues = {}
  for (const def of defs) {
    const key = `${PREFIX}${def.id}`
    if (!q.has(key)) continue
    out[def.id] = normalise(def, q.getAll(key))
  }
  return out
}

/** The server's bounds on a filter's values (api filters.ts). */
export const MAX_FILTER_VALUES = 50
export const MAX_FILTER_VALUE_LENGTH = 200

/**
 * A filter's values as the server takes them: no empties, no repeats, one for a select or text,
 * a multi's sorted; a value the server would refuse (outside a static list, too long, holding
 * "{{" or "}}") is left out, so a stale or edited link never fails every block.
 */
export function normalise(def: DashboardFilterDef, values: readonly string[]): string[] {
  const allowed = staticOptions(def)
  const kept = [
    ...new Set(
      values.filter(
        (v) =>
          v !== "" &&
          v.length <= MAX_FILTER_VALUE_LENGTH &&
          !v.includes("{{") &&
          !v.includes("}}") &&
          (!allowed || allowed.includes(v)),
      ),
    ),
  ]
  return def.type === "multi" ? kept.sort().slice(0, MAX_FILTER_VALUES) : kept.slice(0, 1)
}

/** A filter's default as a list ([] = all). */
export function defaultOf(def: DashboardFilterDef): string[] {
  const d = def.default
  if (d === undefined) return []
  return normalise(def, Array.isArray(d) ? d : [d])
}

/**
 * The values a dashboard shows, filter by filter: the link's, else the person's pick in this
 * tab, else their remembered ones (the server's, which are the defaults when they saved none),
 * else the dashboard's defaults.
 */
export function effectiveFilters(
  defs: DashboardFilterDef[],
  layers: {
    url?: FilterValues
    picked?: FilterValues | null
    remembered?: FilterValues | null
    defaults?: FilterValues | null
  },
): FilterValues {
  const out: FilterValues = {}
  for (const def of defs) {
    const v =
      layers.url?.[def.id] ??
      layers.picked?.[def.id] ??
      layers.remembered?.[def.id] ??
      layers.defaults?.[def.id] ??
      defaultOf(def)
    out[def.id] = normalise(def, v)
  }
  return out
}

/** A stable key of the values: the same values give the same key, whatever their order. */
export function filtersKey(values: FilterValues): string {
  return Object.keys(values)
    .sort()
    .map((id) => `${id}=${[...(values[id] ?? [])].sort().join(",")}`)
    .join("&")
}

export function sameFilters(a: FilterValues, b: FilterValues): boolean {
  return filtersKey(a) === filtersKey(b)
}

/** `path` with the values' parameters in place of any filter parameters it had. */
export function withFiltersInPath(path: string, values: FilterValues): string {
  const [base, query = ""] = path.split("?", 2)
  const q = new URLSearchParams(query)
  for (const k of [...q.keys()]) if (k.startsWith(PREFIX)) q.delete(k)
  for (const id of Object.keys(values)) {
    const v = values[id] ?? []
    if (v.length === 0) q.append(`${PREFIX}${id}`, "")
    else for (const one of v) q.append(`${PREFIX}${id}`, one)
  }
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/** `path` without any filter parameters (back to the remembered or default values). */
export function withoutFiltersInPath(path: string): string {
  const [base, query = ""] = path.split("?", 2)
  const q = new URLSearchParams(query)
  for (const k of [...q.keys()]) if (k.startsWith(PREFIX)) q.delete(k)
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/** Does the link carry any filter value? */
export function hasFiltersInQuery(search: string): boolean {
  for (const k of new URLSearchParams(search).keys()) if (k.startsWith(PREFIX)) return true
  return false
}

/** A filter's static options, when its spec lists them (else they are read from the server). */
export function staticOptions(def: DashboardFilterDef): string[] | null {
  return Array.isArray(def.options) ? def.options.filter((o) => typeof o === "string") : null
}

/**
 * A filter's value as its button reads it: "All" for none, the value, "FR, DE" for two, or
 * "FR +2" past that.
 */
export function valueText(values: readonly string[], all: string): string {
  if (values.length === 0) return all
  if (values.length <= 2) return values.join(", ")
  return `${values[0]} +${values.length - 1}`
}
