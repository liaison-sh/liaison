// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The owner's commands to a session (P3, C5, D36, spec-protocol.md §Commands).
 *
 * `submitCommand` stores one command in the session's order and decides, by
 * the session's status under its row lock, who applies it:
 *
 *   - a live process (`running`, `waiting`): the node, woken after the commit
 *     by a `node_session_command` connection frame (it then pulls);
 *   - `paused`: the node too, when it is back (it pulls on reconnect);
 *   - `queued`: Stop cancels the job and ends the session `stopped`; a
 *     message waits for the coming run; model and level change the row;
 *     decisions are `noop`;
 *   - ended (`done`, `stopped`, `failed`): a message starts exactly one resume
 *     run (`resume_after = message`) and stays unacked (that run acks it);
 *     Stop and decisions are `noop`; model and level change the row.
 *
 * Round 2 (P1-T04, S7, S24):
 *
 *   - `mark_done`: on `needs_you` the server ends it `done` (its summary, when
 *     given, becomes the session's); on `queued` it is a Stop that ends
 *     `done`; on an ended session it is `noop`; on a live or paused session
 *     it goes to the node, which stops the process as Stop does (the run's
 *     end, failNodeJob/endDeadRun, then ends it `done`). A node older than
 *     protocol 3 would drop it, so it is refused `node_outdated` (409).
 *   - `set_effort`: the row changes at once for every status, with a
 *     `system/effort_changed` event; a live process also gets it (protocol 3),
 *     while an older node keeps its effort until the next run (`row_only`).
 *   - `set_autonomy` (S30, S33): as `set_effort`, with a
 *     `system/autonomy_changed` event; a live process gets it only from a node
 *     of protocol 4 (`NODE_PROTOCOL_AUTONOMY`), an older one answers `row_only`.
 *   - `stop_task` (S54, D21): stops one subagent of a live or paused run
 *     (the SDK's `stopTask`); the node applies it, an older node is refused
 *     `node_outdated`, a queued or ended session answers `noop`.
 *
 * W3 (A54): a session whose current job is a follow (an import being
 * followed, a Take over's replay, an in-place session followed while VS Code
 * drives it) answers every command one defined way (`applyWhileFollowing`):
 * a follow-mode import refuses messages (`follow_read_only`), a replay queues
 * them, an in-place follow needs the owner's confirmation
 * (`driven_elsewhere_confirm`) and then stops the follow and resumes; Stop
 * ends the follow; decisions and settings are `noop`.
 *
 * Every transition the server applies here fires the status hook after the
 * commit with cause `owner` (M1b).
 *
 * A raise (`levelNeedsConfirmation`) needs the owner's in-app `session_raise`
 * confirmation for this session at that level, attached here; without it
 * nothing is stored. A server-applied command gets its `command_applied`
 * event (server origin) and its ack in the same transaction.
 *
 * Lock order: the session's job, then the session (the claim's order), so a
 * Stop racing a claim never deadlocks.
 */
import {
  type Autonomy,
  isEndedSessionStatus,
  levelNeedsConfirmation,
  NODE_PROTOCOL_AUTONOMY,
  NODE_SESSION_ENDED_STATUSES,
  type NodeSessionCommand,
  type NodeSessionEventIn,
  type NodeSessionStatus,
} from "@liaison/shared"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeJobs, nodeSessionCommands, nodeSessions } from "~/db/schema/kernel"
import {
  type ConnectionFrame,
  getWsManager,
  type NotifyPresenceEntry,
  publishConnectionFrame,
} from "~/infra/websocket"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { liveNodeTargets, type NodeJobRow } from "~/modules/nodes/jobs"
import { attachConfirmation, type ConfirmationRefusal } from "./confirmations"
import { afterRunEnded, resumeSession } from "./lifecycle"
import { appendServerEvents, fanOut, type NodeSessionRow, type StoredSessionEvent } from "./store"
import { fireSessionStatus } from "./waiting-hook"

const log = rootLogger.child({ module: "node-session-commands" })

/**
 * Joins `scopes` to the source scopes of the job behind the owner's session
 * (A18, `sourceRequiredScopes`), under the job's row lock. `node_jobs` is
 * read-only to the request role, so this runs privileged, bound to the org and
 * to the session's owner: a session someone else owns, or one with no job, is
 * left untouched.
 */
export async function addSessionJobSourceScopes(
  orgId: string,
  userId: string,
  sessionId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return
  await withPrivilegedDb(orgId, "node-sessions:agent-send-taint", async (tx) => {
    const [row] = await tx
      .select({ jobId: nodeSessions.jobId, ownerUserId: nodeSessions.ownerUserId })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
      .limit(1)
    if (!row?.jobId || row.ownerUserId !== userId) return
    const [job] = await tx
      .select({ scopes: nodeJobs.sourceRequiredScopes })
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, row.jobId), eq(nodeJobs.orgId, orgId)))
      .for("update")
    if (!job) return
    const merged = [...new Set([...((job.scopes as string[] | null) ?? []), ...scopes])].sort()
    await tx
      .update(nodeJobs)
      .set({ sourceRequiredScopes: merged })
      .where(and(eq(nodeJobs.id, row.jobId), eq(nodeJobs.orgId, orgId)))
  })
}

export type CommandOutcome = "applied" | "noop" | "cancelled" | "failed"

export interface SubmitCommandInput {
  orgId: string
  userId: string
  sessionId: string
  command: NodeSessionCommand
}

export type SubmitCommandResult =
  | {
      ok: true
      commandId: string
      seq: number
      /** `row_only`: the row changed, but the live process (an older node) keeps its value. */
      applied?: "row_only"
    }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "confirmation_required"; reason?: ConfirmationRefusal }
  | { ok: false; code: "node_outdated" }
  /** A54: a follow-mode import is read only until taken over; nothing is stored. */
  | { ok: false; code: "follow_read_only" }
  /** A54 (S51): another Claude Code drives this in-place session; send again confirmed. */
  | { ok: false; code: "driven_elsewhere_confirm" }

/**
 * The node protocol that understands the round-2 commands (`mark_done`,
 * `set_effort`, `stop_task`). An older sidecar drops an unknown command line unsettled.
 */
export const NODE_PROTOCOL_ROUND2 = 3

/** A session's summary, as the run's end clips it. */
const RESULT_SUMMARY_MAX = 300

const LIVE: readonly NodeSessionStatus[] = ["running", "waiting"]
const ENDED: readonly NodeSessionStatus[] = NODE_SESSION_ENDED_STATUSES

class ConfirmationNotAttached extends Error {
  constructor(readonly reason?: ConfirmationRefusal) {
    super("confirmation_required")
  }
}

/** Rolls the command back: the live process's node cannot apply it. */
class NodeOutdated extends Error {
  constructor() {
    super("node_outdated")
  }
}

/** Rolls the command back: a message a follow cannot take (A54). */
class FollowRefusal extends Error {
  constructor(readonly code: "follow_read_only" | "driven_elsewhere_confirm") {
    super(code)
  }
}

/**
 * A54: what a session's live follow job is, by the session: an import's
 * read-only follow, a Take over's replay (or a follow taken over), or the
 * follow of an in-place session another Claude Code drives. Null when the
 * session's current job is not a waiting or running follow.
 */
type FollowState = "import" | "replay" | "in_place"
function followStateOf(row: NodeSessionRow, job: NodeJobRow | null): FollowState | null {
  if (job?.kind !== "follow") return null
  if (!["queued", "offered", "running"].includes(job.status)) return null
  if (row.source !== "import") return "in_place"
  return row.importMode === "take_over" ? "replay" : "import"
}

/** Commands that mean nothing to a follow (A54): acked `noop` while following. */
const NOOP_WHILE_FOLLOWING = new Set<NodeSessionCommand["type"]>([
  "answer",
  "permission_decision",
  "set_model",
  "set_level",
  "set_effort",
  "set_autonomy",
  "stop_task",
])

/** Whether the run's node speaks the round-2 commands (a null protocol: an older claim). */
const speaksRound2 = (job: NodeJobRow | null) => (job?.nodeProtocol ?? 0) >= NODE_PROTOCOL_ROUND2

/** Whether the run's node applies an autonomy change to a live process (wave 2). */
const speaksAutonomy = (job: NodeJobRow | null) =>
  (job?.nodeProtocol ?? 0) >= NODE_PROTOCOL_AUTONOMY

const event = (type: NodeSessionEventIn["type"], payload: Record<string, unknown>) =>
  ({ at: new Date().toISOString(), type, payload }) as NodeSessionEventIn

type Change = {
  row: NodeSessionRow
  events: StoredSessionEvent[]
  /** A status the server moved: fired on the status hook after the commit. */
  transition?: { from: NodeSessionStatus; to: NodeSessionStatus; reason?: string }
}

/** What to do once the transaction committed. */
interface AfterCommit {
  changes: Change[]
  wake: boolean
  resume: { session: NodeSessionRow; job: NodeJobRow | null; text: string } | null
  rowOnly: boolean
  /** A54: a follow the server ended for a confirmed message: its after-run step resumes. */
  followEnded: NodeJobRow | null
}

export async function submitCommand(input: SubmitCommandInput): Promise<SubmitCommandResult> {
  const { orgId, userId, sessionId, command } = input
  const after: AfterCommit = {
    changes: [],
    wake: false,
    resume: null,
    rowOnly: false,
    followEnded: null,
  }
  let stored: { commandId: string; seq: number; row: NodeSessionRow } | null = null
  try {
    stored = await withPrivilegedDb(orgId, "node-sessions:command", async (tx) => {
      // The job first (the claim's lock order), then the session.
      const [peek] = await tx
        .select({ jobId: nodeSessions.jobId, ownerUserId: nodeSessions.ownerUserId })
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
      if (!peek || peek.ownerUserId !== userId) return null
      let job: NodeJobRow | null = null
      if (peek.jobId) {
        ;[job = null] = await tx
          .select()
          .from(nodeJobs)
          .where(and(eq(nodeJobs.id, peek.jobId), eq(nodeJobs.orgId, orgId)))
          .for("update")
      }
      const [row] = await tx
        .select()
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
        .for("update")
      if (!row || row.ownerUserId !== userId) return null
      if (row.jobId !== peek.jobId) job = null

      // A54: a follow-mode import is read only (until taken over), following
      // or not; an in-place follow takes only a confirmed message.
      const follow = followStateOf(row, job)
      if (command.type === "message") {
        if (row.source === "import" && row.importMode === "follow") {
          throw new FollowRefusal("follow_read_only")
        }
        if (follow === "in_place" && command.payload.confirmDrivenElsewhere !== true) {
          throw new FollowRefusal("driven_elsewhere_confirm")
        }
      }

      if (command.type === "set_level" && !(follow && NOOP_WHILE_FOLLOWING.has(command.type))) {
        const { level, confirmationId } = command.payload
        if (levelNeedsConfirmation(row.level, level)) {
          if (!confirmationId || !row.nodeId) throw new ConfirmationNotAttached()
          const attached = await attachConfirmation(tx, {
            id: confirmationId,
            orgId,
            ownerUserId: userId,
            nodeId: row.nodeId,
            level,
            purpose: "session_raise",
            sessionId: row.id,
          })
          if (!attached.ok) throw new ConfirmationNotAttached(attached.code)
        }
      }

      // R12: the seq from the row, in this transaction.
      const [{ seq }] = await tx
        .update(nodeSessions)
        .set({ lastCommandSeq: sql`${nodeSessions.lastCommandSeq} + 1` })
        .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, orgId)))
        .returning({ seq: nodeSessions.lastCommandSeq })
      const [cmd] = await tx
        .insert(nodeSessionCommands)
        .values({
          sessionId: row.id,
          seq,
          type: command.type,
          payload: command.payload as Record<string, unknown>,
        })
        .returning({ id: nodeSessionCommands.id })

      const outcome =
        follow && job
          ? await applyWhileFollowing(tx, row, job, follow, command, after)
          : await applyOnServer(tx, row, job, command, after)
      if (outcome) await ack(tx, row, cmd.id, command.type, outcome, after)
      return { commandId: cmd.id, seq, row }
    })
  } catch (err) {
    if (err instanceof NodeOutdated) return { ok: false, code: "node_outdated" }
    if (err instanceof FollowRefusal) return { ok: false, code: err.code }
    if (err instanceof ConfirmationNotAttached) {
      return {
        ok: false,
        code: "confirmation_required",
        ...(err.reason ? { reason: err.reason } : {}),
      }
    }
    throw err
  }
  if (!stored) return { ok: false, code: "not_found" }

  for (const change of after.changes) await fanOut(change.row, change.events)
  for (const change of after.changes) {
    if (change.transition && change.transition.from !== change.transition.to) {
      await fireSessionStatus(change.row, { ...change.transition, cause: "owner" })
    }
  }
  if (after.wake) await wakeNode(stored.row)
  // A54 (D28, D31c): the confirmed message resumes once the follow it stopped ended.
  if (after.followEnded) await afterRunEnded(after.followEnded)
  if (after.resume) {
    // Exactly one resume run (D36, G4): the creating transaction re-checks the
    // session is still ended under its lock, so a second message finds it
    // queued and creates nothing.
    const { session, job, text } = after.resume
    await resumeSession(session, {
      after: "message",
      from: ENDED,
      commandId: stored.commandId,
      text,
      job,
    })
  }
  return {
    ok: true,
    commandId: stored.commandId,
    seq: stored.seq,
    ...(after.rowOnly ? { applied: "row_only" as const } : {}),
  }
}

/**
 * The server's part, by status. Returns the outcome when the server applied
 * the command itself (it is acked now), or null when a run applies it.
 */
async function applyOnServer(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow | null,
  command: NodeSessionCommand,
  after: AfterCommit,
): Promise<CommandOutcome | null> {
  const status = row.status
  // A44: server-applied only, never delivered to a node, whatever the status.
  if (command.type === "take_over") return takeOverEnded(tx, row, after)
  // Round 2's commands first: they reach a live process only through a node
  // that speaks them, and set_effort changes the row whatever the status.
  if (command.type === "mark_done") return markDone(tx, row, job, command.payload, after)
  if (command.type === "set_effort") return setEffort(tx, row, job, command.payload, after)
  if (command.type === "set_autonomy") return setAutonomy(tx, row, job, command.payload, after)
  if (command.type === "stop_task") {
    // S54: only a live run has subagents to stop; the session itself goes on.
    if (!LIVE.includes(status) && status !== "paused") return "noop"
    if (!speaksRound2(job)) throw new NodeOutdated()
    if (LIVE.includes(status)) after.wake = true
    return null
  }

  if (LIVE.includes(status)) {
    after.wake = true
    return null
  }
  if (status === "paused") {
    // W2-D4: a node that is connected while the session is paused may no
    // longer hold the run (its result post was lost, its process is gone):
    // the wake makes it pull, and a node that runs nothing for this session
    // reports its live runs, so the server ends the dead one now and resumes
    // with this command instead of leaving it unread until the 10-minute
    // sweep. A node that is away gets nothing (liveNodeTargets is empty).
    after.wake = true
    return null
  }

  switch (command.type) {
    case "stop": {
      if (status !== "queued") return "noop"
      await endQueued(tx, row, job, "stopped", "stopped_by_owner", null, after)
      return "applied"
    }
    case "message": {
      // Queued: the coming run reads it. Ended: one resume run (after commit).
      if (ENDED.includes(status)) after.resume = { session: row, job, text: command.payload.text }
      return null
    }
    case "set_model": {
      const to = command.payload.model
      if (to === row.model) return "noop"
      await tx
        .update(nodeSessions)
        .set({ model: to, updatedAt: new Date() })
        .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
      const changed = await appendServerEvents(tx, row.orgId, row.id, [
        event("model_changed", { from: row.model, to }),
      ])
      if (changed) after.changes.push(changed)
      return "applied"
    }
    case "set_level": {
      const to = command.payload.level
      if (to === row.level) return "noop"
      await tx
        .update(nodeSessions)
        .set({ level: to, updatedAt: new Date() })
        .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
      const changed = await appendServerEvents(tx, row.orgId, row.id, [
        event("level_changed", { from: row.level, to }),
      ])
      if (changed) after.changes.push(changed)
      return "applied"
    }
    case "permission_decision":
    case "answer":
      return "noop"
  }
}

/**
 * A44: Take over of a follow-mode import that no follow holds (its follow
 * ended): the mode moves to `take_over` and the session waits for the
 * owner's first message, `needs_you` `imported`. Anything else is `noop`.
 */
async function takeOverEnded(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  after: AfterCommit,
): Promise<CommandOutcome> {
  if (row.source !== "import" || row.importMode !== "follow") return "noop"
  if (!ENDED.includes(row.status)) return "noop"
  await setTakeOver(tx, row)
  const ended = await appendServerEvents(tx, row.orgId, row.id, [
    event("status", { status: "needs_you", reason: "imported" }),
  ])
  if (ended) {
    after.changes.push({
      ...ended,
      transition: { from: row.status, to: "needs_you", reason: "imported" },
    })
  }
  return "applied"
}

/** A44: only the owner's `take_over` changes an import's mode (resumeSession refuses `follow`). */
async function setTakeOver(tx: PrivilegedDb, row: NodeSessionRow): Promise<void> {
  await tx
    .update(nodeSessions)
    .set({ importMode: "take_over", updatedAt: new Date() })
    .where(
      and(
        eq(nodeSessions.id, row.id),
        eq(nodeSessions.orgId, row.orgId),
        eq(nodeSessions.source, "import"),
      ),
    )
}

/**
 * A44, A62: the node stops a follow it holds on a `stop` line and reports the
 * offset it reached (`why: owner`), which the first resume catches up from.
 * `take_over` itself never reaches a node, so the server queues that stop.
 * The follow's end acks it.
 */
async function queueServerStop(tx: PrivilegedDb, row: NodeSessionRow): Promise<void> {
  const [{ seq }] = await tx
    .update(nodeSessions)
    .set({ lastCommandSeq: sql`${nodeSessions.lastCommandSeq} + 1` })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
    .returning({ seq: nodeSessions.lastCommandSeq })
  await tx.insert(nodeSessionCommands).values({ sessionId: row.id, seq, type: "stop", payload: {} })
}

/**
 * A54: a command to a session whose current job is a live follow. Returns the
 * outcome when the server applied it, or null when the follow's end (or the
 * node) carries it out.
 */
async function applyWhileFollowing(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow,
  follow: FollowState,
  command: NodeSessionCommand,
  after: AfterCommit,
): Promise<CommandOutcome | null> {
  if (NOOP_WHILE_FOLLOWING.has(command.type)) return "noop"
  const claimed = job.status === "running"
  switch (command.type) {
    case "stop": {
      // Not yet claimed: no node holds it; the server ends it now.
      if (!claimed) {
        await endFollowOnServer(
          tx,
          row,
          job,
          follow === "replay" ? "imported" : "follow_ended",
          after,
        )
        return "applied"
      }
      // The node stops the follow and reports where it stopped (`why: owner`).
      if (LIVE.includes(row.status)) after.wake = true
      return null
    }
    case "mark_done":
      // As for a run: queued ends `done` now; a live follow is stopped by the
      // node and its end applies the Mark done.
      return markDone(tx, row, job, command.payload, after)
    case "message": {
      // A Take over's replay: the message waits for the replay's end, which
      // resumes with it (afterRunEnded). Nobody reads it meanwhile.
      if (follow === "replay") return null
      // In place, confirmed (checked before storing): the follow stops here
      // and its end resumes the session with this message.
      await endFollowOnServer(tx, row, job, "follow_ended", after)
      after.followEnded = job
      return null
    }
    case "take_over": {
      // A44: only a follow-mode import's read-only follow is taken over; the
      // session waits `needs_you` `imported` for the owner's first message.
      if (follow !== "import") return "noop"
      await setTakeOver(tx, row)
      if (!claimed) {
        await endFollowOnServer(tx, row, job, "imported", after)
        return "applied"
      }
      // A62: the node stops it and reports where it reached; its end
      // (`why: owner`) leaves the session `needs_you` `imported`.
      await queueServerStop(tx, row)
      after.wake = true
      return "applied"
    }
    default:
      return "noop"
  }
}

/**
 * End a session's follow on the server (A54): the job is cancelled whether
 * or not a node holds it (a holder's next heartbeat is stale and its host
 * drops the follow), and the session stops following, `needs_you` with
 * `reason`. Commands it ends are acked by the caller.
 */
async function endFollowOnServer(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow,
  reason: "imported" | "follow_ended",
  after: AfterCommit,
): Promise<void> {
  await tx
    .update(nodeJobs)
    .set({
      status: "cancelled",
      errorCode: "stopped",
      error: "Stopped by you.",
      leaseHolder: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(nodeJobs.id, job.id),
        eq(nodeJobs.orgId, row.orgId),
        inArray(nodeJobs.status, ["queued", "offered", "running"]),
      ),
    )
  const ended = await appendServerEvents(tx, row.orgId, row.id, [
    event("status", { status: "needs_you", reason }),
  ])
  const [endedRow] = await tx
    .update(nodeSessions)
    .set({ following: false, endedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
    .returning()
  if (!ended) return
  after.changes.push({
    row: endedRow,
    events: ended.events,
    transition: { from: row.status, to: "needs_you", reason },
  })
}

/**
 * End a queued session before its run starts (Stop, or Mark done as a Stop
 * that ends `done`): its job is cancelled while no node holds it, the
 * session ends with a server status event.
 */
async function endQueued(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow | null,
  to: "stopped" | "done",
  reason: string,
  summary: string | null,
  after: AfterCommit,
): Promise<void> {
  if (job && (job.status === "queued" || job.status === "offered")) {
    await tx
      .update(nodeJobs)
      .set({
        status: "cancelled",
        errorCode: "stopped",
        error: "Stopped by you.",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.id, job.id),
          eq(nodeJobs.orgId, row.orgId),
          inArray(nodeJobs.status, ["queued", "offered"]),
        ),
      )
  }
  const ended = await appendServerEvents(tx, row.orgId, row.id, [
    event("status", { status: to, reason }),
  ])
  if (!ended) return
  const [endedRow] = await tx
    .update(nodeSessions)
    .set({
      endedAt: new Date(),
      updatedAt: new Date(),
      ...(summary ? { resultSummary: summary } : {}),
    })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
    .returning()
  after.changes.push({
    row: endedRow,
    events: ended.events,
    transition: { from: row.status, to, reason },
  })
}

/** The owner's Mark done (S7), by status. */
async function markDone(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow | null,
  payload: { summary?: string },
  after: AfterCommit,
): Promise<CommandOutcome | null> {
  const status = row.status
  const trimmed = payload.summary?.trim() ?? ""
  const summary = trimmed ? Array.from(trimmed).slice(0, RESULT_SUMMARY_MAX).join("") : null
  const reason = "marked_done_by_owner"
  if (status === "needs_you") {
    // Already ended: only its status and summary change (ended_at is kept).
    const done = await appendServerEvents(tx, row.orgId, row.id, [
      event("status", { status: "done", reason }),
    ])
    if (!done) return "applied"
    const [doneRow] = await tx
      .update(nodeSessions)
      .set({ updatedAt: new Date(), ...(summary ? { resultSummary: summary } : {}) })
      .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
      .returning()
    after.changes.push({
      row: doneRow,
      events: done.events,
      transition: { from: status, to: "done", reason },
    })
    return "applied"
  }
  if (isEndedSessionStatus(status)) return "noop"
  if (status === "queued") {
    await endQueued(tx, row, job, "done", reason, summary, after)
    return "applied"
  }
  // running, waiting, paused: the node stops the process and the run's end
  // decides `done` (failNodeJob, endDeadRun). An older node would drop it.
  if (!speaksRound2(job)) throw new NodeOutdated()
  if (LIVE.includes(status)) after.wake = true
  return null
}

/** The owner's reasoning level (S24): the row at once, the live process when it can. */
async function setEffort(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow | null,
  payload: { effort: NodeSessionRow["effort"] },
  after: AfterCommit,
): Promise<CommandOutcome | null> {
  const to = payload.effort ?? null
  const from = row.effort ?? null
  if (to === from) return "noop"
  await tx
    .update(nodeSessions)
    .set({ effort: to, updatedAt: new Date() })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
  const changed = await appendServerEvents(tx, row.orgId, row.id, [
    event("system", { subtype: "effort_changed", data: { from, to } }),
  ])
  if (changed) after.changes.push(changed)
  // A paused session's process lives on: the node applies it on reconnect (§5.13).
  if (!LIVE.includes(row.status) && row.status !== "paused") return "applied"
  if (!speaksRound2(job)) {
    // The process keeps its effort until its next run, which reads the row.
    after.rowOnly = true
    return "applied"
  }
  if (LIVE.includes(row.status)) after.wake = true
  return null
}

/** The owner's autonomy (S30, S33): the row at once, the live process when its node can. */
async function setAutonomy(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  job: NodeJobRow | null,
  payload: { autonomy: Autonomy },
  after: AfterCommit,
): Promise<CommandOutcome | null> {
  const to = payload.autonomy
  const from = row.autonomy
  if (to === from) return "noop"
  await tx
    .update(nodeSessions)
    .set({ autonomy: to, updatedAt: new Date() })
    .where(and(eq(nodeSessions.id, row.id), eq(nodeSessions.orgId, row.orgId)))
  const changed = await appendServerEvents(tx, row.orgId, row.id, [
    event("system", { subtype: "autonomy_changed", data: { from, to } }),
  ])
  if (changed) after.changes.push(changed)
  if (!LIVE.includes(row.status) && row.status !== "paused") return "applied"
  if (!speaksAutonomy(job)) {
    // An older node keeps the process's autonomy; its next run reads the row.
    after.rowOnly = true
    return "applied"
  }
  if (LIVE.includes(row.status)) after.wake = true
  return null
}

/** A server-applied command: its `command_applied` event and its ack. */
async function ack(
  tx: PrivilegedDb,
  row: NodeSessionRow,
  commandId: string,
  type: string,
  outcome: CommandOutcome,
  after: AfterCommit,
): Promise<void> {
  const applied = await appendServerEvents(tx, row.orgId, row.id, [
    event("command_applied", { commandId, type, outcome }),
  ])
  await tx
    .update(nodeSessionCommands)
    .set({ ackedAt: new Date(), outcome, jobId: row.jobId })
    .where(
      and(
        eq(nodeSessionCommands.id, commandId),
        eq(nodeSessionCommands.sessionId, row.id),
        isNull(nodeSessionCommands.ackedAt),
      ),
    )
  if (applied) after.changes.push(applied)
}

/** Wake the session's node: it pulls its unacked commands (T07, T13). Best effort. */
export async function wakeNode(row: NodeSessionRow): Promise<void> {
  if (!row.nodeId) return
  try {
    const targets = await liveNodeTargets(row.orgId, row.ownerUserId, row.nodeId)
    await sendConnectionFrame(targets, { type: "node_session_command", sessionId: row.id })
  } catch (err) {
    log.warn({ err, sessionId: row.id }, "node session wake failed; the node pulls on reconnect")
  }
}

/** Send a connection-addressed frame to presence entries (this instance's sockets or pub/sub). */
export async function sendConnectionFrame(
  targets: NotifyPresenceEntry[],
  frame: ConnectionFrame,
): Promise<number> {
  if (targets.length === 0) return 0
  const manager = getWsManager()
  if (manager) return (await manager.sendNotifyEach(targets, frame)).filter(Boolean).length
  return publishConnectionFrame(redis, targets, frame)
}
