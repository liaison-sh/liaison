// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node session store (C4, D33, D40).
 *
 * - `createSessionForJob` writes the session row of a new job and its first
 *   server event (`status: queued`, seq 1).
 * - `ingestBatch` appends a node's batch: the session row is locked
 *   (`SELECT … FOR UPDATE`), the caller must be the session's node holding
 *   the session's current run (job, lease holder, lease generation), and the
 *   batch number decides: last + 1 is appended with server-assigned seqs, the
 *   same number with the same body hash is a re-send (nothing stored, same
 *   lastSeq), the same number with another hash is a conflict, anything else
 *   is a gap.
 * - `appendServerEvents` appends the server's own events (status, decision)
 *   under the same lock, numbered in the same sequence.
 * - `projectRow` (pure) folds events into the row: open requests, waiting
 *   status and reason, tokens, activity line, result, start facts, and the
 *   reason code a client localises (another driver, the token limit; S51).
 *   It never ends a session: the end (Done or Needs you) is the run's
 *   completion signal, decided in nodes/jobs.ts (D1, S10).
 * - `fanOut` sends the row and its new events to the owner's sockets only,
 *   through `broadcastEphemeral` after the transaction committed (D40): no
 *   outbox, no audit row per event; clients heal by pulling.
 *
 * Every write here is privileged: the four session tables grant the app role
 * SELECT only (0140). Every statement binds the session's org.
 */

import type {
  Autonomy,
  EffortLevel,
  FinishWith,
  NodeImportFrom,
  NodeImportMode,
  NodeLevel,
} from "@liaison/shared"
import {
  activityLine,
  FINISH_WITH,
  isEndedSessionStatus,
  isNodeLevel,
  levelNeedsConfirmation,
  NODE_SESSION_REASON_CODES,
  type NodeSessionAtelierState,
  type NodeSessionConfigKind,
  type NodeSessionEventIn,
  type NodeSessionEventType,
  type NodeSessionReasonCode,
  type NodeSessionSource,
  type NodeSessionStatus,
  nodeSessionAtelierStateSchema,
  sessionTitle,
  wireStatus,
} from "@liaison/shared"
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  attentionEvents,
  nodeJobs,
  nodeSessionCommands,
  nodeSessionEvents,
  nodeSessions,
  nodes,
} from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import type { NodeRow } from "~/modules/nodes/credentials"
import { heldBy, type NodeJobRow } from "~/modules/nodes/jobs"
import type { SessionWaitingRequest } from "./waiting-hook"

const log = rootLogger.child({ module: "node-session-store" })

export type NodeSessionRow = typeof nodeSessions.$inferSelect
type NodeSessionEventRow = typeof nodeSessionEvents.$inferSelect

/** An event as stored and sent to clients: the emitter's event plus its order and arrival. */
export interface StoredSessionEvent {
  seq: number
  at: string
  receivedAt: string
  type: NodeSessionEventType
  parentToolUseId?: string
  payload: Record<string, unknown>
  truncated?: boolean
  fullBytes?: number
}

const REQUEST_TYPES = new Set<NodeSessionEventType>([
  "permission_request",
  "question",
  "plan_request",
])

const WAITING_REASON_MAX = 300
const RESULT_SUMMARY_MAX = 300
const CLAUDE_CODE_MAX = 600

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join("")
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  job: Pick<NodeJobRow, "id" | "orgId" | "ownerUserId" | "agentId">
  source: NodeSessionSource
  configKind: NodeSessionConfigKind
  title?: string
  prompt: string
  folderName?: string | null
  folderPath?: string | null
  repo?: string | null
  model: string
  level: NodeLevel
  /** The reasoning effort (null: the model's default). */
  effort?: EffortLevel | null
  /** S30: guided (the default) or autonomous. */
  autonomy?: Autonomy
  /**
   * S57: how the session finishes, as asked. Null: the default, a pull request
   * when the folder is a git repository (the node decides), nothing otherwise.
   */
  finishWith?: FinishWith | null
  sourceThreadId?: string | null
  sourceMessageId?: string | null
  /**
   * W3 (A51): an imported Claude Code session. The row keeps the imported id
   * (its `sdk_session_id` starts equal), where it came from and its recorded
   * cwd relative to the shared folder.
   */
  import?: NodeSessionImportInput
  /** Server events appended right after the first status (an import's model line). */
  events?: readonly NodeSessionEventIn[]
}

/** The import columns of a new imported session (A51). */
export interface NodeSessionImportInput {
  mode: NodeImportMode
  sdkSessionId: string
  from: NodeImportFrom
  cwdSubdir: string
  /** D53: the shared repo's own worktree outside the folder it ran in; absent, the folder. */
  worktreePath?: string
}

/**
 * The session row of a new job, queued, with its first server event. Runs in
 * the caller's privileged transaction (the job is created in the same one).
 * The repo, when given (a dispatch's git URL or shared repo folder name), is
 * kept on the row (D49); the claim answers it.
 */
export async function createSessionForJob(
  tx: PrivilegedDb,
  input: CreateSessionInput,
): Promise<{ row: NodeSessionRow; events: StoredSessionEvent[] }> {
  const [row] = await tx
    .insert(nodeSessions)
    .values({
      orgId: input.job.orgId,
      ownerUserId: input.job.ownerUserId,
      jobId: input.job.id,
      agentId: input.job.agentId,
      source: input.source,
      configKind: input.configKind,
      title: input.title ?? (sessionTitle(input.prompt) || "Session"),
      prompt: input.prompt,
      folderName: input.folderName ?? null,
      folderPath: input.folderPath ?? null,
      repo: input.repo ?? null,
      model: input.model,
      level: input.level,
      effort: input.effort ?? null,
      autonomy: input.autonomy ?? "guided",
      finishWith: input.finishWith ?? null,
      status: "queued",
      sourceThreadId: input.sourceThreadId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      ...(input.import
        ? {
            importMode: input.import.mode,
            importSdkSessionId: input.import.sdkSessionId,
            sdkSessionId: input.import.sdkSessionId,
            importFrom: input.import.from,
            cwdSubdir: input.import.cwdSubdir,
            worktreePath: input.import.worktreePath ?? null,
          }
        : {}),
    })
    .returning()
  // Durable, unlike the row's later changes (fanOut, ephemeral): "a session was
  // created" is something a consumer acts on (a guided tour beat). The live frame
  // row, so no prompt, and its ownerUserId keeps the socket fan-out owner-only.
  await tx.queueEvent({
    app: "kernel",
    entity: "node_session",
    action: "create",
    entityId: row.id,
    data: frameRow(row),
    actorId: row.ownerUserId,
    actorType: SESSION_SOURCE_ACTOR[input.source],
    orgId: row.orgId,
    timestamp: new Date().toISOString(),
  })
  return appendLocked(
    tx,
    row,
    [serverEvent("status", { status: "queued" }), ...(input.events ?? [])],
    "server",
  )
}

/** Who a session's creation is attributed to, by where it came from: the owner
 *  opened it (app, import), the owner's agent dispatched it, or a routine ran. */
const SESSION_SOURCE_ACTOR: Record<NodeSessionSource, "user" | "agent" | "system"> = {
  app: "user",
  import: "user",
  dispatch: "agent",
  agent_tag: "agent",
  routine: "system",
}

// ── projection (pure) ───────────────────────────────────────────────────────

/** A request still waiting for its answer, oldest first. */
export interface OpenRequest {
  requestId: string
  reason: string
}

function requestReason(event: NodeSessionEventIn): string {
  const p = event.payload
  if (event.type === "permission_request") {
    return clip(`permission: ${typeof p.tool === "string" ? p.tool : "a tool"}`, WAITING_REASON_MAX)
  }
  if (event.type === "question") {
    const first = Array.isArray(p.questions) ? (p.questions[0] as Record<string, unknown>) : null
    const header =
      first && typeof first.header === "string"
        ? first.header
        : first && typeof first.question === "string"
          ? first.question
          : "a question"
    return clip(`question: ${header}`, WAITING_REASON_MAX)
  }
  return "plan: approve a plan"
}

/** A branch name as the row keeps it (git refuses far shorter in practice). */
const BRANCH_MAX = 255

/** The most tokens one usage event may count in one counter. */
const USAGE_EVENT_MAX = 10_000_000

/**
 * A usage event's counter as the row adds it: a whole number from 0 to
 * USAGE_EVENT_MAX. Anything else is dropped with a warning (counted 0), so a
 * bad value never fails the batch and wedges the node's retries.
 */
function usageCount(sessionId: string, key: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    if (value <= USAGE_EVENT_MAX) return value
  }
  log.warn({ sessionId, key, value: String(value) }, "a usage counter out of range, dropped")
  return 0
}

/** S51: the reason code of another driver (the header's `driverKey` names). */
function drivenReasonCode(via: unknown): NodeSessionReasonCode {
  if (via === "vscode") return "driven_elsewhere_vscode"
  if (via === "cli") return "driven_elsewhere_cli"
  return "driven_elsewhere"
}

/** A pull request link as the row keeps it: https only (S57). */
const PR_URL_MAX = 500
export function isPrUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PR_URL_MAX &&
    URL.canParse(value) &&
    new URL(value).protocol === "https:"
  )
}

/**
 * The reason codes a run's end carries in its server `status` event reason
 * (S4, S32, S36, S57): a `needs_you` end with one of them keeps it on the row.
 * The driver codes come from the driver event only.
 */
const END_REASON_CODES = new Set<string>(
  NODE_SESSION_REASON_CODES.filter((c) => !c.startsWith("driven_elsewhere")),
)

function serverEvent(
  type: NodeSessionEventType,
  payload: Record<string, unknown>,
): NodeSessionEventIn {
  return { at: new Date().toISOString(), type, payload }
}

/**
 * Fold events into the row. `open` is the session's open requests before
 * these events (oldest first). Returns the updated row fields, the events to
 * store (the node's, with a server `status` event right after any event that
 * moved the session between running and waiting) and the open requests after.
 *
 * Status: the server runs the state machine (D36). A node's own `status`
 * event is stored and shown but does not move the row; a server `status`
 * event does. The one transition taken here is running ⇄ waiting, when the
 * number of open requests crosses zero.
 */
export function projectRow(
  row: NodeSessionRow,
  events: readonly NodeSessionEventIn[],
  open: readonly OpenRequest[] = [],
  origin: "node" | "server" = "node",
): { row: NodeSessionRow; events: NodeSessionEventIn[]; open: OpenRequest[] } {
  const next: NodeSessionRow = { ...row }
  const pending: OpenRequest[] = [...open]
  const out: NodeSessionEventIn[] = []

  for (const event of events) {
    out.push(event)
    const p = event.payload
    const pendingBefore = pending.length

    if (REQUEST_TYPES.has(event.type) && typeof p.requestId === "string") {
      if (!pending.some((r) => r.requestId === p.requestId)) {
        pending.push({ requestId: p.requestId, reason: requestReason(event) })
      }
    } else if (event.type === "decision" && typeof p.requestId === "string") {
      const at = pending.findIndex((r) => r.requestId === p.requestId)
      if (at >= 0) pending.splice(at, 1)
    } else if (event.type === "usage") {
      const count = (key: string): number => usageCount(row.id, key, p[key])
      next.tokensIn += count("tokensIn")
      next.tokensOut += count("tokensOut")
      // D23: the cache split (a node of protocol 3); an older node sends none.
      next.tokensCacheRead += count("cacheRead")
      next.tokensCacheWrite5m += count("cacheWrite5m")
      next.tokensCacheWrite1h += count("cacheWrite1h")
    } else if (event.type === "result") {
      // A3: once the session ended, its summary is final (the run's end
      // wrote it); a late batch's result never overwrites it.
      if (typeof p.text === "string" && !isEndedSessionStatus(next.status)) {
        next.resultSummary = clip(p.text, RESULT_SUMMARY_MAX)
      }
      if (typeof p.branch === "string") next.branch = p.branch
      if (typeof p.pushed === "boolean") next.pushed = p.pushed
      if (isPrUrl(p.prUrl)) next.prUrl = p.prUrl
    } else if (event.type === "system" && p.subtype === "atelier") {
      // S35: the node's reading of the Atelier state; an invalid one is ignored.
      const parsed = nodeSessionAtelierStateSchema.safeParse(p.data)
      if (parsed.success) next.atelier = parsed.data
      else log.warn({ sessionId: row.id }, "an invalid atelier state, ignored")
    } else if (event.type === "system" && p.subtype === "start") {
      // The node's start facts (T44 emits them): data.sessionId (the SDK
      // session), data.claudeCode ("<version> <installed|bundled> <path>"),
      // data.configDir (the CLAUDE_CONFIG_DIR pinned for the session, D26).
      const data = (p.data ?? {}) as Record<string, unknown>
      if (typeof data.sessionId === "string") next.sdkSessionId = data.sessionId
      if (typeof data.claudeCode === "string") {
        next.claudeCode = clip(data.claudeCode, CLAUDE_CODE_MAX)
      }
      if (typeof data.configDir === "string") next.configDir = data.configDir
      // W2-D10: a session dispatched without a finish step (null, S57's
      // default) records the one the node applied, so the row, the header and
      // the agent's reads say what the start event says. An explicit choice
      // is never overwritten.
      if (
        next.finishWith === null &&
        (FINISH_WITH as readonly unknown[]).includes(data.finishWith)
      ) {
        next.finishWith = data.finishWith as FinishWith
      }
      // Final walk F1: the session's branch from its start, so the header shows
      // it while the session runs (the result confirms it at the end).
      if (typeof data.branch === "string" && data.branch.length > 0) {
        next.branch = clip(data.branch, BRANCH_MAX)
      }
      // A run starts here: no other driver's reason any more.
      next.reasonCode = null
    } else if (event.type === "system" && p.subtype === "driver") {
      // S51: another Claude Code drives the session (T22); the list says so
      // in the reader's language, never the node's English text.
      const data = (p.data ?? {}) as Record<string, unknown>
      next.reasonCode = data.elsewhere === true ? drivenReasonCode(data.via) : null
    } else if (event.type === "model_changed") {
      if (typeof p.to === "string" && p.to.length > 0) next.model = p.to
    } else if (event.type === "level_changed") {
      if (isNodeLevel(p.to)) next.level = p.to
    } else if (event.type === "status" && origin === "server") {
      next.status = p.status as NodeSessionStatus
      if (next.status === "running" || next.status === "queued") next.reasonCode = null
      else if (
        next.status === "needs_you" &&
        typeof p.reason === "string" &&
        END_REASON_CODES.has(p.reason)
      ) {
        next.reasonCode = p.reason as NodeSessionReasonCode
      }
      // P1-walk D13: an ended session answers nothing more. Its open requests
      // expire, each with its decision, before the status that ended it.
      if (isEndedSessionStatus(next.status) && pending.length > 0) {
        const by = next.status === "stopped" ? "stop" : "process_exit"
        out.splice(
          out.length - 1,
          0,
          ...pending.map((r) =>
            serverEvent("decision", { requestId: r.requestId, outcome: "expired", by }),
          ),
        )
        pending.length = 0
      }
    }

    const line = activityLine(event)
    if (line !== null) next.latestActivity = line

    // running ⇄ waiting when the open requests cross zero (S12).
    if (pendingBefore === 0 && pending.length > 0 && next.status === "running") {
      next.status = "waiting"
      out.push(serverEvent("status", { status: "waiting", reason: pending[0].reason }))
    } else if (pendingBefore > 0 && pending.length === 0 && next.status === "waiting") {
      next.status = "running"
      out.push(serverEvent("status", { status: "running" }))
    }
  }

  next.pendingCount = pending.length
  next.waitingReason = pending.length > 0 ? pending[0].reason : null
  return { row: next, events: out, open: pending }
}

// ── append (under the row lock) ─────────────────────────────────────────────

async function loadOpenRequests(tx: PrivilegedDb, row: NodeSessionRow): Promise<OpenRequest[]> {
  if (row.pendingCount === 0) return []
  const rows = await tx
    .select({ type: nodeSessionEvents.type, payload: nodeSessionEvents.payload })
    .from(nodeSessionEvents)
    .where(
      and(
        eq(nodeSessionEvents.sessionId, row.id),
        inArray(nodeSessionEvents.type, [
          "permission_request",
          "question",
          "plan_request",
          "decision",
        ]),
      ),
    )
    .orderBy(asc(nodeSessionEvents.seq))
  const replay = projectRow(
    { ...row, status: "queued" },
    rows.map((r) => ({ at: "", type: r.type, payload: r.payload })),
  )
  return replay.open
}

/** The result of an append: the row after it, its stored events, and P4's waiting edge. */
export interface Appended {
  row: NodeSessionRow
  events: StoredSessionEvent[]
  /**
   * Set when this append took the open requests from none to some (T07): the
   * oldest request still open, for `fireSessionWaiting` after the commit.
   */
  becameWaiting?: SessionWaitingRequest
  /** Set when this append moved the row's status: the status before it. */
  statusFrom?: NodeSessionStatus
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMMAND_OUTCOMES = new Set(["applied", "noop", "cancelled", "failed"])

/**
 * Ack the commands a node's `command_applied` events report (D36). Only the
 * session's current run reaches here (the caller fenced the batch), and only
 * this session's unacked commands are touched.
 */
async function ackNodeCommands(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  batch: { jobId: string; resumeCommandId?: string | null },
  events: readonly NodeSessionEventIn[],
): Promise<void> {
  const jobId = batch.jobId
  for (const e of events) {
    if (e.type !== "command_applied") continue
    const p = e.payload
    if (typeof p.commandId !== "string" || !UUID.test(p.commandId)) continue
    if (typeof p.outcome !== "string" || !COMMAND_OUTCOMES.has(p.outcome)) continue
    await tx
      .update(nodeSessionCommands)
      .set({
        ackedAt: new Date(),
        outcome: p.outcome as "applied" | "noop" | "cancelled" | "failed",
        jobId,
        result: typeof p.error === "string" ? { error: p.error.slice(0, 2000) } : null,
      })
      .where(
        and(
          eq(nodeSessionCommands.id, p.commandId),
          eq(nodeSessionCommands.sessionId, row.id),
          isNull(nodeSessionCommands.ackedAt),
          // P3-fix m6: only a command delivered to this run (its pull
          // stamped the run, or the run was started for it).
          batch.resumeCommandId === p.commandId ? undefined : eq(nodeSessionCommands.jobId, jobId),
        ),
      )
  }
}

/**
 * P3-fix m6: a node's `level_changed` and `model_changed` move the row only
 * when the owner asked for that change. A level: a lowering to a level some
 * `set_level` of this session named; a raise only to the level its latest
 * `set_level` named (stored only once confirmed, D24). A model: one a
 * `set_model` named (or its dated id). Anything else is dropped, never stored.
 */
async function vetNodeChanges(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  events: readonly NodeSessionEventIn[],
): Promise<NodeSessionEventIn[]> {
  if (!events.some((e) => e.type === "level_changed" || e.type === "model_changed")) {
    return [...events]
  }
  const asked = await tx
    .select({ type: nodeSessionCommands.type, payload: nodeSessionCommands.payload })
    .from(nodeSessionCommands)
    .where(
      and(
        eq(nodeSessionCommands.sessionId, row.id),
        inArray(nodeSessionCommands.type, ["set_level", "set_model"]),
      ),
    )
    .orderBy(asc(nodeSessionCommands.seq))
  const levels = asked.filter((c) => c.type === "set_level").map((c) => c.payload.level)
  const models = asked.filter((c) => c.type === "set_model").map((c) => c.payload.model)
  let level = row.level
  const out: NodeSessionEventIn[] = []
  for (const e of events) {
    if (e.type === "level_changed") {
      const to = e.payload.to
      const ok =
        isNodeLevel(to) &&
        (levelNeedsConfirmation(level, to) ? levels.at(-1) === to : levels.includes(to))
      if (!ok) {
        log.warn({ sessionId: row.id, to }, "a level_changed the owner never asked for, dropped")
        continue
      }
      level = to
    } else if (e.type === "model_changed") {
      const to = e.payload.to
      const ok =
        typeof to === "string" &&
        models.some(
          (m) =>
            typeof m === "string" &&
            (to === m || (to.startsWith(`${m}-`) && /^\d{8}$/.test(to.slice(m.length + 1)))),
        )
      if (!ok) {
        log.warn({ sessionId: row.id, to }, "a model_changed the owner never asked for, dropped")
        continue
      }
    }
    out.push(e)
  }
  return out
}

/** Number, store and project events on a row the caller holds locked. */
async function appendLocked(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  events: readonly NodeSessionEventIn[],
  origin: "node" | "server",
  batch?: { batchNo: number; hash: string; jobId: string; resumeCommandId?: string | null },
): Promise<Appended> {
  const open = await loadOpenRequests(tx, row)
  const vetted = origin === "node" ? await vetNodeChanges(tx, row, events) : events
  const projected = projectRow(row, vetted, open, origin)
  let seq = row.lastSeq
  const values = projected.events.map((e) => ({
    sessionId: row.id,
    seq: ++seq,
    at: new Date(e.at),
    type: e.type,
    parentToolUseId: e.parentToolUseId ?? null,
    payload: e.payload,
    truncated: e.truncated === true,
    fullBytes: e.fullBytes ?? null,
  }))
  const inserted =
    values.length > 0 ? await tx.insert(nodeSessionEvents).values(values).returning() : []

  const p = projected.row
  const [updated] = await tx
    .update(nodeSessions)
    .set({
      lastSeq: seq,
      ...(batch ? { lastBatchNo: batch.batchNo, lastBatchHash: batch.hash } : {}),
      status: p.status,
      pendingCount: p.pendingCount,
      waitingReason: p.waitingReason,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      tokensCacheRead: p.tokensCacheRead,
      tokensCacheWrite5m: p.tokensCacheWrite5m,
      tokensCacheWrite1h: p.tokensCacheWrite1h,
      latestActivity: p.latestActivity,
      resultSummary: p.resultSummary,
      reasonCode: p.reasonCode,
      branch: p.branch,
      pushed: p.pushed,
      prUrl: p.prUrl,
      atelier: p.atelier,
      claudeCode: p.claudeCode,
      configDir: p.configDir,
      sdkSessionId: p.sdkSessionId,
      model: p.model,
      level: p.level,
      finishWith: p.finishWith,
      updatedAt: new Date(),
    })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
    .returning()
  if (origin === "node" && batch) await ackNodeCommands(tx, row, batch, events)

  const stored = inserted.map(toStoredEvent)
  let becameWaiting: SessionWaitingRequest | undefined
  if (row.pendingCount === 0 && updated.pendingCount > 0) {
    const oldest = projected.open[0]
    const event = stored.find(
      (e) => REQUEST_TYPES.has(e.type) && e.payload.requestId === oldest?.requestId,
    )
    if (oldest && event) {
      becameWaiting = {
        requestId: oldest.requestId,
        eventSeq: event.seq,
        type: event.type as SessionWaitingRequest["type"],
        tool: typeof event.payload.tool === "string" ? event.payload.tool : null,
      }
    }
  }
  return {
    row: updated,
    events: stored,
    ...(becameWaiting ? { becameWaiting } : {}),
    ...(updated.status !== row.status ? { statusFrom: row.status } : {}),
  }
}

async function lockSession(
  tx: PrivilegedDb,
  orgId: string,
  sessionId: string,
): Promise<NodeSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(nodeSessions)
    .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
    .for("update")
  return row
}

/** Append the server's own events (status, decision) in the session's sequence. */
export async function appendServerEvents(
  tx: PrivilegedDb,
  orgId: string,
  sessionId: string,
  events: readonly NodeSessionEventIn[],
): Promise<Appended | null> {
  const row = await lockSession(tx, orgId, sessionId)
  if (!row) return null
  return appendLocked(tx, row, events, "server")
}

// ── replay (demo) ───────────────────────────────────────────────────────────

/** A replay append was refused: the session is not a demo org's recorded session. */
export class ReplayAppendRefusedError extends Error {
  constructor(readonly reason: "not_demo_org" | "not_found" | "not_simulated") {
    super(`replay append refused: ${reason}`)
    this.name = "ReplayAppendRefusedError"
  }
}

export interface ReplayAppend {
  /** The recording's own events go in as a node's would ("node"); status and decision as the server's. */
  origin: "node" | "server"
  events: readonly NodeSessionEventIn[]
  /** Owner commands this append answers (their `command_applied` is among `events`). */
  acks?: ReadonlyArray<{ commandId: string; outcome: "applied" | "noop" }>
  /** The session ends with this append (its last event is the ending status). */
  ended?: boolean
  /** A step a guided tour completes on: queued as the durable `kernel/node_session:replay_step`. */
  replayStep?: { step: string; actorId: string }
}

/**
 * Append a recorded (replayed) session's events: the demo replay ticker's
 * only writer (modules/demo/replay). Refused unless the org is a demo org AND
 * the session runs on a simulated node of that org, so no real session, and
 * no regular org, is ever written by a replay. Same lock, numbering and
 * projection as a node's batch; the caller fans out after the commit.
 */
export async function appendReplayEvents(
  orgId: string,
  sessionId: string,
  append: ReplayAppend,
): Promise<Appended> {
  if (!(await isDemoOrgId(orgId))) throw new ReplayAppendRefusedError("not_demo_org")
  return withPrivilegedDb(orgId, "node-session:replay-append", async (tx) => {
    const row = await lockSession(tx, orgId, sessionId)
    if (!row) throw new ReplayAppendRefusedError("not_found")
    const [node] = row.nodeId
      ? await tx
          .select({ simulated: nodes.simulated })
          .from(nodes)
          .where(and(eq(nodes.id, row.nodeId), eq(nodes.orgId, orgId)))
      : []
    if (node?.simulated !== true) throw new ReplayAppendRefusedError("not_simulated")
    const appended = await appendLocked(tx, row, append.events, append.origin)
    for (const ack of append.acks ?? []) {
      await tx
        .update(nodeSessionCommands)
        .set({ ackedAt: new Date(), outcome: ack.outcome, jobId: row.jobId })
        .where(
          and(
            eq(nodeSessionCommands.id, ack.commandId),
            eq(nodeSessionCommands.sessionId, row.id),
            isNull(nodeSessionCommands.ackedAt),
          ),
        )
    }
    let out = appended
    if (append.ended) {
      const [ended] = await tx
        .update(nodeSessions)
        .set({ endedAt: new Date() })
        .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, orgId)))
        .returning()
      if (ended) out = { ...appended, row: ended }
    }
    if (append.replayStep) {
      await tx.queueEvent({
        app: "kernel",
        entity: "node_session",
        action: "replay_step",
        entityId: row.id,
        // Ids and the step only; ownerUserId keeps the socket fan-out owner-only.
        data: {
          sessionId: row.id,
          ownerUserId: row.ownerUserId,
          replayStep: append.replayStep.step,
        },
        actorId: append.replayStep.actorId,
        actorType: "user",
        orgId,
        timestamp: new Date().toISOString(),
      })
    }
    return out
  })
}

// ── ingest (D33) ────────────────────────────────────────────────────────────

export interface IngestBatch {
  jobId: string
  leaseGeneration: number
  batchNo: number
  events: NodeSessionEventIn[]
}

export type IngestOutcome =
  | {
      kind: "appended"
      lastSeq: number
      row: NodeSessionRow
      events: StoredSessionEvent[]
      becameWaiting?: SessionWaitingRequest
      statusFrom?: NodeSessionStatus
    }
  | { kind: "replayed"; lastSeq: number }
  | { kind: "gap"; expectedBatchNo: number }
  | { kind: "conflict" }
  | { kind: "stale" }
  | { kind: "not_your_node" }
  | { kind: "not_found" }

/**
 * Append one node batch to a session (D33). `rawBodyHash` is the sha256 of
 * the batch as received; a re-send must carry the same body.
 */
export async function ingestBatch(
  node: NodeRow,
  sessionId: string,
  batch: IngestBatch,
  rawBodyHash: string,
): Promise<IngestOutcome> {
  return withPrivilegedDb(node.orgId, "node-session:ingest", async (tx) => {
    const row = await lockSession(tx, node.orgId, sessionId)
    if (!row) return { kind: "not_found" } as const
    if (row.nodeId !== node.id || row.ownerUserId !== node.ownerUserId) {
      return { kind: "not_your_node" } as const
    }
    if (row.jobId !== batch.jobId) return { kind: "stale" } as const
    const [held] = await tx
      .select({ id: nodeJobs.id, resumeCommandId: nodeJobs.resumeCommandId })
      .from(nodeJobs)
      .where(heldBy(node, batch.jobId, batch.leaseGeneration))
    if (!held) return { kind: "stale" } as const

    if (batch.batchNo === row.lastBatchNo + 1) {
      // P3-fix m1: events from the run prove its process started, even when
      // its `started` signal never reached the server (a lapse then pauses
      // the session instead of requeueing the run).
      await tx
        .update(nodeJobs)
        .set({ startedAt: sql`now()` })
        .where(and(heldBy(node, batch.jobId, batch.leaseGeneration), isNull(nodeJobs.startedAt)))
      const appended = await appendLocked(tx, row, batch.events, "node", {
        batchNo: batch.batchNo,
        hash: rawBodyHash,
        jobId: batch.jobId,
        resumeCommandId: held.resumeCommandId,
      })
      return {
        kind: "appended",
        lastSeq: appended.row.lastSeq,
        row: appended.row,
        events: appended.events,
        ...(appended.becameWaiting ? { becameWaiting: appended.becameWaiting } : {}),
        ...(appended.statusFrom ? { statusFrom: appended.statusFrom } : {}),
      } as const
    }
    if (batch.batchNo === row.lastBatchNo && row.lastBatchNo > 0) {
      if (row.lastBatchHash === rawBodyHash)
        return { kind: "replayed", lastSeq: row.lastSeq } as const
      return { kind: "conflict" } as const
    }
    return { kind: "gap", expectedBatchNo: row.lastBatchNo + 1 } as const
  })
}

// ── the node's command pull (P3-T07) ────────────────────────────────────────

export interface NodeCommand {
  commandId: string
  sessionId: string
  jobId: string
  seq: number
  type: string
  payload: Record<string, unknown>
}

export const NODE_COMMAND_PULL_MAX = 500

/**
 * The unacked commands of the sessions whose current run this node holds (a
 * `running` job leased by it), ordered by session then seq. A paused session's
 * run is still held, so its commands come on reconnect.
 */
export async function nodeUnackedCommands(node: NodeRow): Promise<NodeCommand[]> {
  return withPrivilegedDb(node.orgId, "node-session:commands-pull", async (tx) => {
    const rows = await tx
      .select({
        commandId: nodeSessionCommands.id,
        sessionId: nodeSessionCommands.sessionId,
        jobId: nodeJobs.id,
        seq: nodeSessionCommands.seq,
        type: nodeSessionCommands.type,
        payload: nodeSessionCommands.payload,
      })
      .from(nodeSessionCommands)
      .innerJoin(nodeSessions, eq(nodeSessions.id, nodeSessionCommands.sessionId))
      .innerJoin(nodeJobs, eq(nodeJobs.id, nodeSessions.jobId))
      .where(
        and(
          eq(nodeSessions.orgId, node.orgId),
          eq(nodeSessions.ownerUserId, node.ownerUserId),
          eq(nodeSessions.nodeId, node.id),
          eq(nodeJobs.orgId, node.orgId),
          eq(nodeJobs.status, "running"),
          eq(nodeJobs.leaseHolder, node.id),
          isNull(nodeSessionCommands.ackedAt),
          // F1: a Stop or Mark done belongs to the run it was sent to; one
          // stamped with an older run never reaches the current one.
          or(
            notInArray(nodeSessionCommands.type, ["stop", "mark_done"]),
            isNull(nodeSessionCommands.jobId),
            eq(nodeSessionCommands.jobId, nodeJobs.id),
          ),
        ),
      )
      .orderBy(asc(nodeSessionCommands.sessionId), asc(nodeSessionCommands.seq))
      .limit(NODE_COMMAND_PULL_MAX)
    // P3-fix m6: each command is now delivered to its session's current run,
    // the only run whose `command_applied` may ack it.
    const byJob = new Map<string, string[]>()
    for (const r of rows) byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r.commandId])
    for (const [runJobId, ids] of byJob) {
      await tx
        .update(nodeSessionCommands)
        .set({ jobId: runJobId })
        .where(and(inArray(nodeSessionCommands.id, ids), isNull(nodeSessionCommands.ackedAt)))
    }
    return rows
  })
}

// ── a node's own session (full output, P3-T21) ─────────────────────────────

/**
 * The session as the calling node may act on it: its own (the session's node
 * and owner), `not_your_node` for another node's, null when there is none.
 */
export async function sessionForNode(
  node: NodeRow,
  sessionId: string,
): Promise<{ id: string; orgId: string; ownerUserId: string } | "not_your_node" | null> {
  const [row] = await withPrivilegedDb(node.orgId, "node-session:for-node", (tx) =>
    tx
      .select({
        id: nodeSessions.id,
        orgId: nodeSessions.orgId,
        ownerUserId: nodeSessions.ownerUserId,
        nodeId: nodeSessions.nodeId,
      })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, node.orgId)))
      .limit(1),
  )
  if (!row) return null
  if (row.nodeId !== node.id || row.ownerUserId !== node.ownerUserId) return "not_your_node"
  return { id: row.id, orgId: row.orgId, ownerUserId: row.ownerUserId }
}

// ── what clients see ────────────────────────────────────────────────────────

/**
 * The row as the owner's clients see it: never a local path, with its lastSeq.
 * D14: `status` is the value an older client can read (`needs_you` travels as
 * `waiting`), `state` the true status; server decisions read the DB row.
 */
export function publicRow(row: NodeSessionRow) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    nodeId: row.nodeId,
    jobId: row.jobId,
    agentId: row.agentId,
    source: row.source,
    configKind: row.configKind,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    title: row.title,
    prompt: row.prompt,
    folderName: row.folderName,
    repo: row.repo,
    branch: row.branch,
    pushed: row.pushed,
    prUrl: row.prUrl,
    model: row.model,
    level: row.level,
    effort: row.effort,
    /** S30: guided or autonomous. */
    autonomy: row.autonomy,
    /** S57: as asked; null = a pull request for a repository. */
    finishWith: row.finishWith,
    /** S35: the last valid Atelier state the node read (null: none). */
    atelier: row.atelier as NodeSessionAtelierState | null,
    /** S41 (A51): an import's mode and origin; null for any other session. */
    importMode: row.importMode,
    importFrom: row.importFrom,
    /** S41: a follow job holds this session's lease (read only while it does, A54). */
    following: row.following,
    /** S41: an import's recorded cwd relative to its shared folder ('' = the folder); display only. */
    cwdSubdir: row.cwdSubdir,
    /** D53: the shared repo's worktree outside the folder `cwdSubdir` is relative to; display only. */
    worktreePath: row.worktreePath,
    status: wireStatus(row.status),
    state: row.status,
    muted: row.muted,
    pendingCount: row.pendingCount,
    waitingReason: row.waitingReason,
    claudeCode: row.claudeCode,
    lastSeq: row.lastSeq,
    latestActivity: row.latestActivity,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokensCacheRead: row.tokensCacheRead,
    tokensCacheWrite5m: row.tokensCacheWrite5m,
    tokensCacheWrite1h: row.tokensCacheWrite1h,
    resultSummary: row.resultSummary,
    /** The reason line as a code the client localises (absent from an older API). */
    reasonCode: row.reasonCode as NodeSessionReasonCode | null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export type PublicNodeSession = ReturnType<typeof publicRow>

export function toStoredEvent(e: NodeSessionEventRow): StoredSessionEvent {
  return {
    seq: e.seq,
    at: e.at.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    type: e.type,
    ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
    payload: e.payload,
    ...(e.truncated ? { truncated: true } : {}),
    ...(e.fullBytes !== null ? { fullBytes: e.fullBytes } : {}),
  }
}

/** The row in a live frame: without the prompt (up to 200,000 characters, fixed at creation), which a GET carries. */
export function frameRow(row: NodeSessionRow): Omit<PublicNodeSession, "prompt"> {
  const { prompt: _prompt, ...rest } = publicRow(row)
  return rest
}

/**
 * Send the row and its new events to the owner's sockets (D40). Call after the
 * transaction committed. Best effort: a dropped frame is healed by the
 * client's pull (the row carries lastSeq). The row goes without its prompt,
 * so a long prompt is not re-sent with every batch.
 */
export async function fanOut(row: NodeSessionRow, events: readonly StoredSessionEvent[]) {
  try {
    await broadcastEphemeral({
      app: "kernel",
      entity: "node_session",
      action: "update",
      entityId: row.id,
      orgId: row.orgId,
      data: frameRow(row),
    })
    // S53 (D29): every event goes out; a socket whose hello said
    // `nodeSessionEvents: "top"` is not sent a subagent's (websocket.ts).
    for (const event of events) {
      await broadcastEphemeral({
        app: "kernel",
        entity: "node_session_event",
        action: "create",
        entityId: `${row.id}:${event.seq}`,
        orgId: row.orgId,
        data: { ownerUserId: row.ownerUserId, sessionId: row.id, ...event },
      })
    }
  } catch (err) {
    log.warn({ err, sessionId: row.id }, "Node session fan-out failed; clients heal by pull")
  }
}

/**
 * A dispatch's card message (P1-T20): the session names the message that
 * shows it, in the conversation it was asked from. Sent to the owner.
 */
export async function setSessionSourceMessage(
  orgId: string,
  sessionId: string,
  source: { threadId: string; messageId: string },
): Promise<void> {
  const [row] = await withPrivilegedDb(orgId, "node-sessions:source-message", (tx) =>
    tx
      .update(nodeSessions)
      .set({
        sourceThreadId: source.threadId,
        sourceMessageId: source.messageId,
        updatedAt: new Date(),
      })
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
      .returning(),
  )
  if (row) await fanOut(row, [])
}

/**
 * S14: the owner mutes or unmutes a session's notices. The caller has already
 * checked the session is the owner's through their own RLS; the write is bound
 * to org, id and owner again. `updated_at` is left alone: muting never
 * reorders the list. Null when no such row.
 */
export async function setSessionMuted(
  orgId: string,
  ownerUserId: string,
  sessionId: string,
  muted: boolean,
): Promise<NodeSessionRow | null> {
  const [row] = await withPrivilegedDb(orgId, "node-sessions:mute", (tx) =>
    tx
      .update(nodeSessions)
      .set({ muted })
      .where(
        and(
          eq(nodeSessions.id, sessionId),
          eq(nodeSessions.orgId, orgId),
          eq(nodeSessions.ownerUserId, ownerUserId),
        ),
      )
      .returning(),
  )
  return row ?? null
}

export type DeleteImportOutcome = "deleted" | "not_found" | "not_import" | "session_live"

/**
 * A49, A61: delete an imported session from Liaison, in one transaction. The
 * caller has already checked the session is the owner's through their own RLS.
 * The job is locked first (the claim's lock order), then the session; every
 * queued or offered job of the session is cancelled (a later claim gets
 * `not_claimable`), a live follow too, the owner's attention rows about it go,
 * and the session is deleted (its events, commands and confirmations cascade).
 * A live run that is not a follow refuses (`session_live`).
 */
export async function deleteImportedSession(
  orgId: string,
  ownerUserId: string,
  sessionId: string,
): Promise<DeleteImportOutcome> {
  return withPrivilegedDb(orgId, "node-sessions:delete-import", async (tx) => {
    const [peek] = await tx
      .select({ jobId: nodeSessions.jobId })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
    if (!peek) return "not_found" as const
    const [job] = peek.jobId
      ? await tx
          .select({ id: nodeJobs.id, kind: nodeJobs.kind, status: nodeJobs.status })
          .from(nodeJobs)
          .where(and(eq(nodeJobs.id, peek.jobId), eq(nodeJobs.orgId, orgId)))
          .for("update")
      : []
    const [row] = await tx
      .select()
      .from(nodeSessions)
      .where(
        and(
          eq(nodeSessions.id, sessionId),
          eq(nodeSessions.orgId, orgId),
          eq(nodeSessions.ownerUserId, ownerUserId),
        ),
      )
      .for("update")
    if (!row || row.jobId !== peek.jobId) return "not_found" as const
    if (row.source !== "import") return "not_import" as const
    if (job?.status === "running" && job.kind !== "follow") return "session_live" as const
    if (job && ["queued", "offered", "running"].includes(job.status)) {
      await tx
        .update(nodeJobs)
        .set({
          status: "cancelled",
          errorCode: "stopped",
          error: "Deleted from Liaison.",
          leaseHolder: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nodeJobs.id, job.id),
            eq(nodeJobs.orgId, orgId),
            inArray(nodeJobs.status, ["queued", "offered", "running"]),
          ),
        )
    }
    await tx
      .delete(attentionEvents)
      .where(
        and(
          eq(attentionEvents.orgId, orgId),
          eq(attentionEvents.userId, ownerUserId),
          eq(attentionEvents.app, "kernel"),
          eq(attentionEvents.entityType, "node_session"),
          eq(attentionEvents.entityId, sessionId),
        ),
      )
    await tx
      .delete(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
    return "deleted" as const
  })
}

/**
 * The owner's sessions that hold one of these CLI ids, as rows in creation
 * order (the import listing and start, import.ts). Bound to org and owner.
 */
export async function ownerSessionsHoldingSdkIds(
  orgId: string,
  ownerUserId: string,
  sdkSessionIds: readonly string[],
) {
  if (sdkSessionIds.length === 0) return []
  const ids = [...new Set(sdkSessionIds)]
  return withPrivilegedDb(orgId, "node-sessions:import-held", (tx) =>
    tx
      .select({
        id: nodeSessions.id,
        sdkSessionId: nodeSessions.sdkSessionId,
        importSdkSessionId: nodeSessions.importSdkSessionId,
      })
      .from(nodeSessions)
      .where(
        and(
          eq(nodeSessions.orgId, orgId),
          eq(nodeSessions.ownerUserId, ownerUserId),
          or(
            inArray(nodeSessions.sdkSessionId, ids),
            inArray(nodeSessions.importSdkSessionId, ids),
          ),
        ),
      )
      .orderBy(nodeSessions.createdAt),
  )
}
