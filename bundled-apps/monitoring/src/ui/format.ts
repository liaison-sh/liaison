// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure presentation logic for the monitoring surfaces — severity/status
// mapping and the age humanizer. Kept .ts (no JSX) so the oracle tests run in
// the plain bundled-monitoring bun suite.
//
// Temporal-sanity rule (gestalt standing oracle, same contract as the shopify
// lists humanizer): never emit a raw hours figure above 72h or an absurd
// magnitude — roll up to days, then months, then years.
import { tr, uiLocale } from "./i18n"
import type { BadgeTone } from "./kit"

export function severityMeta(severity: string | null | undefined): {
  tone: BadgeTone
  label: string
} {
  switch (severity) {
    case "critical":
      return { tone: "error", label: tr("Critical") }
    case "warning":
      return { tone: "warning", label: tr("Warning") }
    case "info":
      return { tone: "accent", label: tr("Info") }
    default:
      return { tone: "muted", label: "-" }
  }
}

export function statusMeta(status: string | null | undefined): { tone: BadgeTone; label: string } {
  switch (status) {
    case "open":
      return { tone: "error", label: tr("Open") }
    case "acknowledged":
      return { tone: "warning", label: tr("Acknowledged") }
    case "resolved":
      return { tone: "success", label: tr("Resolved") }
    default:
      return { tone: "muted", label: "-" }
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * Compact age for board rows: "just now", "4m ago", "3h ago", "2d ago",
 * "5mo ago", "1y ago". Never emits hours above 72 (rolls to days at 24h),
 * never emits days above 60 (rolls to months), never a raw minute figure
 * above 59. Future or unparseable timestamps degrade to "—".
 */
export function formatAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "-"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "-"
  const delta = nowMs - t
  // Small negative deltas are server/client clock skew on a fresh timestamp,
  // not a future event — render "just now" instead of a dash.
  if (delta < -2 * MIN) return "-"
  const locale = uiLocale()
  // Other languages phrase the same figure through Intl ("il y a 4 min"): a
  // French board read "9m ago" under French chrome.
  const say = (n: number, unit: Intl.RelativeTimeFormatUnit, en: string) =>
    locale.startsWith("en")
      ? `${n}${en} ago`
      : new Intl.RelativeTimeFormat(locale, {
          numeric: "always",
          style: unit === "month" || unit === "year" ? "long" : "short",
        }).format(-n, unit)
  if (delta < MIN) return tr("just now")
  if (delta < HOUR) return say(Math.floor(delta / MIN), "minute", "m")
  if (delta < DAY) return say(Math.floor(delta / HOUR), "hour", "h")
  if (delta < 2 * MONTH) return say(Math.floor(delta / DAY), "day", "d")
  if (delta < YEAR) return say(Math.floor(delta / MONTH), "month", "mo")
  return say(Math.floor(delta / YEAR), "year", "y")
}

/** Absolute timestamp for detail views, locale-stable UTC-less display. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "-"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "-"
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Deep-link path for an incident tab (kernel tab type monitoring:incident). */
export function incidentPath(id: string): string {
  return `/monitoring/incident/${encodeURIComponent(id)}`
}

// ─────────────────────────────────────────────────────────────────────────
// Phone columns (spec-responsive.md).
//
// The incident table is a comparison table, so at 390 px it declares which
// columns survive rather than collapsing into cards. The rest stay in the row
// and paint as a stacked block once the operator expands it, so every cell is
// written once and the table gains no column.
// ─────────────────────────────────────────────────────────────────────────
export interface IncidentColumn {
  key: string
  survivesPhone?: boolean
}

export const INCIDENT_COLUMNS: IncidentColumn[] = [
  { key: "severity", survivesPhone: true },
  { key: "incident", survivesPhone: true },
  { key: "source" },
  { key: "count" },
  { key: "last_seen" },
  { key: "status" },
  { key: "actions", survivesPhone: true },
]

export function phoneCellClass(key: string, cols: IncidentColumn[], expanded: boolean): string {
  if (cols.find((c) => c.key === key)?.survivesPhone) return ""
  return expanded ? "block md:table-cell" : "hidden md:table-cell"
}

/** "N open incident(s)" agreeing in number, in the reader's language. */
export function openIncidentsLabel(count: number): string {
  return count === 1
    ? tr("{{count}} open incident", { count })
    : tr("{{count}} open incidents", { count })
}

/** "N acknowledged incident(s)" agreeing in number, in the reader's language. */
export function acknowledgedIncidentsLabel(count: number): string {
  return count === 1
    ? tr("{{count}} acknowledged incident", { count })
    : tr("{{count}} acknowledged incidents", { count })
}

/** A source's live incidents by status: "2 open incidents", "1 acknowledged incident", or
 *  "1 open, 1 acknowledged". An acknowledged incident is never counted as open. */
export function liveIncidentsLabel(open: number, acknowledged: number): string {
  if (acknowledged === 0) return openIncidentsLabel(open)
  if (open === 0) return acknowledgedIncidentsLabel(acknowledged)
  return tr("{{open}} open, {{acknowledged}} acknowledged", { open, acknowledged })
}

// ─────────────────────────────────────────────────────────────────────────
// Activity (comments and archived episodes) on the incident detail.
// ─────────────────────────────────────────────────────────────────────────

/** Who wrote an activity entry: the system (no author), a known member, or an unknown one. */
export function activityAuthorLabel(
  authorId: string | null,
  names: Map<string, string> | undefined,
): string {
  if (authorId === null) return tr("System")
  return names?.get(authorId) ?? tr("a teammate")
}

/** An alert body this long starts collapsed (more than 300 characters or more than 4 lines). */
export function isLongText(text: string | null | undefined): boolean {
  if (!text) return false
  return text.length > 300 || text.split("\n").length > 4
}

/** The server's comment error codes as sentences; any other message is shown as is. */
export function commentErrorText(message: string): string {
  if (message.includes("empty_comment")) return tr("Write a comment before adding it.")
  if (message.includes("comment_too_long"))
    return tr("The comment is too long (4000 characters at most).")
  return message
}
