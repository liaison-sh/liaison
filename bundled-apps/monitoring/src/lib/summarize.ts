// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure dashboard aggregation over incident views — shared by the
// `incidents_summary` tool handler and its oracle tests. No I/O, no clock
// reads: `nowMs` is injected so results are deterministic.
import type { IncidentView } from "../incidents"
import type { SourceProfile } from "./profiles"

export interface SourceHealth {
  source: string
  /** Live (open + acknowledged) incidents attributed to this source. */
  open: number
  /** Worst live severity, or null when the source is quiet. */
  worstSeverity: "info" | "warning" | "critical" | null
  /** Most recent lastSeenAt across ALL of the source's incidents (any status). */
  lastSeenAt: string | null
  /** The source's configured profile (`monitoringSources`), or null. Set by the handler. */
  profile?: SourceProfile | null
}

export interface IncidentsSummary {
  open: { critical: number; warning: number; info: number; total: number }
  acknowledged: number
  /** Incidents resolved within the trailing 24h window. */
  resolved24h: number
  sources: SourceHealth[]
  generatedAt: string
}

/** What `incidents_summary` returns: the aggregate plus the source configuration. */
export interface IncidentsSummaryWithConfig extends IncidentsSummary {
  /** Valid `monitoringSources` profiles, in stored order. */
  profiles: SourceProfile[]
  /** One line per ignored `monitoringSources` entry. */
  warnings: string[]
  /** Display order: profiled by rank, then unprofiled seen sources alphabetically. */
  sourceOrder: string[]
  /** "Detailed monitoring" link (http/https only), or null. */
  monitoringUrl: string | null
  /** Whether the caller may edit the app config (holds `kernel:apps:admin`). */
  canConfigure: boolean
}

const SEVERITY_ORDER: Record<string, number> = { info: 0, warning: 1, critical: 2 }

function worse(a: string | null, b: string): string {
  if (a === null) return b
  return (SEVERITY_ORDER[b] ?? 0) > (SEVERITY_ORDER[a] ?? 0) ? b : a
}

/**
 * Aggregate incident views into the dashboard summary. `live` is every
 * open/acknowledged incident; `recentResolved` is a recency-ordered sample of
 * resolved incidents (bounded upstream) filtered here to the 24h window.
 */
export function summarize(
  live: IncidentView[],
  recentResolved: IncidentView[],
  nowMs: number,
): IncidentsSummary {
  const open = { critical: 0, warning: 0, info: 0, total: 0 }
  let acknowledged = 0
  const bySource = new Map<string, SourceHealth>()

  const touchSource = (inc: IncidentView, isLive: boolean): void => {
    let s = bySource.get(inc.source)
    if (!s) {
      s = { source: inc.source, open: 0, worstSeverity: null, lastSeenAt: null }
      bySource.set(inc.source, s)
    }
    if (isLive) {
      s.open += 1
      s.worstSeverity = worse(s.worstSeverity, inc.severity) as SourceHealth["worstSeverity"]
    }
    if (inc.lastSeenAt && (!s.lastSeenAt || inc.lastSeenAt > s.lastSeenAt)) {
      s.lastSeenAt = inc.lastSeenAt
    }
  }

  for (const inc of live) {
    if (inc.status === "acknowledged") acknowledged += 1
    else {
      open.total += 1
      if (inc.severity === "critical") open.critical += 1
      else if (inc.severity === "warning") open.warning += 1
      else open.info += 1
    }
    touchSource(inc, true)
  }

  const dayAgo = nowMs - 24 * 60 * 60 * 1000
  let resolved24h = 0
  for (const inc of recentResolved) {
    const t = inc.resolvedAt ? Date.parse(inc.resolvedAt) : Number.NaN
    if (Number.isFinite(t) && t >= dayAgo) resolved24h += 1
    touchSource(inc, false)
  }

  const sources = [...bySource.values()].sort((a, b) => {
    // Loudest first: live count desc, then worst severity desc, then recency.
    if (b.open !== a.open) return b.open - a.open
    const sw =
      (SEVERITY_ORDER[b.worstSeverity ?? ""] ?? -1) - (SEVERITY_ORDER[a.worstSeverity ?? ""] ?? -1)
    if (sw !== 0) return sw
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")
  })

  return {
    open,
    acknowledged,
    resolved24h,
    sources,
    generatedAt: new Date(nowMs).toISOString(),
  }
}
