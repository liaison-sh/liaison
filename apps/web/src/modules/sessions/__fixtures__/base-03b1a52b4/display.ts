// SPDX-License-Identifier: FSL-1.1-ALv2
// @ts-nocheck
// FIXTURE: this file as it was at commit 03b1a52b4 (git show 03b1a52b4:apps/web/src/modules/sessions/display.ts),
// only its relative imports re-pointed. old-client.test.tsx runs it as an older client would.
//
//
// THE SESSIONS APP DISPLAY RULES (P2-T06; spec-charter.md, Sessions app). Pure
// helpers every Sessions component reads, so a rule lives in one place:
//
// - `displayStatus`: Paused while the node is offline (P2-D3; P3's real
//   `paused` rows pass through unchanged).
// - `STATUS_TONE`: running accent, waiting warning, done success, failed error,
//   paused and queued tertiary, stopped secondary.
// - `displayPath`: never an absolute local path (P2-D4). A path is shown
//   relative to the session's working directory.
// - `formatTimeWithZone`: every time in a tooltip names its zone.

import { type NodeSessionStatus, relativizePaths as relativizePathsShared } from "@liaison/shared"
import type { NodeSessionRow } from "../../session-api"

/** Paused when a live session's node is offline (P2-D3). */
export function displayStatus(
  row: Pick<NodeSessionRow, "status">,
  nodeOnline: boolean,
): NodeSessionStatus {
  if ((row.status === "running" || row.status === "waiting") && !nodeOnline) return "paused"
  return row.status
}

export interface StatusTone {
  /** Text colour (the pill's label, a row's status). */
  text: string
  /** Solid fill (a status dot). */
  dot: string
  /** Soft fill (a pill's background). */
  soft: string
}

export const STATUS_TONE: Record<NodeSessionStatus, StatusTone> = {
  running: { text: "text-accent", dot: "bg-accent", soft: "bg-accent-glow" },
  waiting: { text: "text-warning", dot: "bg-warning", soft: "bg-warning-glow" },
  done: { text: "text-success", dot: "bg-success", soft: "bg-success-glow" },
  failed: { text: "text-error", dot: "bg-error", soft: "bg-error-glow" },
  paused: { text: "text-text-tertiary", dot: "bg-text-tertiary", soft: "bg-surface-hover" },
  queued: { text: "text-text-tertiary", dot: "bg-text-tertiary", soft: "bg-surface-hover" },
  stopped: { text: "text-text-secondary", dot: "bg-text-secondary", soft: "bg-surface-hover" },
}

const ENDED: ReadonlySet<NodeSessionStatus> = new Set(["done", "stopped", "failed"])

export function isEnded(status: NodeSessionStatus): boolean {
  return ENDED.has(status)
}

/** Time spent: from the start to the end, or to `now` while it runs; 0 before it starts. */
export function elapsedMs(
  row: Pick<NodeSessionRow, "status" | "startedAt" | "endedAt" | "updatedAt">,
  now: number,
): number {
  if (!row.startedAt) return 0
  const start = Date.parse(row.startedAt)
  const end = row.endedAt
    ? Date.parse(row.endedAt)
    : isEnded(row.status)
      ? Date.parse(row.updatedAt)
      : now
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

/** "42 s", "23 min", "1 h 42 min" (the units read the same in English and French). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/** A date and time with its zone, for a tooltip (charter: never a time without a zone). */
export function formatTimeWithZone(iso: string | number, locale: string): string {
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(d)
}

/** "850", "412k", "1.9M". */
export function formatTokens(n: number, locale = "en"): string {
  const v = Math.max(0, Math.round(n || 0))
  if (v < 1000) return String(v)
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`
  return `${fmt.format(Math.round(v / 100_000) / 10)}M`
}

interface OriginI18n {
  t: (key: string, params?: Record<string, string | number>) => string
  fmtDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
}

/** Where the session came from: "Personal agent · 11:27", "Routine", "You". */
export function originLabel(
  row: Pick<NodeSessionRow, "source" | "createdAt">,
  agentName: string,
  i18n: OriginI18n,
): string {
  switch (row.source) {
    case "dispatch":
      return i18n.t("kernel.nodeSessions.origin.dispatch", {
        agent: agentName,
        time: i18n.fmtDate(Date.parse(row.createdAt), { hour: "2-digit", minute: "2-digit" }),
      })
    case "routine":
      return i18n.t("kernel.nodeSessions.origin.routine")
    case "app":
      return i18n.t("kernel.nodeSessions.origin.app")
    case "agent_tag":
      return i18n.t("kernel.nodeSessions.origin.agentTag", { agent: agentName })
  }
  return ""
}

/** "<version> <installed|bundled> <path>" as the start event reports it (D30). */
export function parseClaudeCode(value: string | null | undefined): {
  version: string
  source: string
  path: string
} | null {
  if (!value) return null
  const [version, source, ...rest] = value.trim().split(/\s+/)
  if (!version) return null
  return { version, source: source ?? "", path: rest.join(" ") }
}

type T = (key: string, params?: Record<string, string | number | boolean>) => string

const LEVEL_IDS = new Set(["strict", "standard", "open"])
const SOURCES = new Set(["installed", "bundled"])

/**
 * P1-walk D15: a node `system` line in the viewer's language. The node sends
 * its facts in `data` (and a plain English `text` for any older client); the
 * known subtypes are said from the facts, anything else keeps the text.
 */
export function systemText(subtype: string, text: string, data: unknown, t: T): string {
  const d = (data && typeof data === "object" ? data : null) as Record<string, unknown> | null
  // Walk D12: the CLI's rate limit notice, said whatever its data.
  if (subtype === "rate_limit") {
    if (d?.status === "rejected") return t("kernel.nodeSessions.view.system.rateLimitReached")
    if (d?.status === "allowed_warning") return t("kernel.nodeSessions.view.system.rateLimitNear")
    return t("kernel.nodeSessions.view.system.rateLimit")
  }
  if (subtype === "auto_continue") return t("kernel.nodeSessions.view.system.autoContinue")
  if (!d) return text
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  switch (subtype) {
    case "start": {
      const source = typeof d.claudeCodeSource === "string" ? d.claudeCodeSource : ""
      const level =
        typeof d.level === "string" ? d.level : (/started at (\w+)\s*$/.exec(text)?.[1] ?? "")
      if (!SOURCES.has(source) || !LEVEL_IDS.has(level)) return text
      const params = {
        source: t(`kernel.nodeSessions.view.claudeCodeSource.${source}`),
        level: t(`kernel.nodeSessions.level.${level}`),
      }
      const version = typeof d.claudeCodeVersion === "string" ? d.claudeCodeVersion : ""
      return version
        ? t("kernel.nodeSessions.view.system.start", { ...params, version })
        : t("kernel.nodeSessions.view.system.startNoVersion", params)
    }
    case "settings_filtered": {
      const keys = list(d.userKeysNotMirrored)
      const skipped = Array.isArray(d.mcpSkipped)
        ? d.mcpSkipped
            .map((m) => (m as { name?: unknown } | null)?.name)
            .filter((n): n is string => typeof n === "string")
        : []
      const parts = [
        d.hooksOff === true ? t("kernel.nodeSessions.view.system.hooksOff") : null,
        keys.length > 0
          ? t("kernel.nodeSessions.view.system.notApplied", { keys: keys.join(", ") })
          : null,
        skipped.length > 0
          ? t("kernel.nodeSessions.view.system.mcpSkipped", { names: skipped.join(", ") })
          : null,
      ].filter((x): x is string => x !== null)
      return parts.length > 0 ? parts.join("; ") : text
    }
    case "allowed_for_session":
      return typeof d.tool === "string"
        ? t("kernel.nodeSessions.view.system.allowedForSession", { tool: d.tool })
        : text
    case "still_queued":
      return typeof d.count === "number"
        ? t("kernel.nodeSessions.view.system.stillQueued", { count: d.count })
        : text
  }
  return text
}

/** The status reasons the server writes (lifecycle.ts, jobs.ts, commands.ts). */
const STATUS_REASONS = new Set([
  "node_offline",
  "node_silent",
  "node_back",
  "replaced",
  "discarded",
  "stopped_by_owner",
  "resume_offline",
  "resume_message",
  "resume_crash",
  "resume_level",
  "rerun",
])

/**
 * Walk D12: a status event's reason in words. A server code is said from the
 * catalogue, a waiting reason ("permission: Write") as what is waited for; an
 * unknown code shows nothing, never itself.
 */
export function statusReasonText(reason: string, t: T): string {
  if (!reason) return ""
  if (STATUS_REASONS.has(reason)) return t(`kernel.nodeSessions.statusReason.${reason}`)
  const sep = reason.indexOf(":")
  if (sep > 0) {
    const kind = reason.slice(0, sep)
    const rest = reason.slice(sep + 1).trim()
    if (kind === "permission" && rest) {
      return t("kernel.nodeSessions.statusReason.permission", { tool: rest })
    }
    if (kind === "question") return t("kernel.nodeSessions.statusReason.question")
    if (kind === "plan") return t("kernel.nodeSessions.statusReason.plan")
  }
  return ""
}

/** Walk D12: a count with its noun, singular for one (`<key>One`), plural otherwise. */
export function countText(t: T, key: string, count: number): string {
  return t(count === 1 ? `${key}One` : key, { count })
}

// The path rules live in @liaison/shared so the server (the session push, P4)
// relativizes a title exactly as the web shows it.
export { displayPath, type PathContext, relativizePaths } from "@liaison/shared"

/** Walk D16: a session's title as shown (its prompt may name absolute paths). */
export function sessionTitle(
  row: Pick<NodeSessionRow, "id" | "title" | "folderName" | "repo">,
): string {
  return relativizePathsShared(row.title, {
    sessionId: row.id,
    folderName: row.folderName,
    repo: row.repo,
  })
}
