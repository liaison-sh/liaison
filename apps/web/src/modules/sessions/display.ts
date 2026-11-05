// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSIONS APP DISPLAY RULES (P2-T06; spec-charter.md, Sessions app). Pure
// helpers every Sessions component reads, so a rule lives in one place:
//
// - `sessionState`: a row's true status, `state ?? status` (D14: the API
//   serves `needs_you` as status `waiting` for older clients, with the true
//   value in `state`). Every status read goes through it.
// - `displayStatus`: Paused while the node is offline (P2-D3; P3's real
//   `paused` rows pass through unchanged).
// - `STATUS_TONE`: running accent, waiting and needs_you warning, done success,
//   failed error, paused and queued tertiary, stopped secondary; `toneOf`
//   gives an unknown status the neutral tone (a newer API never breaks it).
// - `displayPath`: never an absolute local path (P2-D4). A path is shown
//   relative to the session's working directory.
// - `formatTimeWithZone`: every time in a tooltip names its zone.
// - `needsYouReason`: a needs_you row's reason code in words (S32, S36, S57),
//   or, for a code this client does not know, the session's own summary
//   (D14's safe fallback: never a raw key).
// - imports (W3, A44, A45, A54): `followReadOnly` (a follow-mode import takes
//   no message), `takeOverReplay` (a Take over still uploading its history: a
//   message waits for it), `autoFollowed` (an in-place session Liaison follows
//   while another Claude Code drives it), `followingVia` (the chip's "who").

import {
  AUTO_CONTINUE_MAX,
  driverData,
  isEndedSessionStatus,
  NODE_SESSION_REASON_CODES,
  type NodeSessionStatus,
  relativizePaths as relativizePathsShared,
  rowState,
} from "@liaison/shared"
import type { NodeSessionRow } from "./session-api"

type ImportFields = Pick<NodeSessionRow, "source" | "importMode" | "following">

/** W3: an imported Claude Code session (S40). */
export function isImport(row: Pick<NodeSessionRow, "source">): boolean {
  return row.source === "import"
}

/** S41, A54: a follow-mode import is a read-only mirror until taken over. */
export function followReadOnly(row: ImportFields): boolean {
  return isImport(row) && row.importMode === "follow"
}

/** A54: a Take over whose history replay still runs: a message waits for it. */
export function takeOverReplay(row: ImportFields): boolean {
  return isImport(row) && row.importMode === "take_over" && row.following === true
}

/** How long after its last line a followed session still counts as mid-turn. */
export const FOLLOW_ACTIVE_MS = 60_000
const TURN_LINES: ReadonlySet<string> = new Set([
  "assistant_text",
  "thinking",
  "tool_call",
  "tool_result",
])

/**
 * A followed session is mirrored from its transcript, which carries no
 * `result` line, so "running" alone cannot say a turn is under way. It is
 * mid-turn when its last turn (after the last prompt) has an assistant or tool
 * line, no turn end, and that line is recent (under FOLLOW_ACTIVE_MS old).
 */
export function followMidTurn(
  events: readonly { type: string; at: string }[],
  now: number,
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === "result" || e.type === "user_message") return false
    if (TURN_LINES.has(e.type)) {
      const at = Date.parse(e.at)
      return Number.isFinite(at) && now - at < FOLLOW_ACTIVE_MS
    }
  }
  return false
}

/** D28 b, A54: an in-place session followed while another Claude Code drives it. */
export function autoFollowed(row: ImportFields): boolean {
  return !isImport(row) && row.following === true
}

/**
 * The "Following …" chip's driver: the import's own (`importFrom`), else the
 * last `driver` event's `via` (an in-place follow); null when not following.
 */
export function followingVia(
  row: Pick<NodeSessionRow, "following" | "importFrom">,
  events: readonly { type: string; payload: unknown }[],
): "vscode" | "cli" | "other" | null {
  if (row.following !== true) return null
  if (row.importFrom === "vscode" || row.importFrom === "cli") return row.importFrom
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const p = e.payload as { subtype?: unknown; data?: unknown } | null
    if (e.type !== "system" || p?.subtype !== "driver") continue
    const d = driverData(p.data)
    if (d?.via) return d.via
    break
  }
  return "other"
}

/** A row's true status: `state` when the API sends it, else `status` (D14). */
export function sessionState(row: Pick<NodeSessionRow, "status" | "state">): string {
  return rowState(row)
}

/** Paused when a live session's node is offline (P2-D3). */
export function displayStatus(
  row: Pick<NodeSessionRow, "status" | "state">,
  nodeOnline: boolean,
): string {
  const status = sessionState(row)
  if ((status === "running" || status === "waiting") && !nodeOnline) return "paused"
  return status
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
  needs_you: { text: "text-warning", dot: "bg-warning", soft: "bg-warning-glow" },
  done: { text: "text-success", dot: "bg-success", soft: "bg-success-glow" },
  failed: { text: "text-error", dot: "bg-error", soft: "bg-error-glow" },
  paused: { text: "text-text-tertiary", dot: "bg-text-tertiary", soft: "bg-surface-hover" },
  queued: { text: "text-text-tertiary", dot: "bg-text-tertiary", soft: "bg-surface-hover" },
  stopped: { text: "text-text-secondary", dot: "bg-text-secondary", soft: "bg-surface-hover" },
}

/** The tone of a status this client does not know (a newer API's). */
export const NEUTRAL_TONE: StatusTone = {
  text: "text-text-tertiary",
  dot: "bg-text-tertiary",
  soft: "bg-surface-hover",
}

/** A status's tone; the neutral one for an unknown status, never a throw. */
export function toneOf(status: string): StatusTone {
  return (STATUS_TONE as Record<string, StatusTone | undefined>)[status] ?? NEUTRAL_TONE
}

/** Whether a session ended (`done`, `needs_you`, `stopped`, `failed`); false for an unknown status. */
export function isEnded(status: string): boolean {
  return isEndedSessionStatus(status)
}

/** Time spent: from the start to the end, or to `now` while it runs; 0 before it starts. */
export function elapsedMs(
  row: Pick<NodeSessionRow, "status" | "state" | "startedAt" | "endedAt" | "updatedAt">,
  now: number,
): number {
  if (!row.startedAt) return 0
  const start = Date.parse(row.startedAt)
  const end = row.endedAt
    ? Date.parse(row.endedAt)
    : isEnded(sessionState(row))
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
    case "import":
      return i18n.t("kernel.nodeSessions.origin.import")
  }
  // S9: a source this client does not know (a newer API's) reads neutrally.
  return i18n.t("kernel.nodeSessions.origin.other")
}

/**
 * The desktop header's origin, as a muted sentence: "Started by Personal agent
 * at 10:45", "Started by you at 10:45". An import says nothing here: its
 * "Imported" chip already does.
 */
export function startedByLabel(
  row: Pick<NodeSessionRow, "source" | "createdAt">,
  agentName: string,
  i18n: OriginI18n,
): string | null {
  const time = i18n.fmtDate(Date.parse(row.createdAt), { hour: "2-digit", minute: "2-digit" })
  switch (row.source) {
    case "dispatch":
      return i18n.t("kernel.nodeSessions.header.startedBy.dispatch", { agent: agentName, time })
    case "routine":
      return i18n.t("kernel.nodeSessions.header.startedBy.routine", { time })
    case "app":
      return i18n.t("kernel.nodeSessions.header.startedBy.app", { time })
    case "agent_tag":
      return i18n.t("kernel.nodeSessions.header.startedBy.agentTag", { agent: agentName, time })
    case "import":
      return null
  }
  return i18n.t("kernel.nodeSessions.header.startedBy.other", { time })
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
  // S32: the node's continue carries its consecutive count; the offline
  // resume's synthetic continue (F5b) carries none.
  if (subtype === "auto_continue") {
    return typeof d?.n === "number"
      ? t("kernel.nodeSessions.view.system.autoContinueCount", { n: d.n, max: AUTO_CONTINUE_MAX })
      : t("kernel.nodeSessions.view.system.autoContinue")
  }
  // S33: the mode the session switched to.
  if (subtype === "autonomy_changed") {
    return d?.to === "autonomous" || d?.to === "guided"
      ? t(`kernel.nodeSessions.autonomy.changed.${d.to}`)
      : text
  }
  // S24, W1-D9: the server's one line for a reasoning change, said from its data.
  if (subtype === "effort_changed") {
    const to =
      typeof d?.to === "string"
        ? t(`kernel.nodeSessions.effort.${d.to}`)
        : t("kernel.nodeSessions.reasoning.default")
    return t("kernel.nodeSessions.reasoning.changed", { level: to })
  }
  // A43: an import's first event; a window start keeps the earlier history on the computer.
  if (subtype === "imported") {
    const from = d?.from === "vscode" || d?.from === "cli" ? d.from : "other"
    const params = { from: t(`kernel.nodeSessions.import.from.${from}`) }
    return d?.historyFrom === "window"
      ? t("kernel.nodeSessions.view.system.importedWindow", params)
      : t("kernel.nodeSessions.view.system.imported", params)
  }
  // A45, A60: the follow's own notes, said from their facts.
  if (subtype === "follow") {
    if (d?.skippedLine === true) return t("kernel.nodeSessions.view.system.followSkippedLine")
    // D49 F5: a Take over's catch-up skipped the lines older than its window.
    if (typeof d?.olderLinesOmitted === "number") {
      return t("kernel.nodeSessions.view.system.followOlderLinesOmitted", {
        count: d.olderLinesOmitted,
      })
    }
    if (typeof d?.subagentsOmitted === "number") {
      return t("kernel.nodeSessions.view.system.followSubagentsOmitted", {
        count: d.subagentsOmitted,
      })
    }
    if (d?.state === "started") return t("kernel.nodeSessions.view.system.followStarted")
    if (d?.state === "ended") {
      return d.why === "transcript_gone"
        ? t("kernel.nodeSessions.view.system.followTranscriptGone")
        : t("kernel.nodeSessions.view.system.followEnded")
    }
    return text
  }
  // W3-D2: a notification Claude Code wrote as a user turn (a subagent or a
  // background task ended): a quiet line, never the person.
  if (subtype === "notification") {
    const status =
      d?.status === "failed"
        ? "failed"
        : d?.status === "stopped" || d?.status === "killed"
          ? "stopped"
          : "completed"
    return t(
      `kernel.nodeSessions.view.system.notification.${d?.agent === true ? "agent" : "task"}.${status}`,
    )
  }
  // S51: who drives the session, said from its code (the node's text is English).
  if (subtype === "driver") {
    const d = driverData(data)
    if (!d) return text
    if (!d.elsewhere) return t("kernel.nodeSessions.view.system.driverBack")
    // D33: an orphaned Claude process is named by its pid.
    return d.orphan
      ? t("kernel.nodeSessions.view.system.driver.orphan", { pid: d.orphan.pid })
      : t(`kernel.nodeSessions.view.system.driver.${d.via ?? "elsewhere"}`)
  }
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
    case "artifact_unavailable": {
      // S27, F8: the CLI turned Artifact off for this session.
      const version = typeof d.claudeCodeVersion === "string" ? d.claudeCodeVersion : ""
      return version
        ? t("kernel.nodeSessions.view.system.artifactUnavailable", { version })
        : t("kernel.nodeSessions.view.system.artifactUnavailableNoVersion")
    }
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
  "imported",
  "follow_ended",
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

const REASON_CODES: ReadonlySet<string> = new Set(NODE_SESSION_REASON_CODES)

/** A reason code this client says in words; null for an unknown one (a newer node or API). */
export function reasonCodeText(code: string | null | undefined, t: T): string | null {
  return code && REASON_CODES.has(code) ? t(`kernel.nodeSessions.reasonCode.${code}`) : null
}

/**
 * How a needs_you row says why: its code in words, the computer's own words
 * (a code the node parks with, its sentence in the summary), else the
 * session's own words (one line).
 */
export type NeedsYouReason =
  | { kind: "code"; text: string }
  | { kind: "computer"; text: string }
  | { kind: "says"; text: string }

/** Codes whose summary holds the node's own words, never the model's. */
const COMPUTER_WORDS: ReadonlySet<string> = new Set(["workspace_blocked"])

/** Whether a reason code's summary holds the computer's words (the thread card says so too). */
export function isComputerWordsCode(code: string | null | undefined): boolean {
  return !!code && COMPUTER_WORDS.has(code)
}

/**
 * W2-D7: a session's own words as one plain line. The model writes markdown
 * (`**foo**`, `` `x` ``, `[text](url)`, a heading or list marker); a line of
 * plain UI text shows the words, never the syntax. Snake_case, dunder
 * names and lone asterisks stay as written.
 */
export function plainInline(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/g, "$1")
}

export function needsYouReason(
  row: Pick<NodeSessionRow, "status" | "state" | "reasonCode" | "resultSummary">,
  t: T,
  max = Number.POSITIVE_INFINITY,
): NeedsYouReason | null {
  if (sessionState(row) !== "needs_you") return null
  const text = plainInline(row.resultSummary ?? "")
    .replace(/\s+/g, " ")
    .trim()
  const words = Array.from(text).slice(0, max).join("")
  if (isComputerWordsCode(row.reasonCode) && words) {
    return { kind: "computer", text: words }
  }
  const coded = reasonCodeText(row.reasonCode, t)
  if (coded) return { kind: "code", text: coded }
  return words ? { kind: "says", text: words } : null
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

/**
 * A needs_you reason as one line: a code in words as is, the computer's words
 * as the computer's, the model's as the session's (final recheck: the node's
 * park reason read "The session says").
 */
export function reasonLineText(r: NeedsYouReason, t: T): string {
  if (r.kind === "code") return r.text
  if (r.kind === "computer") return t("kernel.nodeSessions.notice.computerSays", { text: r.text })
  return t("kernel.nodeSessions.notice.sessionSays", { text: r.text })
}
