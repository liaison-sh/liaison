// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A session's life across its runs (P3, D36, S16, L4, G4, G5).
 *
 *   - Paused comes from presence: when a node's last connection closes, its
 *     running and waiting sessions show `paused` (`onNodeConnectionClosed`).
 *     A lapsed lease while the node is offline pauses too, never interrupts
 *     (`sweepSessionLeases`, G5): the process may well be alive.
 *   - Alive or dead comes from the node's own report (`reportNodeSessions`):
 *     a listed, fenced, alive run gets its lease back and its session leaves
 *     `paused`; a run the node holds but did not list alive is dead: its open
 *     requests expire, the job is `interrupted`, and the session resumes in a
 *     new run (`resume_after = offline`), or, with no SDK session to resume,
 *     runs its prompt again. A lease lapsed more than 10 minutes while the
 *     node is online counts as dead too. Never a notification.
 *   - A message left unacked when a run ended starts exactly one resume run
 *     (`afterRunEnded`, G4).
 *   - A follow (W3, A53, D45) never resumes and never writes: a dead follow
 *     ends `follow_ended` and fails its unread messages; after a follow, only
 *     a Take over's queued message or an in-place message the owner confirmed
 *     starts a run; a follow-mode import is never resumed (`attachResumeRun`).
 *
 * Every transition is a server event in the session's sequence, sent to the
 * owner after the commit.
 */
import {
  NODE_SESSION_ENDED_STATUSES,
  type NodeSessionEventIn,
  type NodeSessionStatus,
  openRequests,
} from "@liaison/shared"
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { NodeJobResumeAfter } from "~/db/schema/kernel"
import { nodeJobs, nodeSessionCommands, nodeSessionEvents, nodeSessions } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import type { NodeRow } from "~/modules/nodes/credentials"
import {
  createNodeJob,
  heldBy,
  NODE_LEASE_SECONDS,
  type NodeJobRow,
  notOnSimulatedNode,
  releaseJobConnection,
  SessionNotResumableError,
} from "~/modules/nodes/jobs"
import { liveDesktopConnections } from "~/modules/nodes/presence"
import { wakeNode } from "./commands"
import { type Appended, appendServerEvents, fanOut, type NodeSessionRow } from "./store"
import { fireSessionStatus, type SessionStatusChange } from "./waiting-hook"

const log = rootLogger.child({ module: "node-session-lifecycle" })

const RUNNING: readonly NodeSessionStatus[] = ["running", "waiting"]
const LIVE_RUN: readonly NodeSessionStatus[] = ["running", "waiting", "paused"]
export const ENDED_SESSION: readonly NodeSessionStatus[] = NODE_SESSION_ENDED_STATUSES

/** A run lapsed this long with its node online is dead (G5). */
export const DEAD_LEASE_LAPSE_MS = 10 * 60_000
/** A run claimed this recently is not judged dead by a report (its process may be starting). */
const REPORT_CLAIM_GRACE = sql`now() - interval '30 seconds'`

const event = (type: NodeSessionEventIn["type"], payload: Record<string, unknown>) =>
  ({ at: new Date().toISOString(), type, payload }) as NodeSessionEventIn

/** A change of this module: an append, and who caused its status move (default: the server). */
type Change = Appended & { cause?: SessionStatusChange["cause"] }

/** Send the changes after the commit, then the status hook for every status move. */
async function fanOutAll(changes: ReadonlyArray<Change | null | undefined>) {
  for (const c of changes) if (c) await fanOut(c.row, c.events)
  for (const c of changes) {
    if (!c?.statusFrom || c.statusFrom === c.row.status) continue
    void fireSessionStatus(c.row, {
      from: c.statusFrom,
      to: c.row.status,
      cause: c.cause ?? "server",
    })
  }
}

// ── paused (presence) ───────────────────────────────────────────────────────

/** The sessions of a node whose current run it holds, in one of `statuses`. */
async function heldSessions(
  orgId: string,
  nodeId: string,
  statuses: readonly NodeSessionStatus[],
): Promise<Array<{ session: NodeSessionRow; job: NodeJobRow }>> {
  return withPrivilegedDb(orgId, "node-sessions:held", (tx) =>
    tx
      .select({ session: nodeSessions, job: nodeJobs })
      .from(nodeSessions)
      .innerJoin(nodeJobs, eq(nodeJobs.id, nodeSessions.jobId))
      .where(
        and(
          eq(nodeSessions.orgId, orgId),
          eq(nodeSessions.nodeId, nodeId),
          inArray(nodeSessions.status, [...statuses]),
          eq(nodeJobs.orgId, orgId),
          eq(nodeJobs.status, "running"),
          eq(nodeJobs.leaseHolder, nodeId),
        ),
      ),
  )
}

/** Move one session to `to` from one of `from`, under its lock; null when it is not in `from`. */
async function moveSession(
  orgId: string,
  sessionId: string,
  to: NodeSessionStatus,
  from: readonly NodeSessionStatus[],
  reason: string,
): Promise<Appended | null> {
  return withPrivilegedDb(orgId, "node-sessions:move", async (tx) => {
    const [row] = await tx
      .select({ status: nodeSessions.status })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
      .for("update")
    if (!row || !from.includes(row.status)) return null
    return appendServerEvents(tx, orgId, sessionId, [event("status", { status: to, reason })])
  })
}

/** Every running or waiting session this node runs shows `paused`. */
export async function pauseNodeSessions(orgId: string, nodeId: string): Promise<number> {
  const held = await heldSessions(orgId, nodeId, RUNNING)
  const changes: Appended[] = []
  for (const { session } of held) {
    const moved = await moveSession(orgId, session.id, "paused", RUNNING, "node_offline")
    if (moved) changes.push(moved)
  }
  await fanOutAll(changes)
  return changes.length
}

/**
 * How long a closed node socket is given to come back before its sessions
 * pause (walk D10): a page reload closes and reopens it within a second, and
 * paused/running in the same second is noise in every transcript.
 */
export const NODE_CLOSE_GRACE_MS = 5_000

/**
 * The grace after a 1012 "restart" close (a deploy, lib/shutdown.ts): the node
 * reconnects to another process, which may take a few edge probe intervals.
 */
export const NODE_RESTART_GRACE_MS = 30_000

/** The close grace for a node socket closed with `code`. */
export function nodeCloseGraceMs(code: number | undefined): number {
  return code === 1012 ? NODE_RESTART_GRACE_MS : NODE_CLOSE_GRACE_MS
}

/**
 * A node connection closed (lib/server.ts, after its interval closed; the
 * presence sweep for a connection that died silently): when none of the
 * node's connections is left once `graceMs` has passed, its sessions pause.
 */
export async function onNodeConnectionClosed(input: {
  orgId: string
  userId: string
  nodeId: string
  graceMs?: number
}): Promise<void> {
  try {
    const grace = input.graceMs ?? 0
    if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace))
    const live = await liveDesktopConnections(input.orgId, input.userId)
    if (live.has(input.nodeId)) return
    await pauseNodeSessions(input.orgId, input.nodeId)
  } catch (err) {
    log.warn({ err, nodeId: input.nodeId }, "pausing a node's sessions failed")
  }
}

/**
 * P3-fix M5: the current run of a paused session spoke (a heartbeat, an event
 * batch) while its node is connected: the pause was a silent lapse
 * (`node_silent`), not an absence, so the session goes back to waiting (a
 * request open) or running, and the node is woken for the commands sent
 * meanwhile. Never throws.
 */
export async function unpauseHeldSession(
  node: NodeRow,
  jobId: string,
  generation: number,
): Promise<void> {
  try {
    const [paused] = await withPrivilegedDb(node.orgId, "node-sessions:unpause-peek", (tx) =>
      tx
        .select({ id: nodeSessions.id })
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.orgId, node.orgId),
            eq(nodeSessions.jobId, jobId),
            eq(nodeSessions.nodeId, node.id),
            eq(nodeSessions.status, "paused"),
          ),
        ),
    )
    if (!paused) return
    if (!(await liveDesktopConnections(node.orgId, node.ownerUserId)).has(node.id)) return
    const change = await withPrivilegedDb(node.orgId, "node-sessions:unpause", async (tx) => {
      const [held] = await tx
        .select({ id: nodeJobs.id })
        .from(nodeJobs)
        .where(heldBy(node, jobId, generation))
      if (!held) return null
      const [row] = await tx
        .select()
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.id, paused.id),
            eq(nodeSessions.orgId, node.orgId),
            eq(nodeSessions.jobId, jobId),
          ),
        )
        .for("update")
      if (row?.status !== "paused") return null
      return appendServerEvents(tx, node.orgId, row.id, [
        event("status", {
          status: row.pendingCount > 0 ? "waiting" : "running",
          reason: "node_back",
        }),
      ])
    })
    if (!change) return
    await fanOutAll([change])
    await wakeNode(change.row)
  } catch (err) {
    log.warn({ err, jobId }, "bringing a silent session back failed")
  }
}

// ── the node's report ───────────────────────────────────────────────────────

export interface ReportedSession {
  id: string
  jobId: string
  leaseGeneration: number
  alive: boolean
}

export interface ReportAnswer {
  id: string
  lastBatchNo: number
  lastSeq: number
}

/**
 * The node's word on its live runs (on every (re)connect). Listed, fenced and
 * alive: the lease is extended, a paused session goes back to waiting (a
 * request open) or running. Every other run this node holds is dead.
 */
export async function reportNodeSessions(
  node: NodeRow,
  sessions: readonly ReportedSession[],
): Promise<{ sessions: ReportAnswer[] }> {
  const answers: ReportAnswer[] = []
  const changes: Appended[] = []
  const aliveJobs = new Set<string>()
  for (const s of sessions) {
    if (!s.alive) continue
    const out = await withPrivilegedDb(node.orgId, "node-sessions:report-alive", async (tx) => {
      const [extended] = await tx
        .update(nodeJobs)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${NODE_LEASE_SECONDS})`,
          updatedAt: new Date(),
        })
        .where(heldBy(node, s.jobId, s.leaseGeneration))
        .returning({ id: nodeJobs.id })
      if (!extended) return null
      const [row] = await tx
        .select()
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.id, s.id),
            eq(nodeSessions.orgId, node.orgId),
            eq(nodeSessions.nodeId, node.id),
            eq(nodeSessions.jobId, s.jobId),
          ),
        )
        .for("update")
      if (!row) return null
      let change: Appended | null = null
      if (row.status === "paused") {
        change = await appendServerEvents(tx, node.orgId, row.id, [
          event("status", {
            status: row.pendingCount > 0 ? "waiting" : "running",
            reason: "node_back",
          }),
        ])
      }
      const current = change?.row ?? row
      return {
        change,
        answer: { id: row.id, lastBatchNo: current.lastBatchNo, lastSeq: current.lastSeq },
      }
    })
    if (!out) continue
    aliveJobs.add(s.jobId)
    answers.push(out.answer)
    if (out.change) changes.push(out.change)
  }
  await fanOutAll(changes)

  // Every other run this node holds is dead (an app quit, a crash).
  const held = await withPrivilegedDb(node.orgId, "node-sessions:report-held", (tx) =>
    tx
      .select({ session: nodeSessions, job: nodeJobs })
      .from(nodeSessions)
      .innerJoin(nodeJobs, eq(nodeJobs.id, nodeSessions.jobId))
      .where(
        and(
          eq(nodeSessions.orgId, node.orgId),
          eq(nodeSessions.nodeId, node.id),
          eq(nodeJobs.orgId, node.orgId),
          eq(nodeJobs.status, "running"),
          eq(nodeJobs.leaseHolder, node.id),
          lt(nodeJobs.claimedAt, REPORT_CLAIM_GRACE),
        ),
      ),
  )
  for (const { job } of held) {
    if (aliveJobs.has(job.id)) continue
    await endDeadRun(job)
  }
  return { sessions: answers }
}

/**
 * A run whose process is gone (D36): its open requests expire, the job is
 * `interrupted`, and the session resumes in a new run (or runs its prompt
 * again when no SDK session exists to resume). No notification.
 */
export async function endDeadRun(job: NodeJobRow): Promise<NodeJobRow | null> {
  const ended = await withPrivilegedDb(job.orgId, "node-sessions:dead-run", async (tx) => {
    const [locked] = await tx
      .select()
      .from(nodeJobs)
      .where(
        and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, job.orgId), eq(nodeJobs.status, "running")),
      )
      .for("update")
    if (!locked || locked.leaseHolder !== job.leaseHolder) return null
    const [session] = await tx
      .select()
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId)))
      .for("update")
    let change: Appended | null = null
    if (session && session.pendingCount > 0) {
      const asked = await tx
        .select({
          seq: nodeSessionEvents.seq,
          type: nodeSessionEvents.type,
          payload: nodeSessionEvents.payload,
        })
        .from(nodeSessionEvents)
        .where(
          and(
            eq(nodeSessionEvents.sessionId, session.id),
            inArray(nodeSessionEvents.type, [
              "permission_request",
              "question",
              "plan_request",
              "decision",
            ]),
          ),
        )
        .orderBy(asc(nodeSessionEvents.seq))
      const open = openRequests(asked)
      if (open.length > 0) {
        change = await appendServerEvents(
          tx,
          job.orgId,
          session.id,
          open.map((r) =>
            event("decision", {
              requestId: r.payload.requestId,
              outcome: "expired",
              by: "process_exit",
            }),
          ),
        )
      }
    }
    // A53 (C1): a follow's process is gone: it ends, it is never resumed.
    if (locked.kind === "follow") return endDeadFollow(tx, job, session ?? null, change)
    // P3-fix M4: a Stop the owner sent while the run was paused wins over
    // the resume: the session ends `stopped`, its Stop applied, what else
    // waited for that run cancelled (decisions: noop, their requests expired).
    // S7 (M8): a Mark done does the same but ends `done`, with its summary;
    // the later of the two decides.
    const unacked = session
      ? await tx
          .select({
            id: nodeSessionCommands.id,
            type: nodeSessionCommands.type,
            payload: nodeSessionCommands.payload,
          })
          .from(nodeSessionCommands)
          .where(
            and(eq(nodeSessionCommands.sessionId, session.id), isNull(nodeSessionCommands.ackedAt)),
          )
          .orderBy(asc(nodeSessionCommands.seq))
      : []
    const ending = unacked.filter((c) => c.type === "stop" || c.type === "mark_done").at(-1)
    const stopped = session !== undefined && ending !== undefined
    const markedDone = ending?.type === "mark_done"
    const markSummary =
      markedDone && typeof ending.payload.summary === "string" ? ending.payload.summary.trim() : ""
    await tx
      .update(nodeJobs)
      .set(
        stopped
          ? {
              status: "cancelled",
              leaseHolder: null,
              leaseExpiresAt: null,
              errorCode: "stopped",
              error: "Stopped by you.",
              finishedAt: new Date(),
              updatedAt: new Date(),
            }
          : {
              status: "interrupted",
              leaseHolder: null,
              leaseExpiresAt: null,
              errorCode: "lease_expired",
              error: "The session's process on the computer ended before the run finished.",
              finishedAt: new Date(),
              updatedAt: new Date(),
            },
      )
      .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, job.orgId)))
    if (stopped && session) {
      const outcomeOf = (type: string) =>
        type === "stop" || type === "mark_done"
          ? "applied"
          : type === "permission_decision" || type === "answer"
            ? "noop"
            : "cancelled"
      for (const c of unacked) {
        await tx
          .update(nodeSessionCommands)
          .set({ ackedAt: new Date(), outcome: outcomeOf(c.type), jobId: job.id })
          .where(and(eq(nodeSessionCommands.id, c.id), isNull(nodeSessionCommands.ackedAt)))
      }
      const stopEvents = await appendServerEvents(tx, job.orgId, session.id, [
        ...unacked.map((c) =>
          event("command_applied", { commandId: c.id, type: c.type, outcome: outcomeOf(c.type) }),
        ),
        markedDone
          ? event("status", { status: "done", reason: "marked_done_by_owner" })
          : event("status", { status: "stopped", reason: "stopped_by_owner" }),
      ])
      const [endedRow] = await tx
        .update(nodeSessions)
        .set({
          endedAt: new Date(),
          updatedAt: new Date(),
          ...(markSummary ? { resultSummary: Array.from(markSummary).slice(0, 300).join("") } : {}),
        })
        .where(and(eq(nodeSessions.id, session.id), eq(nodeSessions.orgId, job.orgId)))
        .returning()
      const stopChange: Change | null = stopEvents
        ? {
            row: endedRow,
            events: [...(change?.events ?? []), ...stopEvents.events],
            statusFrom: session.status,
            cause: "owner",
          }
        : change
      return { session: null, change: stopChange }
    }
    // W2-D4: a message the owner sent while the run was silent is what the
    // new run answers (the dead run never read it), not a bare "continue".
    const messages = unacked.filter((c) => c.type === "message")
    return { session: change?.row ?? session ?? null, change, messages }
  })
  if (!ended) return null
  await fanOutAll([ended.change])
  await releaseJobConnection(job)
  if (!ended.session) return null
  const message = ended.messages[0]
  if (message && job.resumeCommandId === message.id) {
    // The dead run was the one started for that message and never read it:
    // resuming with it again would loop once per lease expiry. Like
    // afterRunEnded, every unread message fails (in order); the session
    // resumes bare, as a dead run without a message does.
    await failUnreadMessages(
      ended.session,
      ended.messages.map((c) => c.id),
      job.id,
    )
  } else if (message && ended.session.sdkSessionId) {
    return resumeSession(ended.session, {
      after: "message",
      from: LIVE_RUN,
      commandId: message.id,
      text: String((message.payload as { text?: unknown }).text ?? ""),
      job,
    })
  }
  return resumeSession(ended.session, {
    after: ended.session.sdkSessionId ? "offline" : null,
    from: LIVE_RUN,
    job,
  })
}

/** What an unread message of a follow that ended says (A53): the owner sends it again. */
export const FOLLOW_ENDED_LINE = "The follow ended before this message was sent; send it again."

/**
 * A dead follow (A53, D45), in endDeadRun's transaction: the job is
 * `interrupted`, the session stops following and ends `needs_you`
 * `follow_ended` (cause `follow`, no notice), every unread message is acked
 * `failed` with a resend line, an unacked Stop is applied (a Mark done ends it
 * `done`), anything else is `noop`. Nothing is resumed.
 */
async function endDeadFollow(
  tx: PrivilegedDb,
  job: NodeJobRow,
  session: NodeSessionRow | null,
  expired: Appended | null,
): Promise<{ session: null; change: Change | null }> {
  await tx
    .update(nodeJobs)
    .set({
      status: "interrupted",
      leaseHolder: null,
      leaseExpiresAt: null,
      errorCode: "lease_expired",
      error: "The follow on the computer ended.",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, job.orgId)))
  if (!session) return { session: null, change: expired }
  const unacked = await tx
    .select({ id: nodeSessionCommands.id, type: nodeSessionCommands.type })
    .from(nodeSessionCommands)
    .where(and(eq(nodeSessionCommands.sessionId, session.id), isNull(nodeSessionCommands.ackedAt)))
    .orderBy(asc(nodeSessionCommands.seq))
  const ending = unacked.filter((c) => c.type === "stop" || c.type === "mark_done").at(-1)
  const outcomeOf = (type: string) =>
    type === "message" ? "failed" : type === "stop" || type === "mark_done" ? "applied" : "noop"
  for (const c of unacked) {
    await tx
      .update(nodeSessionCommands)
      .set({
        ackedAt: new Date(),
        outcome: outcomeOf(c.type),
        jobId: job.id,
        ...(c.type === "message" ? { result: { error: FOLLOW_ENDED_LINE } } : {}),
      })
      .where(and(eq(nodeSessionCommands.id, c.id), isNull(nodeSessionCommands.ackedAt)))
  }
  const appended = await appendServerEvents(tx, job.orgId, session.id, [
    ...unacked.map((c) =>
      event("command_applied", {
        commandId: c.id,
        type: c.type,
        outcome: outcomeOf(c.type),
        ...(c.type === "message" ? { error: FOLLOW_ENDED_LINE } : {}),
      }),
    ),
    ending?.type === "mark_done"
      ? event("status", { status: "done", reason: "marked_done_by_owner" })
      : event("status", { status: "needs_you", reason: "follow_ended" }),
  ])
  if (!appended) return { session: null, change: expired }
  const [endedRow] = await tx
    .update(nodeSessions)
    .set({ following: false, endedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(nodeSessions.id, session.id), eq(nodeSessions.orgId, job.orgId)))
    .returning()
  return {
    session: null,
    change: {
      row: endedRow,
      events: [...(expired?.events ?? []), ...appended.events],
      statusFrom: session.status,
      cause: ending ? "owner" : "follow",
    },
  }
}

// ── resume runs ─────────────────────────────────────────────────────────────

export interface ResumeOptions {
  /** Why (D36); null runs the session's prompt again with nothing to resume. */
  after: NodeJobResumeAfter | null
  /** The statuses the session must still be in, under its lock. */
  from: readonly NodeSessionStatus[]
  /** The message that wakes it (`after = message`): its id and text, the run's prompt. */
  commandId?: string
  text?: string
  /** The session's previous run, whose conversation and limits the new one keeps. */
  job?: NodeJobRow | null
}

/**
 * A new run of an existing session (exactly one: the creating transaction
 * re-checks `from` under the session's lock). Null when the session moved on.
 */
export async function resumeSession(
  session: NodeSessionRow,
  opts: ResumeOptions,
): Promise<NodeJobRow | null> {
  let job = opts.job ?? null
  if (!job && session.jobId) {
    ;[job = null] = await withPrivilegedDb(session.orgId, "node-sessions:resume-job", (tx) =>
      tx
        .select()
        .from(nodeJobs)
        .where(and(eq(nodeJobs.id, session.jobId as string), eq(nodeJobs.orgId, session.orgId))),
    )
  }
  try {
    return await createNodeJob({
      orgId: session.orgId,
      ownerUserId: session.ownerUserId,
      agentId: session.agentId,
      threadId: job?.threadId ?? session.sourceThreadId ?? null,
      source: job?.source ?? session.source,
      sourceRef: job?.sourceRef ?? null,
      prompt: opts.text ?? session.prompt,
      // A follow's trigger holds its follow parameters, nothing a run reads.
      trigger:
        job?.kind === "follow"
          ? null
          : ((job?.trigger as Record<string, unknown> | null | undefined) ?? null),
      sourceRequiredScopes: (job?.sourceRequiredScopes as string[] | undefined) ?? [],
      tokenBudget: job?.tokenBudget ?? null,
      hardTokenLimit: job?.hardTokenLimit ?? null,
      targetNodeId: session.nodeId,
      requesterUserId: job?.requesterUserId ?? null,
      requesterAgentId: job?.requesterAgentId ?? null,
      replyThreadId: job?.replyThreadId ?? null,
      replyMessageId: job?.replyMessageId ?? null,
      resume: {
        sessionId: session.id,
        from: opts.from,
        after: opts.after,
        commandId: opts.commandId ?? null,
      },
    })
  } catch (err) {
    if (err instanceof SessionNotResumableError) return null
    throw err
  }
}

/**
 * After a run ended (completed, failed, stopped; called by the job's finish
 * step): a message the run never read starts one resume run with it (G4). A
 * message that already had its own run and was still never read is acked
 * `failed` instead, so a run that cannot start never loops.
 */
export async function afterRunEnded(job: NodeJobRow): Promise<void> {
  try {
    const [session] = await withPrivilegedDb(job.orgId, "node-sessions:after-run", (tx) =>
      tx
        .select()
        .from(nodeSessions)
        .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId))),
    )
    if (!session || !ENDED_SESSION.includes(session.status)) return
    const unread = await withPrivilegedDb(job.orgId, "node-sessions:after-run-cmd", (tx) =>
      tx
        .select()
        .from(nodeSessionCommands)
        .where(
          and(
            eq(nodeSessionCommands.sessionId, session.id),
            eq(nodeSessionCommands.type, "message"),
            isNull(nodeSessionCommands.ackedAt),
          ),
        )
        .orderBy(asc(nodeSessionCommands.seq)),
    )
    const oldest = unread[0]
    if (!oldest) return
    // A53 (D45): after a follow, only (a) a Take over's message queued during
    // its replay or (b) an in-place message the owner confirmed (D28, D31c)
    // starts a run; any other unread message is failed with a resend line.
    if (job.kind === "follow") {
      const confirmed =
        (oldest.payload as { confirmDrivenElsewhere?: unknown }).confirmDrivenElsewhere === true
      const takenOver = session.source === "import" && session.importMode === "take_over"
      const inPlace = session.source !== "import" && confirmed
      if (!takenOver && !inPlace) {
        await failUnreadMessages(
          session,
          unread.map((c) => c.id),
          job.id,
          FOLLOW_ENDED_LINE,
        )
        return
      }
    }
    if (job.resumeCommandId === oldest.id) {
      // P3-fix m3: the run started for the oldest never read it; the ones
      // queued behind it would wait forever, so every one fails, in order.
      await failUnreadMessages(
        session,
        unread.map((c) => c.id),
        job.id,
      )
      return
    }
    await resumeSession(session, {
      after: "message",
      from: ENDED_SESSION,
      commandId: oldest.id,
      text: String((oldest.payload as { text?: unknown }).text ?? ""),
      job,
    })
  } catch (err) {
    log.error({ err, jobId: job.id }, "resuming a session after its run ended failed")
  }
}

const UNREAD_ERROR = "The run started for this message ended before reading it."

async function failUnreadMessages(
  session: NodeSessionRow,
  commandIds: string[],
  jobId: string,
  error: string = UNREAD_ERROR,
) {
  const change = await withPrivilegedDb(
    session.orgId,
    "node-sessions:message-unread",
    async (tx) => {
      const acked = await tx
        .update(nodeSessionCommands)
        .set({ ackedAt: new Date(), outcome: "failed", jobId, result: { error } })
        .where(
          and(
            inArray(nodeSessionCommands.id, commandIds),
            eq(nodeSessionCommands.sessionId, session.id),
            isNull(nodeSessionCommands.ackedAt),
          ),
        )
        .returning({ id: nodeSessionCommands.id })
      const done = new Set(acked.map((a) => a.id))
      const failed = commandIds.filter((id) => done.has(id))
      if (failed.length === 0) return null
      return appendServerEvents(
        tx,
        session.orgId,
        session.id,
        failed.map((commandId) =>
          event("command_applied", {
            commandId,
            type: "message",
            outcome: "failed",
            error,
          }),
        ),
      )
    },
  )
  await fanOutAll([change])
}

// ── the lease sweep's session part (G5) ─────────────────────────────────────

/**
 * Started session runs whose lease lapsed: the session shows `paused`, the job
 * keeps running with its lease holder. When the node is online and the lapse
 * is over 10 minutes, the run is dead. Called by `sweepNodeLeases`, which
 * leaves these jobs out of its interrupt path.
 */
export async function sweepSessionLeases(): Promise<{ paused: number; dead: number }> {
  const lapsed = await withSystemDb("node-sessions:lease-sweep", (db) =>
    db
      .select({ session: nodeSessions, job: nodeJobs })
      .from(nodeJobs)
      .innerJoin(nodeSessions, eq(nodeSessions.jobId, nodeJobs.id))
      .where(
        and(
          eq(nodeJobs.status, "running"),
          lt(nodeJobs.leaseExpiresAt, sql`now()`),
          sql`${nodeJobs.startedAt} IS NOT NULL`,
          // A demo replay's run has no lease to lapse: its ticker owns it.
          notOnSimulatedNode,
        ),
      ),
  )
  let paused = 0
  let dead = 0
  const online = new Map<string, Set<string>>()
  for (const { session, job } of lapsed) {
    try {
      const key = `${job.orgId}:${job.ownerUserId}`
      let nodes = online.get(key)
      if (!nodes) {
        nodes = new Set((await liveDesktopConnections(job.orgId, job.ownerUserId)).keys())
        online.set(key, nodes)
      }
      const lapseMs = Date.now() - (job.leaseExpiresAt?.getTime() ?? Date.now())
      if (job.leaseHolder && nodes.has(job.leaseHolder) && lapseMs > DEAD_LEASE_LAPSE_MS) {
        if (await endDeadRun(job)) dead++
        continue
      }
      const moved = await moveSession(session.orgId, session.id, "paused", RUNNING, "node_silent")
      if (moved) {
        paused++
        await fanOutAll([moved])
      }
    } catch (err) {
      log.warn({ err, jobId: job.id }, "the session lease sweep failed for one run")
    }
  }
  return { paused, dead }
}
