// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Source profiles: the `monitoringSources` app config key, a JSON list of
// `{ source, label?, rank?, urgent?, hue? }` describing how each alert source
// is shown (label, order, urgent styling, identity hue override). Parsed and
// validated here, read by `incidents_summary`, so the UI has one source of
// truth. Invalid entries are dropped with one warning each (surfaced in the
// Sources settings panel). No colour is computed server-side. Pure, no I/O.
import { HTTP_URL_RE } from "../envelope"

/** App config key holding the source profile list. */
export const SOURCES_CONFIG_KEY = "monitoringSources"
/** App config key holding the optional "Detailed monitoring" link. */
export const MONITORING_URL_CONFIG_KEY = "monitoringUrl"

export interface SourceProfile {
  source: string
  label?: string
  /** Sidebar order, ascending; unranked profiles follow the ranked ones. */
  rank?: number
  /** Urgent sources get the callout and error styling, never their hue. */
  urgent?: boolean
  /** Identity hue override, integer 0..359. */
  hue?: number
}

export interface ParsedProfiles {
  profiles: SourceProfile[]
  warnings: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** One entry → a profile, or the reason it is invalid. */
function parseEntry(raw: unknown): SourceProfile | string {
  if (!isRecord(raw)) return "is not an object"
  const { source, label, rank, urgent, hue } = raw
  if (typeof source !== "string" || source.trim() === "" || source.length > 200) {
    return "source must be a non empty string"
  }
  const profile: SourceProfile = { source }
  if (label !== undefined) {
    if (typeof label !== "string" || label.length > 200) return "label must be a string"
    if (label.trim() !== "") profile.label = label.trim()
  }
  if (rank !== undefined) {
    if (typeof rank !== "number" || !Number.isFinite(rank)) return "rank must be a number"
    profile.rank = rank
  }
  if (urgent !== undefined) {
    if (typeof urgent !== "boolean") return "urgent must be true or false"
    profile.urgent = urgent
  }
  if (hue !== undefined) {
    if (typeof hue !== "number" || !Number.isInteger(hue) || hue < 0 || hue > 359) {
      return "hue must be an integer from 0 to 359"
    }
    profile.hue = hue
  }
  return profile
}

/**
 * Parse the stored `monitoringSources` value (a JSON value, or the same list
 * serialised as a string). Unset → no profiles, no warning.
 */
export function parseSourceProfiles(value: unknown): ParsedProfiles {
  if (value === null || value === undefined) return { profiles: [], warnings: [] }
  let list: unknown = value
  if (typeof value === "string") {
    try {
      list = JSON.parse(value)
    } catch {
      return { profiles: [], warnings: [`${SOURCES_CONFIG_KEY} is not valid JSON`] }
    }
  }
  if (!Array.isArray(list))
    return { profiles: [], warnings: [`${SOURCES_CONFIG_KEY} is not a list`] }

  const profiles: SourceProfile[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  list.forEach((raw, i) => {
    const parsed = parseEntry(raw)
    if (typeof parsed === "string") {
      warnings.push(`${SOURCES_CONFIG_KEY}[${i}] ignored: ${parsed}`)
      return
    }
    if (seen.has(parsed.source)) {
      warnings.push(`${SOURCES_CONFIG_KEY}[${i}] ignored: duplicate source "${parsed.source}"`)
      return
    }
    seen.add(parsed.source)
    profiles.push(parsed)
  })
  return { profiles, warnings }
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The display order of sources: profiled sources first (rank ascending,
 * unranked after ranked, ties by name), then every other seen source
 * alphabetically. Profiled sources are listed even before their first alert.
 */
export function orderSources(seen: Iterable<string>, profiles: SourceProfile[]): string[] {
  const profiled = [...profiles].sort((a, b) => {
    const ar = a.rank ?? Number.POSITIVE_INFINITY
    const br = b.rank ?? Number.POSITIVE_INFINITY
    if (ar !== br) return ar < br ? -1 : 1
    return byName(a.source, b.source)
  })
  const known = new Set(profiled.map((p) => p.source))
  const rest = [...new Set(seen)].filter((s) => !known.has(s)).sort(byName)
  return [...profiled.map((p) => p.source), ...rest]
}

/** The `monitoringUrl` config value when it is an http(s) URL, else null. */
export function parseMonitoringUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (v.length > 2000 || !HTTP_URL_RE.test(v)) return null
  return v
}
