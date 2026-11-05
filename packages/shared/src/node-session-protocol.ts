// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE SESSION PROTOCOL (spec-protocol.md): the status, source and event
// vocabulary a node session speaks, the caps on events and batches, and the
// one byte measure both sides use. The API validates ingest with these
// schemas, the sidecar checks its normaliser output against them, the web
// renders from these types. Nothing here imports outside packages/shared.

import { z } from "zod"
import { NODE_LEVELS } from "./node-levels"

export const NODE_SESSION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "done",
  "needs_you",
  "stopped",
  "failed",
] as const
export type NodeSessionStatus = (typeof NODE_SESSION_STATUSES)[number]

/** Statuses a session has finished in (a run ended; a message may reopen it). */
export const NODE_SESSION_ENDED_STATUSES = ["done", "needs_you", "stopped", "failed"] as const
/** Statuses that ask for the person's attention. */
export const NODE_SESSION_NEEDS_YOU_STATUSES = ["waiting", "needs_you"] as const

export function isEndedSessionStatus(status: string): boolean {
  return (NODE_SESSION_ENDED_STATUSES as readonly string[]).includes(status)
}
export function isNeedsYouStatus(status: string): boolean {
  return (NODE_SESSION_NEEDS_YOU_STATUSES as readonly string[]).includes(status)
}
export function isKnownSessionStatus(status: string): status is NodeSessionStatus {
  return (NODE_SESSION_STATUSES as readonly string[]).includes(status)
}

/** The status older clients can read: `needs_you` travels as `waiting` (D14). */
export function wireStatus(status: NodeSessionStatus): NodeSessionStatus {
  return status === "needs_you" ? "waiting" : status
}
/** The true status of an outward row: `state` when present, else `status`. */
export function rowState(row: { status: string; state?: string | null }): string {
  return row.state ?? row.status
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** The host MCP server and the two tools a session uses to signal its own end. */
export const HOST_MCP_SERVER = "liaison_session"
export const NODE_SESSION_HOST_TOOLS = [
  "mcp__liaison_session__mark_done",
  "mcp__liaison_session__needs_you",
] as const

/**
 * A session row's reason line as a code the client localises, set by the
 * server's event fold: another Claude Code drives it (S51) or it stopped at
 * its hard token limit. Null on the row: the session's own words are the
 * reason (`resultSummary`).
 */
export const NODE_SESSION_REASON_CODES = [
  "driven_elsewhere_vscode",
  "driven_elsewhere_cli",
  "driven_elsewhere",
  "token_limit",
  "stuck_after_5_continues",
  "auto_continue_cap",
  "atelier_awaiting",
  "pr_missing",
  "push_failed",
  "imported",
  "follow_ended",
  /** The node itself parked the session before the model ran (its folder is
   * held by another session, git refused the switch); the words are the node's. */
  "workspace_blocked",
] as const
export type NodeSessionReasonCode = (typeof NODE_SESSION_REASON_CODES)[number]

/** How a run ended, as the node reports it with the result. */
export const nodeSessionCompletionSchema = z
  .object({
    by: z.enum(["session", "needs_you", "owner", "atelier"]),
    summary: z.string().max(300).optional(),
    reason: z.string().max(300).optional(),
    /** S57: the pull request a finished run opened; https only. */
    prUrl: z
      .string()
      .max(500)
      .refine((u) => URL.canParse(u) && new URL(u).protocol === "https:", {
        message: "https URL",
      })
      .optional(),
    reasonCode: z.enum(NODE_SESSION_REASON_CODES).optional(),
  })
  .strict()
export type NodeSessionCompletion = z.infer<typeof nodeSessionCompletionSchema>

/** The keys a protocol-3 server's strict completion schema accepts. */
export const PROTOCOL3_COMPLETION_KEYS = ["by", "summary", "reason"] as const

/**
 * The completion a node sends to a server older than wave 2: `atelier` becomes
 * `session`, `prUrl` and `reasonCode` are dropped (a code's text survives in
 * `reason` when there is none).
 */
export function toProtocol3Completion(c: NodeSessionCompletion): {
  by: "session" | "needs_you" | "owner"
  summary?: string
  reason?: string
} {
  const out: { by: "session" | "needs_you" | "owner"; summary?: string; reason?: string } = {
    by: c.by === "atelier" ? "session" : c.by,
  }
  if (c.summary !== undefined) out.summary = c.summary
  const reason = c.reason !== undefined && c.reason !== "" ? c.reason : c.reasonCode
  if (reason !== undefined) out.reason = reason
  return out
}

// ---- wave 2: autonomy, Atelier, finishing (S30-S39, S57) ----

export const AUTONOMY_LEVELS = ["guided", "autonomous"] as const
export type Autonomy = (typeof AUTONOMY_LEVELS)[number]

export const FINISH_WITH = ["pr", "commit", "none"] as const
export type FinishWith = (typeof FINISH_WITH)[number]

/** Consecutive empty auto-continues before the session asks for the person (D15). */
export const AUTO_CONTINUE_MAX = 5
/** Absolute cap of auto-continues per run (A36). */
export const AUTO_CONTINUE_TOTAL_MAX = 30
/**
 * The G4 flag (OPEN-5, D40): in place below Open on a default or protected
 * branch, with a commit or PR finish, the node itself starts the session's own
 * branch at run start (the session never switches). `false` restores W1.
 */
export const IN_PLACE_NEW_BRANCH_BELOW_OPEN = true
export const AUTO_CONTINUE_TEXT =
  "Continue: decide with sensible defaults, record your assumptions, and call mark_done when the task is finished or needs_you if you are truly blocked."

/** The env names the host contract hands an Atelier run (A26). */
export const ATELIER_HOST_ENV = [
  "ATELIER_AUTONOMY",
  "ATELIER_HOST",
  "ATELIER_HOST_DONE_TOOL",
  "ATELIER_HOST_NEEDS_YOU_TOOL",
  "ATELIER_HOST_FINISH",
] as const

/** The per-turn credential header (D36). */
export const NODE_TURN_CREDENTIAL_HEADER = "x-liaison-turn"
export const NODE_PROTOCOL_AUTONOMY = 4
/** Wave 3: session import and the follow host (S40-S44, D28 b). */
export const NODE_PROTOCOL_IMPORT = 5

/** How an import continues (A51): follow read-only, or take over in place. */
export const NODE_IMPORT_MODES = ["follow", "take_over"] as const
export type NodeImportMode = (typeof NODE_IMPORT_MODES)[number]
/** Which Claude Code started an imported session, as stored on the row. */
export const NODE_IMPORT_FROM = ["vscode", "cli", "other"] as const
export type NodeImportFrom = (typeof NODE_IMPORT_FROM)[number]

/** The Atelier `state.json` as the sidecar reader clips it and the store parses it (S35). */
export const nodeSessionAtelierStateSchema = z
  .object({
    id: z.string().max(80),
    rung: z.string().max(8),
    phase: z.string().max(40),
    plan: z.array(z.string().max(40)).max(12),
    done: z.array(z.string().max(40)).max(12),
    status: z.enum(["running", "complete", "failed"]),
    awaiting: z.enum(["user", "workflow"]).nullable(),
    failureReason: z.string().max(300).optional(),
    boards: z
      .array(
        z
          .object({
            title: z.string().max(80),
            url: z.string().refine((u) => URL.canParse(u) && new URL(u).protocol === "https:", {
              message: "https URL",
            }),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict()
export type NodeSessionAtelierState = z.infer<typeof nodeSessionAtelierStateSchema>

export const NODE_SESSION_SOURCES = ["dispatch", "app", "routine", "agent_tag", "import"] as const
export type NodeSessionSource = (typeof NODE_SESSION_SOURCES)[number]

export const NODE_SESSION_CONFIG_KINDS = ["owner", "isolated"] as const
export type NodeSessionConfigKind = (typeof NODE_SESSION_CONFIG_KINDS)[number]

export const NODE_SESSION_EVENT_TYPES = [
  "user_message",
  "assistant_text",
  "thinking",
  "tool_call",
  "tool_result",
  "todo",
  "permission_request",
  "question",
  "plan_request",
  "decision",
  "command_applied",
  "status",
  "usage",
  "model_changed",
  "level_changed",
  "resumed",
  "result",
  "system",
] as const
export type NodeSessionEventType = (typeof NODE_SESSION_EVENT_TYPES)[number]

// ---- payloads, one per event type (spec-protocol.md §Events) ----

export interface NodeSessionTodoItem {
  content: string
  status: string
  activeForm?: string
}

export interface NodeSessionEventPayloads {
  user_message: { text: string; commandId?: string }
  assistant_text: { text: string }
  thinking: { text: string }
  tool_call: { id: string; name: string; input: unknown }
  tool_result: { id: string; isError: boolean; output: string }
  todo: { items: NodeSessionTodoItem[]; from: "TodoWrite" | "Task" }
  permission_request: { requestId: string; tool: string; input: unknown; reason: string }
  question: { requestId: string; questions: unknown }
  plan_request: { requestId: string; plan: string }
  decision: {
    requestId: string
    outcome: "allow" | "allow_session" | "deny" | "answered" | "expired"
    by: "owner" | "stop" | "process_exit"
  }
  command_applied: {
    commandId: string
    type: string
    outcome: "applied" | "noop" | "cancelled" | "failed"
    error?: string
  }
  status: { status: NodeSessionStatus; reason?: string }
  usage: {
    tokensIn: number
    tokensOut: number
    model: string
    cacheRead?: number
    cacheWrite5m?: number
    cacheWrite1h?: number
    contextTokens?: number
  }
  model_changed: { from: string; to: string }
  level_changed: { from: string; to: string }
  resumed: { after: "offline" | "message" | "crash" | "level" | "autonomy" }
  result: {
    text: string
    isError: boolean
    subtype: string
    branch?: string
    pushed?: boolean
    prUrl?: string
    contextWindow?: number
  }
  system: { subtype: string; text: string; data?: unknown }
}

/** Subtypes of `system` events the node forwards or the server writes. */
export const NODE_SESSION_SYSTEM_SUBTYPES = [
  "task_started",
  "task_progress",
  "task_notification",
  "task_updated",
  "marked_done",
  "marked_needs_you",
  "effort_changed",
  "driver",
  "auto_continue",
  "atelier",
  "atelier_invalid",
  "autonomy_changed",
  "imported",
  "follow",
  "notification",
] as const

// ---- one driver at a time (S51, owner D13) ----

/** Who else drives an in-place owner session, as the node can tell it. */
export const NODE_SESSION_DRIVERS = ["vscode", "cli"] as const
export type NodeSessionDriver = (typeof NODE_SESSION_DRIVERS)[number]

/**
 * The `data` of a `system` event with subtype `driver` (S51): `elsewhere`
 * true while another Claude Code (VS Code, a terminal) drives the session and
 * Liaison only follows it read-only; false once it stopped. `via` says which,
 * when the node could tell (null: unknown, or not driven).
 */
export interface NodeSessionDriverData {
  elsewhere: boolean
  via: NodeSessionDriver | null
  /**
   * D33: the driver is an orphaned Claude process (parent launchd): its pid,
   * and the CLI's session id the desktop's "Stop it" re-checks it against.
   * The reader always sets it (null: none); on the wire the node writes
   * `orphanPid` and `cliSessionId` instead.
   */
  orphan?: NodeSessionOrphan | null
}

export interface NodeSessionOrphan {
  pid: number
  cliSessionId: string | null
}

/** A `driver` event's data, or null when it is not one (the web's reader). */
export function driverData(data: unknown): NodeSessionDriverData | null {
  const d = data as {
    elsewhere?: unknown
    via?: unknown
    orphanPid?: unknown
    cliSessionId?: unknown
  } | null
  if (!d || typeof d.elsewhere !== "boolean") return null
  const via = (NODE_SESSION_DRIVERS as readonly unknown[]).includes(d.via)
    ? (d.via as NodeSessionDriver)
    : null
  const pid = d.orphanPid
  const orphan =
    d.elsewhere && typeof pid === "number" && Number.isInteger(pid) && pid > 1
      ? { pid, cliSessionId: typeof d.cliSessionId === "string" ? d.cliSessionId : null }
      : null
  return { elsewhere: d.elsewhere, via, orphan }
}

/**
 * The code a `message` command settles `failed` with when it would start a
 * run of a session driven elsewhere without `confirmDrivenElsewhere` (S51):
 * the web asks for a second click, then sends it confirmed.
 */
export const DRIVEN_ELSEWHERE_CODE = "driven_elsewhere"

/** An event as the node sends it. The payload is a plain record on the wire. */
export interface NodeSessionEventIn {
  at: string
  type: NodeSessionEventType
  parentToolUseId?: string
  payload: Record<string, unknown>
  truncated?: boolean
  fullBytes?: number
}

/** An event as the server stores it: the node's event plus its order and arrival. */
export type NodeSessionEvent = NodeSessionEventIn & { seq: number; receivedAt: string }

// ---- limits and the one byte measure (K4) ----

export const NODE_EVENT_LIMITS = {
  fieldBytes: 65536,
  eventBytes: 262144,
  batchEvents: 256,
  batchBytes: 1048576,
  nodeBatchMargin: 16384,
} as const

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

/** The UTF-8 byte length of the event's JSON. The server refuses on exactly this. */
export function eventBytes(e: NodeSessionEventIn): number {
  return utf8Bytes(JSON.stringify(e))
}

/** The UTF-8 byte length of the batch's JSON array, brackets and commas included. */
export function batchBytes(events: readonly NodeSessionEventIn[]): number {
  return utf8Bytes(JSON.stringify(events))
}

/** Cut a string to at most `maxBytes` UTF-8 bytes, never inside a code point. */
function cutUtf8(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s)
  if (bytes.length <= maxBytes) return s
  let end = Math.max(0, maxBytes)
  // Back off over continuation bytes (10xxxxxx) to the start of a code point.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return decoder.decode(bytes.subarray(0, end))
}

type Json = unknown

/** Rebuild a value with every string mapped through `fn`. */
function mapStrings(value: Json, fn: (s: string) => string): Json {
  if (typeof value === "string") return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn)
    return out
  }
  return value
}

/** Every string in a value, in walk order, with its UTF-8 size. */
function stringSizes(value: Json, into: number[] = []): number[] {
  if (typeof value === "string") into.push(utf8Bytes(value))
  else if (Array.isArray(value)) for (const v of value) stringSizes(v, into)
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringSizes(v, into)
  return into
}

/** Halve the string at walk position `target` (UTF-8 bytes, on a code-point boundary). */
function halveAt(value: Json, target: number): Json {
  let i = -1
  return mapStrings(value, (s) => {
    i++
    return i === target ? cutUtf8(s, Math.floor(utf8Bytes(s) / 2)) : s
  })
}

const OMITTED_KEEP = ["id", "requestId", "toolUseId"] as const
const HALVING_ROUNDS = 64
const HALVING_FLOOR = 1024

/**
 * Cap an event (R21, K20): every string in the payload at 64 KiB, then while
 * the event is over 256 KiB halve its longest string over 1 KiB (at most 64
 * rounds), and if it still does not fit replace the payload with
 * `{omitted: true}` plus its id fields. Anything cut sets `truncated` and
 * `fullBytes` (the original size). Idempotent.
 */
export function capEvent(e: NodeSessionEventIn): NodeSessionEventIn {
  const originalBytes = e.fullBytes ?? eventBytes(e)
  let cut = false
  let payload = mapStrings(e.payload, (s) => {
    const c = cutUtf8(s, NODE_EVENT_LIMITS.fieldBytes)
    if (c !== s) cut = true
    return c
  }) as Record<string, unknown>

  const build = (p: Record<string, unknown>): NodeSessionEventIn =>
    cut ? { ...e, payload: p, truncated: true, fullBytes: originalBytes } : { ...e, payload: p }

  let out = build(payload)
  for (
    let round = 0;
    round < HALVING_ROUNDS && eventBytes(out) > NODE_EVENT_LIMITS.eventBytes;
    round++
  ) {
    const sizes = stringSizes(payload)
    let target = -1
    let longest = HALVING_FLOOR
    sizes.forEach((size, i) => {
      if (size > longest) {
        longest = size
        target = i
      }
    })
    if (target < 0) break
    payload = halveAt(payload, target) as Record<string, unknown>
    cut = true
    out = build(payload)
  }

  if (eventBytes(out) > NODE_EVENT_LIMITS.eventBytes) {
    const kept: Record<string, unknown> = { omitted: true }
    for (const key of OMITTED_KEEP) if (key in e.payload) kept[key] = e.payload[key]
    cut = true
    out = build(kept)
  }
  return cut ? out : e
}

/**
 * Consecutive slices of at most 256 events and `maxBytes` by batchBytes. The
 * node splits under the server's limit by a margin so a boundary batch never
 * meets a 413 (K4). An event alone over `maxBytes` goes in a batch of its own.
 */
export function splitIntoBatches(
  events: readonly NodeSessionEventIn[],
  maxBytes: number = NODE_EVENT_LIMITS.batchBytes - NODE_EVENT_LIMITS.nodeBatchMargin,
): NodeSessionEventIn[][] {
  const batches: NodeSessionEventIn[][] = []
  let current: NodeSessionEventIn[] = []
  let currentBytes = 2 // "[]"
  for (const e of events) {
    const size = eventBytes(e)
    const added = current.length === 0 ? size : size + 1 // a comma before every event but the first
    if (
      current.length > 0 &&
      (current.length >= NODE_EVENT_LIMITS.batchEvents || currentBytes + added > maxBytes)
    ) {
      batches.push(current)
      current = []
      currentBytes = 2
    }
    currentBytes += current.length === 0 ? size : size + 1
    current.push(e)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// ---- schemas (K3, K11) ----

export const nodeSessionEventInSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  type: z.enum(NODE_SESSION_EVENT_TYPES),
  parentToolUseId: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()),
  truncated: z.boolean().optional(),
  fullBytes: z.number().int().nonnegative().optional(),
})

export const nodeSessionBatchSchema = z.object({
  jobId: z.uuid(),
  leaseGeneration: z.number().int().positive(),
  batchNo: z.number().int().positive(),
  events: z.array(nodeSessionEventInSchema).max(NODE_EVENT_LIMITS.batchEvents),
})

// ---- job to session (spec-protocol.md §Job-to-session mapping) ----

export type NodeJobStatusForSession =
  | "queued"
  | "offered"
  | "running"
  | "done"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "refused"
  | "fell_back"

/** The session status a job status shows as; null where a job has no session row. */
export function sessionStatusForJob(
  jobStatus: NodeJobStatusForSession,
  {
    pendingCount,
    nodeOnline,
    completed,
  }: { pendingCount: number; nodeOnline: boolean; completed?: boolean },
): NodeSessionStatus | null {
  switch (jobStatus) {
    case "queued":
    case "offered":
      return "queued"
    case "running":
      if (pendingCount > 0) return "waiting"
      if (!nodeOnline) return "paused"
      return "running"
    case "done":
      return completed === false ? "needs_you" : "done"
    case "failed":
    case "interrupted":
      return "failed"
    case "cancelled":
      return "stopped"
    case "refused":
    case "fell_back":
      return null
  }
}

// ---- titles and the card's activity line ----

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ""
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join("")
}

/** A session's title: the prompt's first non-empty line, 120 characters at most. */
export function sessionTitle(prompt: string): string {
  return clip(firstLine(prompt), 120)
}

const TOOL_ARG_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"]

function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const rec = input as Record<string, unknown>
  for (const key of TOOL_ARG_KEYS)
    if (typeof rec[key] === "string") return firstLine(rec[key] as string)
  for (const v of Object.values(rec)) if (typeof v === "string") return firstLine(v)
  return ""
}

/** The one line (200 characters at most) the chat card shows for an event; null when it shows none. */
export function activityLine(event: NodeSessionEventIn): string | null {
  const p = event.payload
  let line: string | null = null
  switch (event.type) {
    case "assistant_text":
      line = typeof p.text === "string" ? firstLine(p.text) || null : null
      break
    case "tool_call": {
      const name = typeof p.name === "string" ? p.name : "Tool"
      const arg = toolArg(p.input)
      line = arg ? `${name}: ${arg}` : name
      break
    }
    case "permission_request":
      line = `Waiting: permission for ${typeof p.tool === "string" ? p.tool : "a tool"}`
      break
    case "question":
      line = "Waiting: a question"
      break
    case "plan_request":
      line = "Waiting: a plan to approve"
      break
    default:
      line = null
  }
  return line === null ? null : clip(line, 200)
}

// ---- steering commands (P3; spec-protocol.md §Commands) ----

export const NODE_SESSION_COMMAND_TYPES = [
  "message",
  "stop",
  "set_model",
  "set_level",
  "permission_decision",
  "answer",
  "mark_done",
  "set_effort",
  "stop_task",
  "set_autonomy",
  /** A44: server-applied only (Take over), never delivered to a node. */
  "take_over",
] as const
export type NodeSessionCommandType = (typeof NODE_SESSION_COMMAND_TYPES)[number]

const requestIdSchema = z.string().min(1).max(200)

export const nodeSessionCommandPayloadSchemas = {
  message: z.object({
    text: z.string().min(1).max(100_000),
    /** S51: the owner confirmed sending to a session another Claude Code drives. */
    confirmDrivenElsewhere: z.boolean().optional(),
  }),
  stop: z.object({}),
  set_model: z.object({ model: z.string().min(1).max(200) }),
  set_level: z.object({ level: z.enum(NODE_LEVELS), confirmationId: z.uuid().optional() }),
  permission_decision: z.object({
    requestId: requestIdSchema,
    allow: z.boolean(),
    scope: z.enum(["once", "session"]),
  }),
  answer: z.object({
    requestId: requestIdSchema,
    answers: z
      .record(z.string().max(2000), z.string().max(10_000))
      .refine((a) => Object.keys(a).length <= 20, { message: "at most 20 answers" }),
  }),
  mark_done: z.object({ summary: z.string().max(300).optional() }),
  set_effort: z.object({ effort: z.enum(EFFORT_LEVELS).nullable() }),
  /** S54 (D21): stop one subagent (its SDK task id); the session goes on. */
  stop_task: z.object({ taskId: z.string().min(1).max(200) }),
  /** S30: guided or autonomous; never changes the level. */
  set_autonomy: z.object({ autonomy: z.enum(AUTONOMY_LEVELS) }),
  take_over: z.object({}),
} as const

export const nodeSessionCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), payload: nodeSessionCommandPayloadSchemas.message }),
  z.object({ type: z.literal("stop"), payload: nodeSessionCommandPayloadSchemas.stop }),
  z.object({ type: z.literal("set_model"), payload: nodeSessionCommandPayloadSchemas.set_model }),
  z.object({ type: z.literal("set_level"), payload: nodeSessionCommandPayloadSchemas.set_level }),
  z.object({
    type: z.literal("permission_decision"),
    payload: nodeSessionCommandPayloadSchemas.permission_decision,
  }),
  z.object({ type: z.literal("answer"), payload: nodeSessionCommandPayloadSchemas.answer }),
  z.object({ type: z.literal("mark_done"), payload: nodeSessionCommandPayloadSchemas.mark_done }),
  z.object({ type: z.literal("set_effort"), payload: nodeSessionCommandPayloadSchemas.set_effort }),
  z.object({ type: z.literal("stop_task"), payload: nodeSessionCommandPayloadSchemas.stop_task }),
  z.object({
    type: z.literal("set_autonomy"),
    payload: nodeSessionCommandPayloadSchemas.set_autonomy,
  }),
  z.object({ type: z.literal("take_over"), payload: nodeSessionCommandPayloadSchemas.take_over }),
])
export type NodeSessionCommand = z.infer<typeof nodeSessionCommandSchema>

/** The stdin line the shell writes to a session's process for one command. */
export interface NodeSessionCommandLine {
  type: "command"
  commandId: string
  seq: number
  command: NodeSessionCommand
}

const commandLineSchema = z.object({
  type: z.literal("command"),
  commandId: z.uuid(),
  seq: z.number().int().positive(),
  command: nodeSessionCommandSchema,
})

/** One JSON line, no newline inside (JSON.stringify escapes every \n and \r in strings). */
export function commandLine(cmd: NodeSessionCommandLine): string {
  return JSON.stringify(cmd)
}

/** The command a stdin line carries, or null for anything else (bad JSON, another type, a bad payload). */
export function parseCommandLine(line: string): NodeSessionCommandLine | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = commandLineSchema.safeParse(raw)
  return parsed.success ? (parsed.data as NodeSessionCommandLine) : null
}

/**
 * One unacked command as `GET /api/node/sessions/commands?unacked=1` lists it.
 * The payload is checked later, per type, before it is written to a session.
 */
export const nodeCommandPullItemSchema = z.object({
  commandId: z.string().min(1),
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
  seq: z.number().int().positive(),
  type: z.string().min(1),
  payload: z.unknown(),
})
export type NodeCommandPullItem = z.infer<typeof nodeCommandPullItemSchema>

/** The `data` of the command pull: the one shape the server sends and the node reads. */
export interface NodeCommandPullResponse {
  commands: NodeCommandPullItem[]
}

/**
 * The commands in a command pull's `data`, in the server's order. A malformed
 * entry is dropped alone; anything that is not `{commands: [...]}` is none.
 */
export function parseNodeCommandPull(data: unknown): NodeCommandPullItem[] {
  const list = (data as { commands?: unknown } | null)?.commands
  if (!Array.isArray(list)) return []
  const out: NodeCommandPullItem[] = []
  for (const item of list) {
    const parsed = nodeCommandPullItemSchema.safeParse(item)
    if (parsed.success)
      out.push({ ...parsed.data, payload: (item as { payload?: unknown }).payload })
  }
  return out
}

/** A Claude Code tool use id; anything else (a path, a dot segment) is refused. */
export const TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_-]+$/

/** The per-node live session caps by default (D35). */
export const NODE_SESSION_DEFAULT_CAPS = { maxLive: 4, maxBackground: 2 } as const

export interface NodeSessionQuestionOption {
  label: string
  description?: string
}
export interface NodeSessionQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options?: NodeSessionQuestionOption[]
}

/**
 * The AskUserQuestion `answers` record (sdk-tools.d.ts:2662-2666): each
 * question's text to its chosen label, several labels comma-joined, or the
 * free text typed under Other. Questions with no pick are left out.
 */
export function questionAnswers(
  questions: readonly NodeSessionQuestion[],
  picks: Record<string, string[] | { other: string }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const pick = picks[q.question]
    if (pick === undefined) continue
    if (Array.isArray(pick)) {
      if (pick.length > 0) out[q.question] = pick.join(", ")
    } else if (pick.other.trim()) out[q.question] = pick.other
  }
  return out
}

const REQUEST_TYPES = new Set<NodeSessionEventType>([
  "permission_request",
  "question",
  "plan_request",
])

type RequestEventLike = Pick<NodeSessionEventIn, "type" | "payload"> & { seq?: number }

/** The open permission, question and plan requests, in order: a `decision` with the same requestId closes one. */
export function openRequests<E extends RequestEventLike>(events: readonly E[]): E[] {
  const decided = new Set<string>()
  for (const e of events)
    if (e.type === "decision" && typeof e.payload.requestId === "string")
      decided.add(e.payload.requestId)
  const open = events.filter(
    (e) =>
      REQUEST_TYPES.has(e.type) &&
      typeof e.payload.requestId === "string" &&
      !decided.has(e.payload.requestId),
  )
  return open.every((e) => typeof e.seq === "number")
    ? [...open].sort((a, b) => (a.seq as number) - (b.seq as number))
    : open
}

/**
 * The one open question a typed message answers (S9): the only open
 * `question` event, holding exactly one question. Null otherwise.
 */
export function singleQuestion(
  events: readonly RequestEventLike[],
): { requestId: string; question: string } | null {
  const questions = openRequests(events).filter((e) => e.type === "question")
  if (questions.length !== 1) return null
  const only = questions[0] as RequestEventLike
  const list = only.payload.questions
  if (!Array.isArray(list) || list.length !== 1) return null
  const text = (list[0] as { question?: unknown } | null)?.question
  if (typeof text !== "string") return null
  return { requestId: only.payload.requestId as string, question: text }
}
