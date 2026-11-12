// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure logic behind the by-source monitoring surfaces (sidebar Sources list,
// Overview lanes and urgent callout, source page, Sources settings panel).
// No JSX, no I/O, no clock reads: kept .ts so the oracle tests run in the
// plain bundled-monitoring bun suite.
//
// Rules:
// - Order is the server's `sourceOrder` (profiled by rank, then every other
//   seen source alphabetically); a source only seen in an incident list is
//   appended alphabetically.
// - Identity hue is the profile's `hue`, else the Liaison app-colour hash of
//   the source id (`@liaison/app-ui` appHue). An urgent source never shows a
//   hue: it is drawn with the error tokens only.
// - The urgent callout exists iff a qualifying source has live incidents.
//   Qualifying: the sources a profile marks urgent; when no profile marks any
//   source urgent (no profiles at all, or none urgent), the generic default is
//   any source with a live critical incident.
import { appHue } from "@liaison/app-ui/hue"
import type { SourceProfile } from "../lib/profiles"
import type { IncidentsSummaryWithConfig, SourceHealth } from "../lib/summarize"

// The app config keys the Sources panel writes. Literal copies of the server's
// constants in ../lib/profiles (which pulls zod in through the envelope, kept
// out of the UI bundle); the oracle test pins them equal.
export const SOURCES_KEY = "monitoringSources"

export type Severity = "info" | "warning" | "critical"
export type SourceTone = "critical" | "warning" | "info" | "quiet"

/** The incident fields the by-source views read (an `incidents_list` row). */
export interface IncidentLike {
  id: string
  /** The incident's `INC-<n>` name; null (or absent) until it is numbered. */
  ref?: string | null
  source: string
  severity: string
  title: string
  status: string
  count: number
  lastSeenAt: string | null
  url?: string | null
  body?: string | null
  resolvedAt?: string | null
  resolvedBy?: string | null
  resolutionNote?: string | null
}

export interface SourceView {
  source: string
  /** Profile label, else the raw source id. */
  label: string
  /** Two letters for the hue square. */
  monogram: string
  urgent: boolean
  /** Identity hue 0..359 (unused when `urgent`). */
  hue: number
  /** Has a `monitoringSources` profile. */
  profiled: boolean
  /** Live (open + acknowledged) incidents. */
  live: number
  worstSeverity: Severity | null
  lastSeenAt: string | null
  tone: SourceTone
}

export type SummaryForSources = Pick<
  IncidentsSummaryWithConfig,
  "sources" | "profiles" | "sourceOrder"
>

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function isLive(status: string): boolean {
  return status === "open" || status === "acknowledged"
}

/** Profile hue, else the app-colour hash of the source id. */
export function sourceHue(source: string, profile?: SourceProfile | null): number {
  return typeof profile?.hue === "number" ? profile.hue : appHue(source)
}

/**
 * Two letter monogram: the initials of the first two words ("Watchdog prod" →
 * "WP", "backup-cron" → "BC", "CloudWatch" → "CW"), or the first two letters of
 * a single word ("grafana" → "GR").
 */
export function monogram(label: string): string {
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const first = words[0]
  if (!first) return "?"
  const second = words[1]
  const letters = second ? `${[...first][0]}${[...second][0]}` : [...first].slice(0, 2).join("")
  return letters.toUpperCase()
}

export function toneOf(live: number, worst: Severity | null): SourceTone {
  if (live === 0 || worst === null) return "quiet"
  return worst
}

function viewOf(
  source: string,
  health: SourceHealth | undefined,
  profile: SourceProfile | undefined,
): SourceView {
  const label = profile?.label ?? source
  const live = health?.open ?? 0
  const worst = health?.worstSeverity ?? null
  return {
    source,
    label,
    monogram: monogram(label),
    urgent: profile?.urgent === true,
    hue: sourceHue(source, profile),
    profiled: profile !== undefined,
    live,
    worstSeverity: worst,
    lastSeenAt: health?.lastSeenAt ?? null,
    tone: toneOf(live, worst),
  }
}

/**
 * One view per source in display order. `extraSources` (ids seen in an
 * incident list but absent from the summary) are appended alphabetically.
 */
export function buildSourceViews(
  summary: SummaryForSources,
  extraSources: Iterable<string> = [],
): SourceView[] {
  const health = new Map(summary.sources.map((s) => [s.source, s]))
  const profiles = new Map(summary.profiles.map((p) => [p.source, p]))
  const order = [...summary.sourceOrder]
  const known = new Set(order)
  // A health row the order missed (older server): keep it, alphabetically.
  const missing = [...new Set([...summary.sources.map((s) => s.source), ...extraSources])]
    .filter((s) => !known.has(s))
    .sort(byName)
  return [...order, ...missing].map((s) => viewOf(s, health.get(s), profiles.get(s)))
}

/** Sidebar badge style for a source row. */
export function badgeKind(view: SourceView): "critical" | "warning" | "neutral" | "clear" {
  if (view.tone === "quiet") return "clear"
  if (view.tone === "critical") return "critical"
  if (view.tone === "warning") return "warning"
  return "neutral"
}

export type SeverityFilter = "all" | Severity

export interface Lane {
  source: SourceView
  /** Live incidents of this source matching the severity filter, newest first. */
  incidents: IncidentLike[]
  /** True when the lane shows one line only (nothing live matches). */
  collapsed: boolean
}

/**
 * Overview lanes: one per source in display order, carrying that source's
 * live incidents under the severity filter. A lane with nothing to show
 * collapses to one line.
 */
export function groupBySource(
  sources: SourceView[],
  incidents: IncidentLike[],
  severity: SeverityFilter = "all",
): Lane[] {
  const bySource = new Map<string, IncidentLike[]>()
  for (const inc of incidents) {
    if (!isLive(inc.status)) continue
    if (severity !== "all" && inc.severity !== severity) continue
    const list = bySource.get(inc.source) ?? []
    list.push(inc)
    bySource.set(inc.source, list)
  }
  return sources.map((source) => {
    const list = (bySource.get(source.source) ?? []).sort((a, b) =>
      (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
    )
    return { source, incidents: list, collapsed: list.length === 0 }
  })
}

export interface UrgentCallout {
  source: SourceView
  live: number
  /** Of `live`: not yet acknowledged, and acknowledged (someone is on it). The callout
   *  says which, so an acknowledged incident is never called "open". */
  open: number
  acknowledged: number
  newest: IncidentLike | null
}

/**
 * The urgent callouts, in display order. Empty unless a qualifying source has
 * live incidents (never a callout with zero live incidents).
 */
export function urgentCallouts(sources: SourceView[], incidents: IncidentLike[]): UrgentCallout[] {
  const anyUrgent = sources.some((s) => s.urgent)
  const qualifies = (s: SourceView): boolean =>
    s.live > 0 && (anyUrgent ? s.urgent : s.worstSeverity === "critical")
  const out: UrgentCallout[] = []
  for (const s of sources) {
    if (!qualifies(s)) continue
    const mine = incidents
      .filter((i) => i.source === s.source && isLive(i.status))
      .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
    const live = Math.max(s.live, mine.length)
    const acknowledged = mine.filter((i) => i.status === "acknowledged").length
    out.push({ source: s, live, open: live - acknowledged, acknowledged, newest: mine[0] ?? null })
  }
  return out
}

/** Resolved by the source itself (the resolve envelope), not by a person. */
export function isAutoResolved(
  inc: Pick<IncidentLike, "status" | "resolvedBy" | "resolutionNote">,
): boolean {
  return (
    inc.status === "resolved" &&
    (inc.resolvedBy ?? null) === null &&
    typeof inc.resolutionNote === "string" &&
    inc.resolutionNote.startsWith("cleared by")
  )
}

/** The URL when it is an absolute http(s) link, else null (render as text). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null
  const v = url.trim()
  if (!/^https?:\/\//i.test(v)) return null
  try {
    const parsed = new URL(v)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? v : null
  } catch {
    return null
  }
}

/** Deep link to a source page (tab type `monitoring:source`). */
export function sourcePath(source: string): string {
  return `/monitoring/source/${encodeURIComponent(source)}`
}

/** Deep link to a status list page (tab type `monitoring:status`). */
export function statusPath(status: "acknowledged" | "resolved"): string {
  return `/monitoring/status/${status}`
}

/** The source id from a tab entity id, tolerant of an already decoded value. */
export function decodeSourceId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export interface SourceStats {
  openCritical: number
  openWarning: number
  resolved24h: number
  autoResolved7d: number
}

/** Source page stats over that source's incidents. */
export function sourceStats(incidents: IncidentLike[], nowMs: number): SourceStats {
  const day = nowMs - 24 * 3600_000
  const week = nowMs - 7 * 24 * 3600_000
  const stats: SourceStats = { openCritical: 0, openWarning: 0, resolved24h: 0, autoResolved7d: 0 }
  for (const inc of incidents) {
    if (inc.status === "open") {
      if (inc.severity === "critical") stats.openCritical += 1
      else if (inc.severity === "warning") stats.openWarning += 1
    }
    if (inc.status !== "resolved") continue
    const t = inc.resolvedAt ? Date.parse(inc.resolvedAt) : Number.NaN
    if (!Number.isFinite(t)) continue
    if (t >= day) stats.resolved24h += 1
    if (t >= week && isAutoResolved(inc)) stats.autoResolved7d += 1
  }
  return stats
}

// ── Sources settings panel ─────────────────────────────────────────────────

export interface DraftRow {
  source: string
  label: string
  urgent: boolean
  /** Explicit hue override, or null for the automatic hue. */
  hue: number | null
}

/** Editable rows for every seen and profiled source, in display order. */
export function draftFromSummary(summary: SummaryForSources): DraftRow[] {
  const profiles = new Map(summary.profiles.map((p) => [p.source, p]))
  return buildSourceViews(summary).map((v) => {
    const p = profiles.get(v.source)
    return {
      source: v.source,
      label: p?.label ?? "",
      urgent: p?.urgent === true,
      hue: p?.hue ?? null,
    }
  })
}

/** Move one row up (-1) or down (+1); out of range is a no-op. */
export function moveRow(rows: DraftRow[], index: number, delta: -1 | 1): DraftRow[] {
  const to = index + delta
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return rows
  const next = [...rows]
  const [row] = next.splice(index, 1)
  if (row) next.splice(to, 0, row)
  return next
}

/**
 * The `monitoringSources` value for the drafted rows: every row is profiled
 * with its position as rank (so the order sticks), plus only the fields that
 * differ from the defaults.
 */
export function profilesFromDraft(rows: DraftRow[]): SourceProfile[] {
  return rows.map((row, i) => {
    const p: SourceProfile = { source: row.source, rank: i + 1 }
    const label = row.label.trim()
    if (label && label !== row.source) p.label = label
    if (row.urgent) p.urgent = true
    if (row.hue !== null) p.hue = Math.min(359, Math.max(0, Math.round(row.hue)))
    return p
  })
}
