// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Node jobs (S20, S23, A18-A20, A23, A25-A27, F7).
 *
 * LIFECYCLE. `queued` -> `offered` (a frame went to a live node) -> `running`
 * (claimed: leased to one node) -> `done` | `failed` | `refused`. A lease that
 * runs out before the node said `started` puts the job back to `queued`; one
 * that runs out after it becomes `interrupted` and the owner decides (Re-run /
 * Discard), because a run that may have had side effects is never repeated
 * silently (A20). `cancelled` is a discard or a coalesced routine run;
 * `fell_back` is the cloud fallback (T3).
 *
 * FENCING (A20). Every claim bumps `lease_generation`. Heartbeat, started,
 * result and fail name the generation they hold; any other gets 409, which
 * tells the node to abort its run. A result is idempotent per (job,
 * generation): the same post again answers the message it already wrote.
 *
 * OFFERS (A23, A26). A job created while at least one enabled node of its
 * owner is live is offered to all of them, and again to a node that
 * reconnects. A job created while none was live is a BACKLOG job: it is never
 * offered, the node fetches it and asks its user first.
 *
 * SESSIONS (P1, S16, S17, D33, D36). Every unattended job created with a
 * `session` is that session's current run (`node_sessions.job_id`); an
 * interactive job (My node chat) never has one. The server runs the session's
 * status (spec-protocol.md, job-to-session mapping): created queued; claimed
 * running; done; failed (a node failure, a refusal at claim, an interrupted
 * run); stopped (a discard before it ran, or "replaced" by a newer routine
 * tick); queued again on a requeue or a re-run. Each transition appends a
 * server `status` event in the session's sequence, in the job's transaction,
 * and goes to the owner's sockets after the commit.
 */

import {
  type Autonomy,
  type EffortLevel,
  type FinishWith,
  isEndedSessionStatus,
  NODE_IMPORT_LIMITS,
  NODE_PROTOCOL_IMPORT,
  NODE_SESSION_DEFAULT_CAPS,
  NODE_SESSION_STATUSES,
  type NodeFollowClaim,
  type NodeFollowResult,
  type NodeLevel,
  type NodeSessionCompletion,
  type NodeSessionConfigKind,
  type NodeSessionEventIn,
  type NodeSessionSource,
  type NodeSessionStatus,
  nodeFollowClaimSchema,
} from "@liaison/shared"
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  agents,
  mcpConnections,
  type NodeJobKind,
  type NodeJobResumeAfter,
  type NodeJobSource,
  type NodePermissionMode,
  type NodeRunsOn,
  nodeCapabilities,
  nodeJobs,
  nodeProfiles,
  nodeSessionCommands,
  nodeSessions,
  nodes,
  routineRuns,
  routines,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import {
  getWsManager,
  type NodeJobOfferFrame,
  type NotifyPresenceEntry,
  publishConnectionFrame,
  readNotifyPresence,
} from "~/infra/websocket"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { queueRoutineAlert } from "~/modules/agent/routines/routine-alert"
import { deliverRoutineReport, settleRunLineOfRun } from "~/modules/agent/routines/routine-report"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { openConnectionTurnTaint } from "~/modules/mcp/connection-service"
import { claimConfirmations } from "~/modules/node-sessions/confirmations"
import {
  afterRunEnded,
  sweepSessionLeases,
  unpauseHeldSession,
} from "~/modules/node-sessions/lifecycle"
import { type FolderRef, resolveFolder, resolveModel } from "~/modules/node-sessions/resolve"
import {
  appendServerEvents,
  createSessionForJob,
  fanOut,
  isPrUrl,
  type NodeSessionImportInput,
  type NodeSessionRow,
  type StoredSessionEvent,
} from "~/modules/node-sessions/store"
import {
  fireSessionStatus,
  fireSessionWaiting,
  type SessionStatusChange,
  type SessionWaitingRequest,
} from "~/modules/node-sessions/waiting-hook"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { isMessageVisible } from "~/services/security/visibility"
import { isSimulatedNode, type NodeRow } from "./credentials"
import {
  bindNodeJobConnectionKey,
  clearNodeJobTaint,
  unbindNodeJobConnectionKey,
} from "./job-taint-store"
import { liveDesktopConnections, sweepStaleNodeSessions } from "./presence"
import {
  nodeTurnAlive,
  nodeTurnEnded,
  nodeTurnQueued,
  nodeTurnRequeued,
  nodeTurnRunning,
} from "./turn-live"

const K = () => sql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "node-jobs" })

/** The lease a claim or heartbeat grants (spec-node.md protocol). */
export const NODE_LEASE_SECONDS = 120

export type NodeJobRow = typeof nodeJobs.$inferSelect

/** A resume run's session is no longer resumable (another one won the lock): nothing was stored. */
export class SessionNotResumableError extends Error {
  constructor(readonly sessionId: string) {
    super("session_not_resumable")
    this.name = "SessionNotResumableError"
  }
}

/** Creation refused (A18): nothing was stored. */
export class NodeJobRefusedError extends Error {
  constructor(
    readonly code: "source_scope" | "simulated_node",
    message: string,
  ) {
    super(message)
    this.name = "NodeJobRefusedError"
  }
}

// ── profiles ────────────────────────────────────────────────────────────────

export interface NodeProfile {
  /** The guardrail level the agent's node runs use (S20, D18). */
  level: NodeLevel
  /** Whether those runs get the agent's Liaison tools (D21: on by default). */
  liaisonTools: boolean
}

export const DEFAULT_NODE_PROFILE: NodeProfile = { level: "strict", liaisonTools: true }

/** The profile a job runs under: the owner's row for that agent, else default. */
export async function loadNodeProfile(
  orgId: string,
  ownerUserId: string,
  agentId: string,
): Promise<NodeProfile> {
  const [row] = await withPrivilegedDb(orgId, "nodes:profile-load", (tx) =>
    tx
      .select({ level: nodeProfiles.level, liaisonTools: nodeProfiles.liaisonTools })
      .from(nodeProfiles)
      .where(
        and(
          eq(nodeProfiles.orgId, orgId),
          eq(nodeProfiles.nodeOwnerUserId, ownerUserId),
          eq(nodeProfiles.agentId, agentId),
        ),
      )
      .limit(1),
  )
  return row ? { level: row.level, liaisonTools: row.liaisonTools } : DEFAULT_NODE_PROFILE
}

// ── sessions (P1) ───────────────────────────────────────────────────────────

/** The oldest protocol a node may claim with (D46, D47); an older or absent one is refused. */
export const NODE_PROTOCOL_MIN = 2
export const NODE_PROTOCOL_HEADER = "X-Liaison-Node-Protocol"
/** The reason an outdated desktop's job and session end with (D46). */
export const NODE_OUTDATED_ERROR =
  "Update the Liaison desktop app on this computer, then run it again."

/** Every status a session is not ended in (the shared ended list's complement). */
const LIVE_SESSION_STATUSES: readonly NodeSessionStatus[] = NODE_SESSION_STATUSES.filter(
  (s) => !isEndedSessionStatus(s),
)

type ChangeCause = SessionStatusChange["cause"]

/** A session change to send to its owner once the transaction committed (D40). */
export type SessionChange = {
  row: NodeSessionRow
  events: StoredSessionEvent[]
  becameWaiting?: SessionWaitingRequest
  /** A status transition: where it came from, where it went, why and who caused it. */
  from?: NodeSessionStatus
  to?: NodeSessionStatus
  reason?: string
  cause?: ChangeCause
}

/**
 * Send the collected session changes after the commit; best effort, clients
 * heal by pull. Then the hooks: the waiting edge, and every status change.
 */
async function fanOutAll(changes: ReadonlyArray<SessionChange | null | undefined>) {
  for (const change of changes) if (change) await fanOut(change.row, change.events)
  for (const c of changes) if (c?.becameWaiting) void fireSessionWaiting(c.row, c.becameWaiting)
  for (const c of changes) {
    if (!c?.from || !c.to || c.from === c.to) continue
    void fireSessionStatus(c.row, {
      from: c.from,
      to: c.to,
      cause: c.cause ?? "server",
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.becameWaiting ? { becameWaiting: c.becameWaiting } : {}),
    })
  }
}

const SESSION_ERROR_MAX = 2000

/**
 * Move the session a job carries to `to`, from one of `from`, with a server
 * `status` event in its sequence (D33, D36). Ending sets `ended_at` (and
 * `error` on a failure); `queued` again clears them. Null when the job has no
 * session or the session is in none of `from`. Runs in the caller's
 * transaction, which holds the session row from here on.
 */
async function transitionJobSession(
  tx: PrivilegedDb,
  job: Pick<NodeJobRow, "id" | "orgId">,
  to: NodeSessionStatus,
  opts: {
    from: readonly NodeSessionStatus[]
    reason?: string
    error?: string
    code?: string
    /** Who caused it, for the status hook (default: the server). */
    cause?: ChangeCause
  },
): Promise<SessionChange | null> {
  const [current] = await tx
    .select({ id: nodeSessions.id, status: nodeSessions.status })
    .from(nodeSessions)
    .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId)))
    .for("update")
  if (!current || !opts.from.includes(current.status)) return null
  const error = opts.error ? opts.error.slice(0, SESSION_ERROR_MAX) : undefined
  const appended = await appendServerEvents(tx, job.orgId, current.id, [
    {
      at: new Date().toISOString(),
      type: "status",
      payload: {
        status: to,
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(error ? { error } : {}),
        ...(opts.code ? { code: opts.code } : {}),
      },
    },
  ])
  if (!appended) return null
  const ending = isEndedSessionStatus(to)
  const [row] = await tx
    .update(nodeSessions)
    .set(
      ending
        ? { endedAt: new Date(), ...(to === "failed" ? { error: error ?? null } : {}) }
        : { endedAt: null, error: null },
    )
    .where(and(eq(nodeSessions.id, current.id), eq(nodeSessions.orgId, job.orgId)))
    .returning()
  return {
    row,
    events: appended.events,
    from: current.status,
    to,
    cause: opts.cause ?? "server",
    ...(opts.reason ? { reason: opts.reason } : {}),
  }
}

/**
 * Point an existing session at a new run (P3, D36): under the row lock, only
 * from `from`; the session goes back to queued (its end and error cleared).
 * Null when the session is gone, not the job owner's, or no longer in `from`.
 */
async function attachResumeRun(
  tx: PrivilegedDb,
  job: NodeJobRow,
  resume: NonNullable<CreateNodeJobInput["resume"]>,
): Promise<SessionChange | null> {
  const [current] = await tx
    .select({
      id: nodeSessions.id,
      status: nodeSessions.status,
      importMode: nodeSessions.importMode,
    })
    .from(nodeSessions)
    .where(
      and(
        eq(nodeSessions.id, resume.sessionId),
        eq(nodeSessions.orgId, job.orgId),
        eq(nodeSessions.ownerUserId, job.ownerUserId),
      ),
    )
    .for("update")
  if (!current || !resume.from.includes(current.status)) return null
  // A53 (D45): a follow-mode import is never resumed (the CLI session is not
  // ours to write to) until its owner takes it over (`take_over`).
  if (current.importMode === "follow") return null
  await tx
    .update(nodeSessions)
    .set({ jobId: job.id, updatedAt: new Date() })
    .where(and(eq(nodeSessions.id, current.id), eq(nodeSessions.orgId, job.orgId)))
  return transitionJobSession(tx, job, "queued", {
    from: resume.from,
    reason: job.kind === "follow" ? "follow" : resume.after ? `resume_${resume.after}` : "rerun",
    // A message the owner sent reopens it; any other resume is the server's.
    cause: resume.after === "message" ? "owner" : "server",
  })
}

/** The input a job's session is created from (never for an interactive job). */
export interface NodeJobSessionInput {
  source: NodeSessionSource
  configKind: NodeSessionConfigKind
  folderName?: string | null
  /** The chosen node's path (dispatch, app: the job targets that node). */
  folderPath?: string | null
  /** A git URL or a shared repo folder's name (dispatch). */
  repo?: string | null
  /** The node model; "default" for a routine or agent_tag run means the agent's preference. */
  model: string
  level: NodeLevel
  /** The reasoning effort (null or absent: the model's default). */
  effort?: EffortLevel | null
  /** S30: guided (absent) or autonomous. */
  autonomy?: Autonomy
  /** S57: how the session finishes; null or absent: the default (a pull request for a repo). */
  finishWith?: FinishWith | null
  title?: string
  sourceThreadId?: string | null
  sourceMessageId?: string | null
  /** W3 (A51): an imported Claude Code session's import columns. */
  import?: NodeSessionImportInput
  /** Server events appended after the first status (an import's model line). */
  events?: readonly NodeSessionEventIn[]
}

// ── offers ──────────────────────────────────────────────────────────────────

/**
 * The presence entries of the owner's live, enabled, unrevoked nodes (one
 * node may hold several connections), optionally limited to one named node.
 */
export async function liveNodeTargets(
  orgId: string,
  ownerUserId: string,
  targetNodeId?: string | null,
): Promise<NotifyPresenceEntry[]> {
  const live = await liveDesktopConnections(orgId, ownerUserId)
  if (live.size === 0) return []
  const rows = await withPrivilegedDb(orgId, "nodes:live-targets", (tx) =>
    tx
      .select({ id: nodes.id, deviceId: nodes.deviceId })
      .from(nodes)
      .where(
        and(
          eq(nodes.orgId, orgId),
          eq(nodes.ownerUserId, ownerUserId),
          eq(nodes.enabled, true),
          isNull(nodes.revokedAt),
          // A simulated node (demo replay) is never offered a job: no socket
          // stands behind its synthetic presence.
          eq(nodes.simulated, false),
          ...(targetNodeId ? [eq(nodes.id, targetNodeId)] : []),
        ),
      ),
  )
  return rows.flatMap((n) => live.get(n.id) ?? [])
}

async function sendOffer(
  targets: NotifyPresenceEntry[],
  job: Pick<NodeJobRow, "id" | "agentId">,
): Promise<number> {
  if (targets.length === 0) return 0
  const jobId = job.id
  const frame: NodeJobOfferFrame = { type: "node_job_offer", jobId, agentId: job.agentId }
  try {
    const manager = getWsManager()
    if (manager) return (await manager.sendNotifyEach(targets, frame)).filter(Boolean).length
    return await publishConnectionFrame(redis, targets, frame)
  } catch (err) {
    log.warn({ err, jobId }, "node job offer failed")
    return 0
  }
}

/**
 * A58: a follow job goes only to nodes that published the import protocol
 * (`node_capabilities.import_protocol` >= 5); an older node never hears of it.
 */
async function followCapableTargets(
  orgId: string,
  targets: NotifyPresenceEntry[],
): Promise<NotifyPresenceEntry[]> {
  const ids = [...new Set(targets.map((t) => t.nodeId).filter((id): id is string => !!id))]
  if (ids.length === 0) return []
  const rows = await withPrivilegedDb(orgId, "nodes:follow-capable", (tx) =>
    tx
      .select({ nodeId: nodeCapabilities.nodeId, importProtocol: nodeCapabilities.importProtocol })
      .from(nodeCapabilities)
      .where(and(eq(nodeCapabilities.orgId, orgId), inArray(nodeCapabilities.nodeId, ids))),
  )
  const capable = new Set(
    rows.filter((r) => (r.importProtocol ?? 0) >= NODE_PROTOCOL_IMPORT).map((r) => r.nodeId),
  )
  return targets.filter((t) => !!t.nodeId && capable.has(t.nodeId))
}

/**
 * Whether one node published the import protocol with its capabilities
 * (import-requests.ts asks it before an import listing or check). Bound to
 * org and node; node_capabilities is written privileged (0140).
 */
export async function nodeSpeaksImport(orgId: string, nodeId: string): Promise<boolean> {
  const [row] = await withPrivilegedDb(orgId, "nodes:import-protocol", (tx) =>
    tx
      .select({ importProtocol: nodeCapabilities.importProtocol })
      .from(nodeCapabilities)
      .where(and(eq(nodeCapabilities.nodeId, nodeId), eq(nodeCapabilities.orgId, orgId)))
      .limit(1),
  )
  return (row?.importProtocol ?? 0) >= NODE_PROTOCOL_IMPORT
}

/** Offer one job to the owner's live nodes; marks it `offered` when a frame went out. */
async function offerJob(job: NodeJobRow, targets?: NotifyPresenceEntry[]): Promise<number> {
  let to = targets ?? (await liveNodeTargets(job.orgId, job.ownerUserId, job.targetNodeId))
  if (job.kind === "follow") to = await followCapableTargets(job.orgId, to)
  const sent = await sendOffer(to, job)
  if (sent > 0) {
    await withPrivilegedDb(job.orgId, "nodes:job-offered", (tx) =>
      tx
        .update(nodeJobs)
        .set({ status: "offered", offeredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(nodeJobs.id, job.id),
            eq(nodeJobs.orgId, job.orgId),
            eq(nodeJobs.status, "queued"),
          ),
        ),
    )
  }
  return sent
}

/**
 * A node connection said hello: offer it the owner's waiting jobs that are
 * NOT backlog (created while a node was live, or requeued after a lease ran
 * out before the run started). Backlog jobs wait for the node's own prompt.
 */
export async function offerWaitingJobsToConnection(input: {
  orgId: string
  userId: string
  nodeId: string
  connId: string
}): Promise<number> {
  const entries = await readNotifyPresence(redis, input.orgId, input.userId)
  const entry = entries.find((e) => e.connId === input.connId)
  if (!entry) return 0
  const waiting = await withPrivilegedDb(input.orgId, "nodes:waiting-jobs", (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.orgId, input.orgId),
          eq(nodeJobs.ownerUserId, input.userId),
          inArray(nodeJobs.status, ["queued", "offered"]),
          eq(nodeJobs.backlog, false),
          or(isNull(nodeJobs.targetNodeId), eq(nodeJobs.targetNodeId, input.nodeId)),
        ),
      )
      .orderBy(asc(nodeJobs.createdAt))
      .limit(50),
  )
  let sent = 0
  for (const job of waiting) sent += await offerJob(job, [entry])
  return sent
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateNodeJobInput {
  orgId: string
  ownerUserId: string
  agentId: string
  /**
   * The conversation the job answers in; null only for an app job (D32,
   * `node_jobs_thread_required`). A thread-less job posts no message: its
   * result is its session's (P1-T18). Decided for the taint (T16/T17 note):
   * nothing asks `nodeJobReplyScope` for a thread-less job, and its
   * thread-less branch (the agent's ceiling union the source scopes, the
   * strictest bound) stays as the fail-safe should anything ever do so.
   */
  threadId: string | null
  source: NodeJobSource
  sourceRef?: string | null
  routineId?: string | null
  runsOn?: NodeRunsOn
  prompt: string
  /** Trigger / tagged content for the node's untrusted-data block (A22). */
  trigger?: Record<string, unknown> | null
  /** The read scopes of the triggering content (A18). */
  sourceRequiredScopes: string[]
  tokenBudget?: number | null
  hardTokenLimit?: number | null
  targetNodeId?: string | null
  requesterUserId?: string | null
  requesterAgentId?: string | null
  replyThreadId?: string | null
  replyMessageId?: string | null
  /** An interactive node chat turn (S24) or an unattended job (default). */
  kind?: NodeJobKind
  /** Interactive only: the session's permission mode (A24: never bypass). */
  permissionMode?: NodePermissionMode | null
  /** Interactive only: the SDK session the node resumes. */
  sdkSessionId?: string | null
  /** The session this job is the run of (P1); ignored for an interactive job. */
  session?: NodeJobSessionInput
  /**
   * P3 (D36): this job is a new run of an EXISTING session instead of a new
   * one. In the creating transaction the session row is locked and must still
   * be in `from` (else `SessionNotResumableError` and nothing is stored); it
   * then points at this job and goes back to queued. The node starts it as a
   * resume of the session's SDK session (`resumeAfter`), delivering
   * `resumeCommandId` (the message that woke it) as its prompt.
   */
  resume?: {
    sessionId: string
    from: readonly NodeSessionStatus[]
    /** Null: the session's prompt runs again, with no SDK session to resume. */
    after: NodeJobResumeAfter | null
    commandId?: string | null
  }
  /**
   * Runs in the creating transaction, after the job and its session are
   * inserted and before anything is offered (P1-T19: the app start attaches
   * its level confirmation to the new session). Throwing creates nothing.
   */
  inTransaction?: (
    tx: PrivilegedDb,
    created: { job: NodeJobRow; sessionId?: string },
  ) => Promise<void>
}

async function ownerGrants(orgId: string, userId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "nodes:owner-perms", async (tx) => {
    const perms = await loadEffectivePermissions(tx, userId, orgId)
    return perms.scopes
  })
}

/**
 * Store a node job and offer it (S20). Refused, with nothing stored, when the
 * node owner could not read the content that triggered it (A18). Queued runs
 * of the same routine coalesce into the newest (A23).
 */
/**
 * Whether a job's target is a simulated (recorded demo) node. Only a demo
 * instance can hold one, so elsewhere no query runs.
 */
async function isSimulatedTarget(orgId: string, nodeId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  const [row] = await withPrivilegedDb(orgId, "nodes:target-simulated", (tx) =>
    tx
      .select({ simulated: nodes.simulated })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.orgId, orgId)))
      .limit(1),
  )
  return row?.simulated === true
}

/**
 * A job row that a simulated (recorded demo) node holds or is targeted at: the
 * lease sweeps leave it out, so a replay is never requeued, re-offered to the
 * owner's real nodes, interrupted or paused. Its replay ticker owns it.
 */
export const notOnSimulatedNode = sql`NOT EXISTS (SELECT 1 FROM ${K()}.nodes sim WHERE sim.simulated AND sim.id IN (${nodeJobs.nodeId}, ${nodeJobs.targetNodeId}, ${nodeJobs.leaseHolder}))`

export async function createNodeJob(
  input: CreateNodeJobInput,
): Promise<NodeJobRow & { sessionId?: string }> {
  const sourceScopes = [...new Set(input.sourceRequiredScopes)].sort()
  if (sourceScopes.length > 0) {
    const grants = await ownerGrants(input.orgId, input.ownerUserId)
    const readable = isMessageVisible(
      { requiredScopes: sourceScopes, disclosureList: null },
      { userId: input.ownerUserId, grants },
    )
    if (!readable) {
      throw new NodeJobRefusedError(
        "source_scope",
        "The node owner cannot read what this job was asked from, so it cannot run on their computer.",
      )
    }
  }

  if (input.targetNodeId && (await isSimulatedTarget(input.orgId, input.targetNodeId))) {
    throw new NodeJobRefusedError(
      "simulated_node",
      "This computer is a recorded demo: it plays its recorded session and runs nothing else.",
    )
  }
  const targets = await liveNodeTargets(input.orgId, input.ownerUserId, input.targetNodeId)
  // Walk D4: a session's next run is never backlog. A run that died while the
  // app was quit is resumed from the relaunched node's report, which can come
  // before its socket is bound; as backlog it waited for the next launch.
  const backlog = targets.length === 0 && !input.resume

  const changes: SessionChange[] = []
  let sessionId: string | undefined
  const job = await withPrivilegedDb(input.orgId, "nodes:job-create", async (tx) => {
    let skipped = 0
    if (input.routineId) {
      // One routine's queued runs fold into the newest; serialised per
      // routine so two ticks cannot each keep their own.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`node-job-routine:${input.routineId}`}))`,
      )
      const older = await tx
        .update(nodeJobs)
        .set({
          status: "cancelled",
          errorCode: "coalesced",
          error: "Replaced by a newer run of the same routine before it started.",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nodeJobs.routineId, input.routineId),
            eq(nodeJobs.orgId, input.orgId),
            inArray(nodeJobs.status, ["queued", "offered"]),
          ),
        )
        .returning({
          id: nodeJobs.id,
          skippedCount: nodeJobs.skippedCount,
          sourceRef: nodeJobs.sourceRef,
        })
      skipped = older.reduce((n, r) => n + r.skippedCount + 1, 0)
      // Their sessions end too, saying why (L29).
      for (const r of older) {
        const stopped = await transitionJobSession(
          tx,
          { id: r.id, orgId: input.orgId },
          "stopped",
          {
            from: LIVE_SESSION_STATUSES,
            reason: "replaced",
          },
        )
        if (stopped) changes.push(stopped)
      }
      // The runs those jobs carried end here: their row says why.
      const replaced = older.map((r) => r.sourceRef).filter((r): r is string => !!r)
      if (replaced.length > 0) {
        await tx
          .update(routineRuns)
          .set({ status: "failed", error: "Replaced by a newer run of the same routine." })
          .where(
            and(
              inArray(routineRuns.id, replaced),
              eq(routineRuns.orgId, input.orgId),
              eq(routineRuns.status, "dispatched"),
            ),
          )
      }
    }
    const [row] = await tx
      .insert(nodeJobs)
      .values({
        orgId: input.orgId,
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        threadId: input.threadId,
        targetNodeId: input.targetNodeId ?? null,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        routineId: input.routineId ?? null,
        runsOn: input.runsOn ?? "node",
        prompt: input.prompt,
        trigger: input.trigger ?? null,
        sourceRequiredScopes: sourceScopes,
        tokenBudget: input.tokenBudget ?? null,
        hardTokenLimit: input.hardTokenLimit ?? null,
        requesterUserId: input.requesterUserId ?? null,
        requesterAgentId: input.requesterAgentId ?? null,
        replyThreadId: input.replyThreadId ?? null,
        replyMessageId: input.replyMessageId ?? null,
        kind: input.kind ?? "unattended",
        permissionMode: input.kind === "interactive" ? (input.permissionMode ?? "manual") : null,
        sdkSessionId: input.kind === "interactive" ? (input.sdkSessionId ?? null) : null,
        backlog,
        skippedCount: skipped,
        resumeAfter: input.resume?.after ?? null,
        resumeCommandId: input.resume?.commandId ?? null,
      })
      .returning()
    if (input.resume) {
      const resumed = await attachResumeRun(tx, row, input.resume)
      if (!resumed) throw new SessionNotResumableError(input.resume.sessionId)
      sessionId = input.resume.sessionId
      changes.push(resumed)
    } else if (input.session && (input.kind ?? "unattended") !== "interactive") {
      const s = input.session
      const created = await createSessionForJob(tx, {
        job: row,
        source: s.source,
        configKind: s.configKind,
        title: s.title,
        prompt: input.prompt,
        folderName: s.folderName ?? null,
        folderPath: s.folderPath ?? null,
        repo: s.repo ?? null,
        model: s.model,
        level: s.level,
        effort: s.effort ?? null,
        autonomy: s.autonomy ?? "guided",
        finishWith: s.finishWith ?? null,
        sourceThreadId: s.sourceThreadId ?? null,
        sourceMessageId: s.sourceMessageId ?? null,
        ...(s.import ? { import: s.import } : {}),
        ...(s.events ? { events: s.events } : {}),
      })
      sessionId = created.row.id
      changes.push(created)
    }
    if (input.inTransaction) await input.inTransaction(tx, { job: row, sessionId })
    return row
  })
  await fanOutAll(changes)
  const withSession = sessionId ? { ...job, sessionId } : job

  // With no node live when this was read, one may have said hello since: its
  // hello's offer reads committed jobs only, so the offer is tried again here.
  const offerTo = backlog ? [] : targets.length > 0 ? targets : undefined
  // A node chat turn reads Queued in its chat while a computer is on to take
  // it (an offline one is told apart, below).
  if (!backlog) nodeTurnQueued(job)
  if (!backlog && (await offerJob(job, offerTo)) > 0) {
    return { ...withSession, status: "offered", offeredAt: new Date() }
  }
  // S23: offline at dispatch, the job waits. A session gets no offline push
  // (L19): it shows queued in Sessions. My node chat (an interactive job, no
  // session) is frozen as it was (D29): its owner is told.
  if (backlog && (input.kind ?? "unattended") === "interactive") await notifyNodeOwnerOffline(job)
  return withSession
}

/**
 * The notice an owner gets when a My node chat turn arrives while their node
 * is offline (S23, spec-node.md "Routing"; D29 keeps it for node chat only):
 * an attention item of the `agent` group, counting every job waiting for one
 * of their nodes.
 */
export async function notifyNodeOwnerOffline(
  job: Pick<NodeJobRow, "id" | "orgId" | "ownerUserId" | "agentId" | "threadId">,
): Promise<void> {
  try {
    const [{ waiting }] = await withPrivilegedDb(job.orgId, "nodes:offline-count", (tx) =>
      tx
        .select({ waiting: sql<number>`count(*)::int` })
        .from(nodeJobs)
        .where(
          and(
            eq(nodeJobs.orgId, job.orgId),
            eq(nodeJobs.ownerUserId, job.ownerUserId),
            inArray(nodeJobs.status, ["queued", "offered"]),
          ),
        ),
    )
    const n = Math.max(1, waiting)
    await withPrivilegedDb(job.orgId, "nodes:offline-notify", async (tx) => {
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary: `Your computer is offline; ${n} ${n === 1 ? "job" : "jobs"} waiting.`,
          urgency: 50,
          targetUserIds: [job.ownerUserId],
          // An app job has no thread (D32): the link opens Sessions.
          link: job.threadId
            ? { tabType: "thread", entityId: job.threadId }
            : { tabType: "sessions" },
          nodeOffline: true,
        },
        actorId: job.ownerUserId,
        actorType: "system",
        agentId: job.agentId,
        orgId: job.orgId,
        timestamp: new Date().toISOString(),
      })
    })
  } catch (err) {
    log.error({ err, jobId: job.id }, "node offline notification failed")
  }
}

/**
 * `node_else_cloud` found no live node (S23, D9): the run goes to the cloud,
 * and this row records that it did. It is never offered or claimed.
 */
export async function recordFellBackJob(
  input: Omit<CreateNodeJobInput, "runsOn">,
): Promise<NodeJobRow> {
  const [row] = await withPrivilegedDb(input.orgId, "nodes:job-fell-back", (tx) =>
    tx
      .insert(nodeJobs)
      .values({
        orgId: input.orgId,
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        threadId: input.threadId,
        targetNodeId: input.targetNodeId ?? null,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        routineId: input.routineId ?? null,
        runsOn: "node_else_cloud",
        prompt: input.prompt,
        trigger: input.trigger ?? null,
        sourceRequiredScopes: [...new Set(input.sourceRequiredScopes)].sort(),
        tokenBudget: input.tokenBudget ?? null,
        hardTokenLimit: input.hardTokenLimit ?? null,
        requesterUserId: input.requesterUserId ?? null,
        requesterAgentId: input.requesterAgentId ?? null,
        replyThreadId: input.replyThreadId ?? null,
        replyMessageId: input.replyMessageId ?? null,
        status: "fell_back",
        errorCode: "no_live_node",
        error: "No node of the owner was online: the run went to the cloud.",
        finishedAt: new Date(),
      })
      .returning(),
  )
  return row
}

/**
 * A routine run handed to a node ends with its job (A50/F8): the run row
 * written `dispatched` at the tick turns `succeeded` or `failed`, the
 * routine's last run says so, and a one-shot routine completes only now, on
 * success. A successful run whose node wrote a final message (`reported`)
 * reports it to the routine's conversation as a cloud tick does
 * (routine-report.ts), once: only the settle that moved the run row off
 * `dispatched` posts it. Best effort: the job's own record is already final.
 */
export async function settleRoutineRunForJob(
  job: Pick<NodeJobRow, "orgId" | "routineId" | "sourceRef" | "createdAt" | "ownerUserId"> & {
    finishedAt?: Date | null
    threadId?: string | null
  },
  outcome: { ok: true; reported?: boolean } | { ok: false; error: string },
): Promise<void> {
  if (!job.routineId) return
  const routineId = job.routineId
  try {
    const error = outcome.ok ? null : outcome.error
    const status = outcome.ok ? "succeeded" : "failed"
    const settledTick = await withPrivilegedDb(
      job.orgId,
      "nodes:routine-run-settle",
      async (tx) => {
        let settled:
          | { id: string; ranAt: Date; durationMs: number | null; eventEntityId: string | null }
          | undefined
        if (job.sourceRef) {
          ;[settled] = await tx
            .update(routineRuns)
            .set({
              status,
              error,
              durationMs: Math.max(
                0,
                (job.finishedAt?.getTime() ?? Date.now()) - job.createdAt.getTime(),
              ),
              ...(outcome.ok ? { turnsAdded: 1 } : {}),
            })
            .where(
              and(
                eq(routineRuns.id, job.sourceRef),
                eq(routineRuns.orgId, job.orgId),
                eq(routineRuns.status, "dispatched"),
              ),
            )
            .returning({
              id: routineRuns.id,
              ranAt: routineRuns.ranAt,
              durationMs: routineRuns.durationMs,
              eventEntityId: routineRuns.eventEntityId,
            })
        }
        const [routine] = await tx
          .select()
          .from(routines)
          .where(and(eq(routines.id, routineId), eq(routines.orgId, job.orgId)))
          .limit(1)
        if (!routine) return null
        // D21: a node run that failed tells the routine's owner on Home.
        if (!outcome.ok && settled) {
          await queueRoutineAlert(tx, {
            orgId: job.orgId,
            routine: {
              id: routineId,
              name: routine.name,
              ownerUserId: routine.ownerUserId,
              ownerAgentId: routine.ownerAgentId,
              outputThreadId: routine.outputThreadId,
            },
            status: "failed",
            error,
          })
        }
        const completes = outcome.ok && routine.kind === "scheduled" && routine.status === "active"
        await tx
          .update(routines)
          .set({
            lastRunAt: new Date(),
            lastRunStatus: status,
            lastRunError: error,
            ...(completes ? { status: "completed" } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(routines.id, routineId), eq(routines.orgId, job.orgId)))
        // An open Routines page hears the settle as it hears a cloud tick's end
        // (routine-worker emitRoutineEvent): the run row as `run_completed`,
        // durable and so declared in KERNEL_DECLARED_EMITS, in this transaction;
        // `routine:status` is ephemeral (undeclared: queueing it throws and rolls
        // the settle back) and goes out after the commit. Without them the page
        // kept "dispatched" until a reload (A57 walk).
        const event = {
          app: "kernel" as const,
          entity: "routine" as const,
          entityId: routineId,
          actorId: routine.ownerUserId,
          actorType: "system" as const,
          agentId: routine.ownerAgentId,
          orgId: job.orgId,
        }
        if (settled) {
          const ranAt = settled.ranAt.toISOString()
          await tx.queueEvent({
            ...event,
            action: "run_completed",
            data: {
              routineId,
              run: {
                id: settled.id,
                routineId,
                ranAt,
                status,
                durationMs: settled.durationMs,
                errorMessage: error,
                eventEntityId: settled.eventEntityId,
              },
              runId: settled.id,
              status,
              routineName: routine.name,
              eventEntityId: settled.eventEntityId,
              ranAt,
              error,
            },
          })
        }
        return {
          routine,
          reports: settled !== undefined && outcome.ok && outcome.reported === true,
          statusEvent: {
            ...event,
            action: "status",
            data: {
              routineId,
              status: completes ? "completed" : routine.status,
              lastRunStatus: status,
              lastRunError: error,
              ranAt: new Date().toISOString(),
            },
          },
        }
      },
    )
    if (!settledTick) return
    // The run's "is running" line in the routine's conversation says how it
    // ended (routine-report.ts), keyed on the run row this job settled.
    if (job.sourceRef) {
      await settleRunLineOfRun(
        job.orgId,
        routineId,
        job.sourceRef,
        outcome.ok ? "succeeded" : "failed",
      )
    }
    // After the commit, the same report a cloud tick posts: the node's result
    // is already the tick's final reply in the output thread.
    if (settledTick.reports && settledTick.routine.reportThreadId && job.threadId) {
      const routine = settledTick.routine
      const ownerScopes = await withPrivilegedDb(job.orgId, "nodes:routine-report-perms", (tx) =>
        loadEffectivePermissions(tx, routine.ownerUserId, job.orgId),
      )
      await deliverRoutineReport({
        orgId: job.orgId,
        routine,
        outputThreadId: job.threadId,
        since: job.createdAt,
        ownerScopes: ownerScopes.scopes,
      })
    }
    await broadcastEphemeral(settledTick.statusEvent)
  } catch (err) {
    log.error({ err, routineId }, "settling the routine run of a node job failed")
  }
}

// ── claim ───────────────────────────────────────────────────────────────────

/** W2-D5: the statuses in which an in-place session holds its folder's checkout. */
const HOLDS_FOLDER: readonly NodeSessionStatus[] = ["running", "waiting", "paused", "needs_you"]

const HOLDER_STATUS_LABEL: Record<string, string> = {
  running: "running",
  waiting: "waiting on you",
  paused: "paused",
  needs_you: "waiting on you",
  queued: "about to resume",
}

/**
 * W2-D5: the newest other in-place (owner) session of this owner in the same
 * folder on this node that still holds the checkout: live, paused, waiting on
 * the owner, or queued for a resume of a run that already started. One
 * display line, or null.
 */
async function folderHolder(
  tx: PrivilegedDb,
  node: NodeRow,
  sessionId: string,
  folderName: string,
): Promise<string | null> {
  const [holder] = await tx
    .select({ id: nodeSessions.id, title: nodeSessions.title, status: nodeSessions.status })
    .from(nodeSessions)
    .where(
      and(
        eq(nodeSessions.orgId, node.orgId),
        eq(nodeSessions.ownerUserId, node.ownerUserId),
        eq(nodeSessions.nodeId, node.id),
        eq(nodeSessions.folderName, folderName),
        eq(nodeSessions.configKind, "owner"),
        ne(nodeSessions.id, sessionId),
        or(
          inArray(nodeSessions.status, [...HOLDS_FOLDER]),
          and(eq(nodeSessions.status, "queued"), sql`${nodeSessions.startedAt} IS NOT NULL`),
        ),
      ),
    )
    .orderBy(desc(nodeSessions.updatedAt))
    .limit(1)
  if (!holder) return null
  const title = Array.from(holder.title.replace(/[\p{Cc}"]+/gu, " ").trim())
    .slice(0, 60)
    .join("")
  return `"${title}" (${holder.id.slice(0, 8)}, ${HOLDER_STATUS_LABEL[holder.status] ?? holder.status})`
}

/** What a claim tells the node about the session it runs (P1, spec-protocol.md). */
export interface ClaimedSession {
  id: string
  /** The claiming node's own path for the folder (K9); null: the node fails `folder_missing`. */
  folderPath: string | null
  folderName: string | null
  /** A git URL or a shared repo folder's name the node clones (a routine's `repo`). */
  repo: string | null
  model: string
  /** The level this run starts at. */
  level: NodeLevel
  /** The agent's profile level, which the node's pin follows (D24, D42). */
  profileLevel: NodeLevel
  /** The session's reasoning effort; null: the model's default. */
  effort: EffortLevel | null
  /** S30: guided or autonomous. */
  autonomy: Autonomy
  /** S57: as asked; null: a pull request when the folder is a repository, nothing otherwise. */
  finishWith: FinishWith | null
  /**
   * W2-D5: another in-place session in this folder (same computer) that still
   * holds its checkout, as one display line (`"<title>" (<short id>, <status>)`).
   * The node then never switches the folder's branch for this one (D40): it
   * ends Needs you with that reason. Absent: nobody else holds it.
   */
  folderHeldBy?: string
  /**
   * A44: an import's recorded cwd below its shared folder (relative, never
   * absolute); the node runs there or refuses `unsafe_subdir`. Absent: the folder.
   */
  cwdSubdir?: string
  /**
   * D53: the shared repo's own worktree outside the folder that `cwdSubdir`
   * is below; the node accepts it only among the worktrees git lists for the
   * folder, or refuses `unsafe_subdir`. Absent: the folder.
   */
  worktreePath?: string
  configKind: NodeSessionConfigKind
  liaisonTools: boolean
  profileConfirmationId?: string
  sessionConfirmationId?: string
  /**
   * P3 (D36): this run resumes the session's SDK session (null: none exists,
   * the prompt runs fresh), and why; `commandId` is the message it delivers.
   */
  resume?: {
    sdkSessionId: string | null
    after: NodeJobResumeAfter
    commandId?: string
    /** S51 (D28): the message was sent confirmed while another Claude Code drove the session. */
    confirmDrivenElsewhere?: true
    /**
     * A62: a taken-over import's first resume: the transcript byte offset its
     * follow reached; the node replays from there to the end before the SDK starts.
     */
    catchUpFrom?: number
  }
}

export type ClaimOutcome =
  | {
      kind: "claimed"
      job: NodeJobRow
      leaseGeneration: number
      leaseExpiresAt: Date
      profile: NodeProfile
      session?: ClaimedSession
      /** The node's live caps (D35): how many runs it may hold at once. */
      caps: { maxLive: number; maxBackground: number }
    }
  | {
      /** A45, A58: a follow job, claimed outside the run plan (no profile, model or MCP). */
      kind: "claimed_follow"
      job: NodeJobRow
      leaseGeneration: number
      leaseExpiresAt: Date
      session: ClaimedSession
      follow: NodeFollowClaim
    }
  | { kind: "not_found" }
  | { kind: "node_outdated" }
  | { kind: "conflict"; reason: "already_claimed" | "node_busy" | "not_claimable" }
  | { kind: "refused"; code: string; error: string }
  | { kind: "node_disabled" }
  | { kind: "bad_connection" }

/** A job is claimable while it waits, or while its lease lapsed before the run started. */
const claimableNow = sql`(${nodeJobs.status} IN ('queued', 'offered') OR (
  ${nodeJobs.status} = 'running' AND ${nodeJobs.leaseExpiresAt} < now() AND ${nodeJobs.startedAt} IS NULL))`

/**
 * The routine pre-checks a tick runs that still mean something on a node
 * (scope drift, owner ceiling), re-run at claim (A23, A51): the job may have
 * waited a long time. Null when the routine may still run, else the refusal.
 */
async function routinePreCheck(
  orgId: string,
  routineId: string,
): Promise<{ code: string; error: string } | null> {
  const [routine] = await withPrivilegedDb(orgId, "nodes:routine-precheck", (tx) =>
    tx
      .select({
        ownerUserId: routines.ownerUserId,
        ownerAgentId: routines.ownerAgentId,
        scopes: routines.scopes,
        enabled: routines.enabled,
        status: routines.status,
      })
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
      .limit(1),
  )
  if (!routine) return { code: "routine_gone", error: "The routine this job came from is gone." }
  if (!routine.enabled || routine.status !== "active") {
    return { code: "routine_paused", error: "The routine this job came from is paused." }
  }
  const needed = routine.scopes ?? []
  const grants = await ownerGrants(orgId, routine.ownerUserId)
  const missing = needed.filter((s) => !isScopeCovered([s], grants))
  if (missing.length > 0) {
    return {
      code: "scope_mismatch",
      error: `The owner no longer holds ${missing.join(", ")}, which this routine needs.`,
    }
  }
  if (routine.ownerAgentId) {
    const [owner] = await withPrivilegedDb(orgId, "nodes:routine-ceiling", (tx) =>
      tx
        .select({ scopeCeiling: agents.scopeCeiling })
        .from(agents)
        .where(and(eq(agents.id, routine.ownerAgentId as string), eq(agents.orgId, orgId)))
        .limit(1),
    )
    if (owner) {
      const ceiling = owner.scopeCeiling ?? []
      const outside = needed.filter((s) => !isScopeCovered([s], ceiling))
      if (ceiling.length === 0 || outside.length > 0) {
        return {
          code: "scope_mismatch",
          error:
            outside.length > 0
              ? `The owner agent's scope ceiling does not cover ${outside.join(", ")}.`
              : "The owner agent holds no scopes.",
        }
      }
    }
  }
  // A51: no model-key / credit pre-check here. The node runs the job on its
  // owner's own Claude sign-in, so the cloud's key and credits are not what it
  // spends; refusing on them refused every routine job of an org without a
  // cloud model key.
  return null
}

interface Refusal {
  refused: boolean
  change: SessionChange | null
}

/**
 * Refuse a job for good in the caller's transaction, only while it is still
 * claimable, and fail its session with the reason (job-to-session mapping).
 * `refused: false` when the job is no longer claimable (another node holds or
 * ended it): nothing changed.
 */
async function refuseClaimable(
  tx: PrivilegedDb,
  job: NodeJobRow,
  code: string,
  error: string,
): Promise<Refusal> {
  const refused = await tx
    .update(nodeJobs)
    .set({
      status: "refused",
      errorCode: code,
      error,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, job.orgId), claimableNow))
    .returning({ id: nodeJobs.id })
  if (refused.length === 0) return { refused: false, change: null }
  return {
    refused: true,
    change: await transitionJobSession(tx, job, "failed", {
      from: LIVE_SESSION_STATUSES,
      error,
      code,
    }),
  }
}

/**
 * After the commit: the session change goes out, and the routine run is
 * settled failed only when THIS refusal ended the job (P1a S3: a refusal that
 * matched no row must not fail a run another node holds).
 */
async function afterRefusal(job: NodeJobRow, refusal: Refusal, error: string): Promise<void> {
  await fanOutAll([refusal.change])
  if (refusal.refused) await settleRoutineRunForJob(job, { ok: false, error })
}

async function refuseJob(
  job: NodeJobRow,
  code: string,
  error: string,
): Promise<{ kind: "refused"; code: string; error: string }> {
  const refusal = await withPrivilegedDb(job.orgId, "nodes:job-refuse", (tx) =>
    refuseClaimable(tx, job, code, error),
  )
  await afterRefusal(job, refusal, error)
  return { kind: "refused", code, error }
}

type ModelInput = { requested: string | null; agentPreference: string | null }

/**
 * Whether another of the owner's nodes can run this job (P1a S3): the job
 * targets no node, and some other enabled, unrevoked node of the owner has
 * published its capabilities (only a current desktop does, so it speaks this
 * protocol) and, for a session whose model resolves at claim, offers it.
 */
async function anotherNodeCanRun(
  tx: PrivilegedDb,
  node: NodeRow,
  job: NodeJobRow,
  modelInput: ModelInput | null,
): Promise<boolean> {
  if (job.targetNodeId !== null) return false
  const rows = await tx
    .select({ models: nodeCapabilities.models })
    .from(nodes)
    .innerJoin(
      nodeCapabilities,
      and(
        eq(nodeCapabilities.nodeId, nodes.id),
        eq(nodeCapabilities.orgId, nodes.orgId),
        eq(nodeCapabilities.ownerUserId, nodes.ownerUserId),
      ),
    )
    .where(
      and(
        eq(nodes.orgId, node.orgId),
        eq(nodes.ownerUserId, node.ownerUserId),
        eq(nodes.enabled, true),
        isNull(nodes.revokedAt),
        ne(nodes.id, node.id),
      ),
    )
  return rows.some(
    (r) => !modelInput || resolveModel({ models: offeredModels(r.models) }, modelInput).ok,
  )
}

/**
 * A capability refusal (an outdated desktop, D46; a model this node does not
 * offer, D45) is about the claiming node, not the job. Under the job's row
 * lock, like the claim: while the job is claimable and another node of the
 * owner can run it, only this node's claim is refused and the job stays
 * offered; when none can, the job is refused for good and its session fails.
 */
async function refuseForNode(
  node: NodeRow,
  job: NodeJobRow,
  code: string,
  error: string,
  modelInput: ModelInput | null,
): Promise<Refusal> {
  const refusal = await withPrivilegedDb(node.orgId, "nodes:job-refuse-node", async (tx) => {
    const [locked] = await tx
      .select({ id: nodeJobs.id })
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, job.orgId), claimableNow))
      .for("update")
      .limit(1)
    if (!locked) return { refused: false, change: null }
    if (await anotherNodeCanRun(tx, node, job, modelInput)) return { refused: false, change: null }
    return refuseClaimable(tx, job, code, error)
  })
  await afterRefusal(job, refusal, error)
  if (!refusal.refused) {
    log.info(
      { jobId: job.id, nodeId: node.id, code },
      "claim refused for this node only; the job stays offered",
    )
  }
  return refusal
}

function offeredModels(raw: unknown): Array<{ id: string }> {
  return ((raw ?? []) as Array<{ id?: unknown }>)
    .filter((m): m is { id: string } => !!m && typeof m.id === "string")
    .map((m) => ({ id: m.id }))
}

/** What the claiming node offers (K9): its folders with paths, and its models. */
async function claimingNodeOffer(
  node: NodeRow,
): Promise<{ folders: Array<FolderRef & { path: string }>; models: Array<{ id: string }> }> {
  const [row] = await withPrivilegedDb(node.orgId, "nodes:claim-capabilities", (tx) =>
    tx
      .select({ sharedFolders: nodeCapabilities.sharedFolders, models: nodeCapabilities.models })
      .from(nodeCapabilities)
      .where(
        and(
          eq(nodeCapabilities.nodeId, node.id),
          eq(nodeCapabilities.orgId, node.orgId),
          eq(nodeCapabilities.ownerUserId, node.ownerUserId),
        ),
      )
      .limit(1),
  )
  const folders = ((row?.sharedFolders ?? []) as Array<FolderRef & { path: string }>).filter(
    (f) => f && typeof f.name === "string" && typeof f.path === "string",
  )
  return { folders, models: offeredModels(row?.models) }
}

const GIT_URL = /^(https:\/\/\S+|ssh:\/\/\S+|git@[^\s:]+:\S+)$/

/** The session's run as this node will start it, or the refusal (model) at claim. */
type SessionPlan = (
  | {
      ok: true
      session: NodeSessionRow
      folderPath: string | null
      repo: string | null
      model: string
    }
  | { ok: false; code: string; error: string }
) & {
  /** What the model resolves from at claim; null when the session's model is fixed. */
  modelInput: ModelInput | null
}

/**
 * Before the claim's lock: the folder path on THIS node (K9: a stored path is
 * kept only when the job targets this node; otherwise the folder name or the
 * routine's repo folder resolves among this node's folders), and, for a
 * routine or agent_tag session, the model among this node's models (D45: an
 * explicit name exactly, else the agent's preference by family).
 */
async function planSessionRun(node: NodeRow, job: NodeJobRow): Promise<SessionPlan | null> {
  const [session] = await withPrivilegedDb(node.orgId, "nodes:claim-session", (tx) =>
    tx
      .select()
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, node.orgId)))
      .limit(1),
  )
  if (!session) return null
  const offer = await claimingNodeOffer(node)

  // D49: the session's own repo (a dispatch's), else its routine's.
  let repo: string | null = session.repo ?? null
  if (!repo && job.routineId) {
    const [routine] = await withPrivilegedDb(node.orgId, "nodes:claim-routine-repo", (tx) =>
      tx
        .select({ repo: routines.repo })
        .from(routines)
        .where(and(eq(routines.id, job.routineId as string), eq(routines.orgId, node.orgId)))
        .limit(1),
    )
    repo = routine?.repo ?? null
  }

  let folderPath: string | null = null
  if (session.folderPath && job.targetNodeId === node.id) {
    folderPath = session.folderPath
  } else if (session.folderName) {
    const found = resolveFolder(offer.folders, session.folderName)
    folderPath = found.ok ? found.folder.path : null
  } else if (repo && !GIT_URL.test(repo.trim())) {
    const found = resolveFolder(
      offer.folders.filter((f) => f.kind === "repo"),
      repo,
    )
    folderPath = found.ok ? found.folder.path : null
  }

  let model = session.model
  let modelInput: ModelInput | null = null
  if (session.source === "routine" || session.source === "agent_tag") {
    const [agent] = await withPrivilegedDb(node.orgId, "nodes:claim-agent-model", (tx) =>
      tx
        .select({ modelPreference: agents.modelPreference })
        .from(agents)
        .where(and(eq(agents.id, job.agentId), eq(agents.orgId, node.orgId)))
        .limit(1),
    )
    modelInput = {
      requested: session.model === "default" ? null : session.model,
      agentPreference: agent?.modelPreference ?? null,
    }
    const resolved = resolveModel(offer, modelInput)
    if (!resolved.ok) {
      const list = resolved.offered.length > 0 ? resolved.offered.join(", ") : "none"
      return {
        ok: false,
        code: "model_unavailable",
        error: `This computer does not offer the model ${session.model}. It offers: ${list}.`,
        modelInput,
      }
    }
    model = resolved.model
  }
  return { ok: true, session, folderPath, repo, model, modelInput }
}

/**
 * Claim a job for a node (A19, A20, A25, A27). The node credential and the
 * session already agree on the owner (`requireNodeCredential`); here the job
 * must be that owner's, the node must hold no other running job, and the
 * owner must still be allowed to run the agent (and, for a routine job, the
 * routine must still pass its pre-checks). The row lock makes the first
 * valid claim the only one.
 */
/**
 * Whether an MCP connection may carry a job's Liaison calls (A50/F6): the node
 * owner's own connection, bound to the job's agent, not revoked. The
 * connection is what the job's taint is keyed by, so it must be one only
 * this owner's runtime of this agent can use.
 */
async function isJobConnection(
  node: NodeRow,
  job: Pick<NodeJobRow, "agentId">,
  connectionId: string,
): Promise<boolean> {
  const [conn] = await withSystemDb("nodes:job-connection-check", (db) =>
    db
      .select({
        userId: mcpConnections.userId,
        orgId: mcpConnections.orgId,
        agentId: mcpConnections.agentId,
        revokedAt: mcpConnections.revokedAt,
      })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
      .limit(1),
  )
  return (
    !!conn &&
    conn.revokedAt === null &&
    conn.orgId === node.orgId &&
    conn.userId === node.ownerUserId &&
    conn.agentId === job.agentId
  )
}

/**
 * Bind the MCP connection a running job's Liaison calls go through (A50/F6),
 * so the gateway files every scope they touch under the job for its whole
 * life. Only the node holding the job may bind, and only a connection that
 * passes `isJobConnection`.
 */
export async function bindNodeJobConnection(
  node: NodeRow,
  jobId: string,
  connectionId: string,
): Promise<"bound" | "bad_connection" | "not_held"> {
  const [job] = await withPrivilegedDb(node.orgId, "nodes:job-connection-load", (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.id, jobId),
          eq(nodeJobs.orgId, node.orgId),
          eq(nodeJobs.status, "running"),
          eq(nodeJobs.leaseHolder, node.id),
        ),
      )
      .limit(1),
  )
  if (!job) return "not_held"
  if (!(await isJobConnection(node, job, connectionId))) return "bad_connection"
  await bindNodeJobConnectionKey(connectionId, job.id)
  await withPrivilegedDb(node.orgId, "nodes:job-connection-bind", (tx) =>
    tx
      .update(nodeJobs)
      .set({ mcpConnectionId: connectionId, updatedAt: new Date() })
      .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, node.orgId))),
  )
  return "bound"
}

/** A run ended (or lost its lease): the connection no longer speaks for this job. */
export async function releaseJobConnection(job: Pick<NodeJobRow, "id" | "mcpConnectionId">) {
  if (job.mcpConnectionId) await unbindNodeJobConnectionKey(job.mcpConnectionId, job.id)
}

export async function claimNodeJob(
  node: NodeRow,
  jobId: string,
  opts: { mcpConnectionId?: string; protocol?: number } = {},
): Promise<ClaimOutcome> {
  if (!node.enabled) return { kind: "node_disabled" }
  // A simulated node claims nothing (it never authenticates; this is the
  // backstop should a caller ever hand one in).
  if (isSimulatedNode(node)) return { kind: "not_found" }
  const [job] = await withPrivilegedDb(node.orgId, "nodes:job-load", (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, jobId), eq(nodeJobs.orgId, node.orgId)))
      .limit(1),
  )
  if (
    !job ||
    job.orgId !== node.orgId ||
    job.ownerUserId !== node.ownerUserId ||
    (job.targetNodeId !== null && job.targetNodeId !== node.id)
  ) {
    return { kind: "not_found" }
  }
  // A58: a follow branches before the protocol refusal and the run plan.
  if (job.kind === "follow") return claimFollowJob(node, job, opts)

  // D46, D47: a node older than this server's protocol cannot run the job;
  // it is refused in words (every claim, My node chat included). Like a
  // model this node does not offer, that is about this node: the job is
  // refused for good only when no other node of the owner can run it.
  if ((opts.protocol ?? 0) < NODE_PROTOCOL_MIN) {
    const plan = job.kind === "interactive" ? null : await planSessionRun(node, job)
    await refuseForNode(node, job, "node_outdated", NODE_OUTDATED_ERROR, plan?.modelInput ?? null)
    return { kind: "node_outdated" }
  }

  // Pre-checks first, outside the row lock: they read other tables and must
  // not hold the job while they do. These are about the job itself, so any
  // node would refuse it: refused for good (only while still claimable).
  if (!(await isMentionableAgent(job.orgId, job.ownerUserId, job.agentId))) {
    return refuseJob(job, "access", "The node owner can no longer run this agent.")
  }
  if (job.routineId) {
    const refusal = await routinePreCheck(job.orgId, job.routineId)
    if (refusal) return refuseJob(job, refusal.code, refusal.error)
  }
  if (opts.mcpConnectionId && !(await isJobConnection(node, job, opts.mcpConnectionId))) {
    return { kind: "bad_connection" }
  }
  const plan = job.kind === "interactive" ? null : await planSessionRun(node, job)
  if (plan && !plan.ok) {
    await refuseForNode(node, job, plan.code, plan.error, plan.modelInput)
    return { kind: "refused", code: plan.code, error: plan.error }
  }
  // Profiles live server side and are re-read on every claim (S22).
  const profile = await loadNodeProfile(job.orgId, job.ownerUserId, job.agentId)

  let claimed: NodeJobRow | null = null
  let conflict: "already_claimed" | "node_busy" | "not_claimable" | null = null
  let claimedSession: ClaimedSession | undefined
  let sessionChange: SessionChange | null = null
  let caps: { maxLive: number; maxBackground: number } = { ...NODE_SESSION_DEFAULT_CAPS }
  await withPrivilegedDb(node.orgId, "nodes:job-claim", async (tx) => {
    const [locked] = await tx
      .select()
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, jobId), eq(nodeJobs.orgId, node.orgId)))
      .for("update")
      .limit(1)
    if (!locked) {
      conflict = "not_claimable"
      return
    }
    const now = Date.now()
    const lapsedBeforeStart =
      locked.status === "running" &&
      locked.startedAt === null &&
      locked.leaseExpiresAt !== null &&
      locked.leaseExpiresAt.getTime() < now
    if (locked.status === "running" && !lapsedBeforeStart) {
      conflict = "already_claimed"
      return
    }
    if (!(locked.status === "queued" || locked.status === "offered" || lapsedBeforeStart)) {
      conflict = "not_claimable"
      return
    }
    // D35 (G8): up to the node's live cap, background runs (routine,
    // agent_tag) up to theirs; My node chat turns count as live (G9). The
    // node row is locked so two claims cannot both take the last slot.
    const [own] = await tx
      .select({ maxLive: nodes.maxLiveSessions, maxBackground: nodes.maxLiveBackground })
      .from(nodes)
      .where(and(eq(nodes.id, node.id), eq(nodes.orgId, node.orgId)))
      .for("update")
    caps = own ?? { ...NODE_SESSION_DEFAULT_CAPS }
    const [load] = await tx
      .select({
        live: sql<number>`count(*)::int`,
        background: sql<number>`count(*) FILTER (WHERE ${nodeJobs.source} IN ('routine', 'agent_tag'))::int`,
      })
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.orgId, node.orgId),
          eq(nodeJobs.leaseHolder, node.id),
          eq(nodeJobs.status, "running"),
          ne(nodeJobs.id, jobId),
          // A58: follows have their own count (claimFollowJob).
          ne(nodeJobs.kind, "follow"),
        ),
      )
    const background = locked.source === "routine" || locked.source === "agent_tag"
    if (
      (load?.live ?? 0) >= caps.maxLive ||
      (background && (load?.background ?? 0) >= caps.maxBackground)
    ) {
      conflict = "node_busy"
      return
    }
    const [row] = await tx
      .update(nodeJobs)
      .set({
        status: "running",
        nodeId: node.id,
        leaseHolder: node.id,
        leaseGeneration: sql`${nodeJobs.leaseGeneration} + 1`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${NODE_LEASE_SECONDS})`,
        claimedAt: new Date(),
        startedAt: null,
        resultGeneration: null,
        mcpConnectionId: null,
        // The protocol the claiming node speaks: what it can be sent (round 2).
        nodeProtocol: opts.protocol ?? null,
        updatedAt: new Date(),
      })
      // Compare-and-set as well as the row lock: the write itself only
      // lands on a job still claimable, so two claims can never both win.
      .where(and(eq(nodeJobs.id, jobId), eq(nodeJobs.orgId, node.orgId), claimableNow))
      .returning()
    if (!row) {
      conflict = "already_claimed"
      return
    }
    claimed = row
    if (plan?.ok) {
      const s = plan.session
      // A dispatch, a routine run and an agent_tag run start at the agent's
      // profile level, re-read now (D24); an app session keeps the level its
      // owner chose (and confirmed). A later run of a session that already
      // started (a resume) keeps the session's current level: only a
      // level_changed moves it, and it was confirmed when raised (P3-fix M3).
      const level = s.source === "app" || s.startedAt !== null ? s.level : profile.level
      // A62: a taken-over import's first resume replays what its follow did not reach.
      const catchUpFrom =
        row.resumeAfter && s.source === "import" && s.importReplayOffset !== null
          ? s.importReplayOffset
          : null
      await tx
        .update(nodeSessions)
        .set({
          nodeId: node.id,
          jobId: row.id,
          startedAt: s.startedAt ?? new Date(),
          lastBatchNo: 0,
          lastBatchHash: null,
          model: plan.model,
          level,
          folderPath: plan.folderPath,
          // A62: the first resume carries the replay's offset once, cleared here.
          ...(catchUpFrom !== null ? { importReplayOffset: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(nodeSessions.id, s.id), eq(nodeSessions.orgId, node.orgId)))
      sessionChange = await transitionJobSession(tx, row, "running", {
        from: ["queued", "paused"],
        cause: "node",
      })
      const confirmations = await claimConfirmations(tx, {
        orgId: node.orgId,
        ownerUserId: node.ownerUserId,
        nodeId: node.id,
        agentId: row.agentId,
        sessionId: s.id,
        profileLevel: profile.level,
        sessionLevel: level,
      })
      // S51 (D28): the owner confirmed sending to a session another Claude
      // Code drives; the node's driver check lets this run start.
      let confirmDrivenElsewhere = false
      if (row.resumeAfter === "message" && row.resumeCommandId) {
        const [cmd] = await tx
          .select({ payload: nodeSessionCommands.payload })
          .from(nodeSessionCommands)
          .where(
            and(
              eq(nodeSessionCommands.id, row.resumeCommandId),
              eq(nodeSessionCommands.sessionId, s.id),
            ),
          )
        confirmDrivenElsewhere =
          (cmd?.payload as { confirmDrivenElsewhere?: unknown } | undefined)
            ?.confirmDrivenElsewhere === true
      }
      // W2-D5: another in-place session of the owner in this folder on this
      // computer still holds its checkout (live, paused, or waiting on the
      // owner): the node never switches the folder's branch under it (D40).
      const folderHeldBy =
        s.configKind === "owner" && s.folderName
          ? await folderHolder(tx, node, s.id, s.folderName)
          : null
      claimedSession = {
        id: s.id,
        ...(folderHeldBy ? { folderHeldBy } : {}),
        folderPath: plan.folderPath,
        folderName: s.folderName,
        repo: plan.repo,
        model: plan.model,
        level,
        profileLevel: profile.level,
        effort: s.effort ?? null,
        autonomy: s.autonomy,
        finishWith: s.finishWith ?? null,
        ...(s.source === "import" && s.cwdSubdir ? { cwdSubdir: s.cwdSubdir } : {}),
        ...(s.source === "import" && s.worktreePath ? { worktreePath: s.worktreePath } : {}),
        configKind: s.configKind,
        liaisonTools: profile.liaisonTools,
        ...confirmations,
        ...(row.resumeAfter
          ? {
              resume: {
                sdkSessionId: s.sdkSessionId,
                after: row.resumeAfter,
                ...(row.resumeCommandId ? { commandId: row.resumeCommandId } : {}),
                ...(confirmDrivenElsewhere ? { confirmDrivenElsewhere: true } : {}),
                ...(catchUpFrom !== null ? { catchUpFrom } : {}),
              },
            }
          : {}),
      }
    }
  })
  if (conflict) return { kind: "conflict", reason: conflict }
  const row = claimed as NodeJobRow | null
  if (!row) return { kind: "conflict", reason: "not_claimable" }
  await fanOutAll([sessionChange])
  nodeTurnRunning(row, node.name || null)
  if (opts.mcpConnectionId) {
    if ((await bindNodeJobConnection(node, row.id, opts.mcpConnectionId)) === "bound") {
      row.mcpConnectionId = opts.mcpConnectionId
    }
  }
  // fix8 M2: a job tagged from the agent's window (no bound connection) opens
  // it, so a set missing at its result is a lost one, never "read nothing".
  await openConnectionTurnTaint(row.orgId, row.agentId)
  return {
    kind: "claimed",
    job: row,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt as Date,
    profile,
    ...(claimedSession ? { session: claimedSession } : {}),
    caps,
  }
}

// ── follow jobs (W3: S41, D28 b, A45, A53, A58) ─────────────────────────────

/** The follow parameters a follow job carries in its trigger (`{follow: …}`). */
const followTriggerSchema = z
  .object({
    startAt: z.enum(["window", "end"]),
    once: z.boolean(),
    inPlace: z.boolean(),
  })
  .strict()

/** A follow job's parameters; null when its trigger does not hold them. */
export function followParams(
  job: Pick<NodeJobRow, "trigger">,
): z.infer<typeof followTriggerSchema> | null {
  const raw = (job.trigger as { follow?: unknown } | null | undefined)?.follow
  const parsed = followTriggerSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const FOLLOW_INVALID_ERROR =
  "This session cannot be followed: its Claude Code session is not known."

/**
 * Claim a follow job (A45, A58): no model plan, no profile, no MCP connection
 * (a claim naming one is `bad_connection`). Only a node of the import
 * protocol may hold one; an older one is answered `node_outdated` and the job
 * stays waiting for a node that can (never refused for good). A node holds at
 * most `followsPerNode` follows, counted apart from its runs. The session
 * stays queued until the node says the follow started.
 */
async function claimFollowJob(
  node: NodeRow,
  job: NodeJobRow,
  opts: { mcpConnectionId?: string; protocol?: number },
): Promise<ClaimOutcome> {
  if ((opts.protocol ?? 0) < NODE_PROTOCOL_IMPORT) return { kind: "node_outdated" }
  if (!(await isMentionableAgent(job.orgId, job.ownerUserId, job.agentId))) {
    return refuseJob(job, "access", "The node owner can no longer run this agent.")
  }
  if (opts.mcpConnectionId) return { kind: "bad_connection" }
  const params = followParams(job)

  let conflict: "already_claimed" | "node_busy" | "not_claimable" | null = null
  let invalid = false
  let claimed: NodeJobRow | null = null
  let claimedSession: ClaimedSession | null = null
  let follow: NodeFollowClaim | null = null
  await withPrivilegedDb(node.orgId, "nodes:follow-claim", async (tx) => {
    const [locked] = await tx
      .select()
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, node.orgId)))
      .for("update")
      .limit(1)
    if (!locked) {
      conflict = "not_claimable"
      return
    }
    const lapsedBeforeStart =
      locked.status === "running" &&
      locked.startedAt === null &&
      locked.leaseExpiresAt !== null &&
      locked.leaseExpiresAt.getTime() < Date.now()
    if (locked.status === "running" && !lapsedBeforeStart) {
      conflict = "already_claimed"
      return
    }
    if (!(locked.status === "queued" || locked.status === "offered" || lapsedBeforeStart)) {
      conflict = "not_claimable"
      return
    }
    // The node row is locked so two follow claims cannot both take the last slot.
    await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, node.id), eq(nodes.orgId, node.orgId)))
      .for("update")
    const [load] = await tx
      .select({ follows: sql<number>`count(*)::int` })
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.orgId, node.orgId),
          eq(nodeJobs.leaseHolder, node.id),
          eq(nodeJobs.status, "running"),
          eq(nodeJobs.kind, "follow"),
          ne(nodeJobs.id, job.id),
        ),
      )
    if ((load?.follows ?? 0) >= NODE_IMPORT_LIMITS.followsPerNode) {
      conflict = "node_busy"
      return
    }
    const [session] = await tx
      .select()
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, node.orgId)))
      .for("update")
    if (!session) {
      conflict = "not_claimable"
      return
    }
    const parsed = params
      ? nodeFollowClaimSchema.safeParse({
          sdkSessionId: session.importSdkSessionId ?? session.sdkSessionId,
          folderName: session.folderName,
          cwdSubdir: session.cwdSubdir ?? "",
          ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
          ...params,
        })
      : null
    if (!parsed?.success) {
      invalid = true
      return
    }
    const [row] = await tx
      .update(nodeJobs)
      .set({
        status: "running",
        nodeId: node.id,
        leaseHolder: node.id,
        leaseGeneration: sql`${nodeJobs.leaseGeneration} + 1`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${NODE_LEASE_SECONDS})`,
        claimedAt: new Date(),
        startedAt: null,
        resultGeneration: null,
        mcpConnectionId: null,
        nodeProtocol: opts.protocol ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(nodeJobs.id, job.id), eq(nodeJobs.orgId, node.orgId), claimableNow))
      .returning()
    if (!row) {
      conflict = "already_claimed"
      return
    }
    await tx
      .update(nodeSessions)
      .set({
        nodeId: node.id,
        startedAt: session.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(nodeSessions.id, session.id), eq(nodeSessions.orgId, node.orgId)))
    claimed = row
    follow = parsed.data
    claimedSession = {
      id: session.id,
      folderPath: session.folderPath,
      folderName: session.folderName,
      repo: session.repo,
      model: session.model,
      level: session.level,
      profileLevel: session.level,
      effort: session.effort ?? null,
      autonomy: session.autonomy,
      finishWith: session.finishWith ?? null,
      configKind: session.configKind,
      liaisonTools: false,
    }
  })
  if (invalid) return refuseJob(job, "follow_invalid", FOLLOW_INVALID_ERROR)
  if (conflict) return { kind: "conflict", reason: conflict }
  const row = claimed as NodeJobRow | null
  if (!row || !claimedSession || !follow) return { kind: "conflict", reason: "not_claimable" }
  return {
    kind: "claimed_follow",
    job: row,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt as Date,
    session: claimedSession,
    follow,
  }
}

/**
 * The follow started (`/started`): its session is `running` and `following`
 * (A45). Fenced by the lease; only from `queued` (a repeat changes nothing).
 */
async function startFollowSession(node: NodeRow, jobId: string, generation: number) {
  const change = await withPrivilegedDb(node.orgId, "nodes:follow-start", async (tx) => {
    const [held] = await tx
      .select({ id: nodeJobs.id, orgId: nodeJobs.orgId })
      .from(nodeJobs)
      .where(heldBy(node, jobId, generation))
    if (!held) return null
    const [session] = await tx
      .select({ id: nodeSessions.id, status: nodeSessions.status })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, jobId), eq(nodeSessions.orgId, node.orgId)))
      .for("update")
    if (session?.status !== "queued") return null
    await tx
      .update(nodeSessions)
      .set({ following: true, updatedAt: new Date() })
      .where(and(eq(nodeSessions.id, session.id), eq(nodeSessions.orgId, node.orgId)))
    return transitionJobSession(tx, held, "running", { from: ["queued"], cause: "node" })
  })
  await fanOutAll([change])
}

/**
 * End the session of a follow job in the caller's transaction (A45, A53): it
 * stops `following`, an import keeps the byte offset the follow reached
 * (A62), and it goes `needs_you` with `reason` (`imported` after a Take
 * over's replay, else `follow_ended`), or `done` when the owner's Mark done
 * was what stopped it. Never a resume: the caller's `afterRunEnded` decides
 * that, and only for the cases A53 allows.
 */
async function endFollowSession(
  tx: PrivilegedDb,
  job: NodeJobRow,
  opts: {
    reason: "imported" | "follow_ended"
    cause: ChangeCause
    endOffset?: number
    commands: "applied" | "noop"
  },
): Promise<SessionChange | null> {
  const [session] = await tx
    .select({
      id: nodeSessions.id,
      source: nodeSessions.source,
      importMode: nodeSessions.importMode,
    })
    .from(nodeSessions)
    .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId)))
    .for("update")
  if (!session) return null
  // A44: a follow the owner took over ends ready to steer, as a Take over's replay does.
  const reason =
    session.source === "import" && session.importMode === "take_over" ? "imported" : opts.reason
  await tx
    .update(nodeSessions)
    .set({
      following: false,
      ...(session.source === "import" && opts.endOffset !== undefined
        ? { importReplayOffset: opts.endOffset }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(nodeSessions.id, session.id), eq(nodeSessions.orgId, job.orgId)))
  const marked = await ownerMarkDone(tx, job)
  const change = marked
    ? await endMarkedDone(tx, job, marked)
    : await transitionJobSession(tx, job, "needs_you", {
        from: LIVE_SESSION_STATUSES,
        reason,
        cause: opts.cause,
      })
  return settleEndingCommands(tx, job, marked ? "applied" : opts.commands, change)
}

/**
 * A follow job's result (`/result` with `follow`): the job is done and its
 * session ends (`endFollowSession`): `imported` when it was a Take over's
 * replay (`once`), else `follow_ended`; cause `owner` when the owner's Stop
 * ended it, else `follow` (no notice, no post-back). Then `afterRunEnded`.
 */
export async function completeFollowJob(
  job: NodeJobRow,
  generation: number,
  result: NodeFollowResult,
): Promise<void> {
  const once = followParams(job)?.once === true
  const byOwner = result.why === "owner"
  const out = await withPrivilegedDb(job.orgId, "nodes:follow-complete", async (tx) => {
    const completed = await tx
      .update(nodeJobs)
      .set({
        status: "done",
        resultMessageId: null,
        resultRequiredScopes: job.sourceRequiredScopes,
        leaseHolder: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.id, job.id),
          eq(nodeJobs.orgId, job.orgId),
          eq(nodeJobs.resultGeneration, generation),
        ),
      )
      .returning({ id: nodeJobs.id })
    if (completed.length === 0) return null
    return {
      change: await endFollowSession(tx, job, {
        reason: once ? "imported" : "follow_ended",
        cause: byOwner ? "owner" : "follow",
        ...(result.endOffset !== undefined ? { endOffset: result.endOffset } : {}),
        commands: byOwner ? "applied" : "noop",
      }),
    }
  })
  if (!out) return
  await fanOutAll([out.change])
  await afterRunEnded(job)
}

/**
 * D28 (b): an in-place owner session whose run a protocol-5 node refused
 * because another Claude Code drives it (`driven_elsewhere*`) gets one
 * read-only follow from the transcript's end, on the same node. Null when
 * nothing was created: not such a session, an older node, or the session
 * already moved on (a follow or a resume holds it: the attach re-checks
 * `needs_you` under the session's lock).
 */
export async function followInPlaceAfterResult(
  job: NodeJobRow,
  reasonCode: string | undefined,
): Promise<NodeJobRow | null> {
  if (!reasonCode?.startsWith("driven_elsewhere")) return null
  if (job.kind === "follow" || !job.nodeId) return null
  if ((job.nodeProtocol ?? 0) < NODE_PROTOCOL_IMPORT) return null
  const [session] = await withPrivilegedDb(job.orgId, "nodes:follow-in-place", (tx) =>
    tx
      .select()
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId)))
      .limit(1),
  )
  const inPlace =
    session &&
    session.source !== "import" &&
    session.configKind === "owner" &&
    !!session.folderName &&
    !session.repo
  if (!session || !inPlace || session.status !== "needs_you" || !session.sdkSessionId) return null
  try {
    return await createNodeJob({
      orgId: job.orgId,
      ownerUserId: job.ownerUserId,
      agentId: session.agentId,
      threadId: job.threadId,
      source: job.source,
      sourceRef: job.sourceRef,
      kind: "follow",
      prompt: session.prompt,
      trigger: { follow: { startAt: "end", once: false, inPlace: true } },
      sourceRequiredScopes: (job.sourceRequiredScopes as string[] | null) ?? [],
      tokenBudget: job.tokenBudget,
      hardTokenLimit: job.hardTokenLimit,
      targetNodeId: job.nodeId,
      requesterUserId: job.requesterUserId,
      requesterAgentId: job.requesterAgentId,
      replyThreadId: job.replyThreadId,
      replyMessageId: job.replyMessageId,
      resume: { sessionId: session.id, from: ["needs_you"], after: null },
    })
  } catch (err) {
    if (err instanceof SessionNotResumableError) return null
    throw err
  }
}

const RESULT_SUMMARY_MAX = 300

// ── fenced signals ──────────────────────────────────────────────────────────

/** The fence every node signal passes: this node holds this generation of a running job. */
export function heldBy(node: NodeRow, jobId: string, generation: number) {
  return and(
    eq(nodeJobs.id, jobId),
    eq(nodeJobs.orgId, node.orgId),
    eq(nodeJobs.status, "running"),
    eq(nodeJobs.leaseHolder, node.id),
    eq(nodeJobs.leaseGeneration, generation),
  )
}

/** Heartbeat (every 30 s): extend the lease. Null when the generation is stale. */
export async function heartbeatNodeJob(
  node: NodeRow,
  jobId: string,
  generation: number,
  opts: { started?: boolean } = {},
): Promise<{ leaseExpiresAt: Date } | null> {
  const [row] = await withPrivilegedDb(node.orgId, "nodes:job-heartbeat", (tx) =>
    tx
      .update(nodeJobs)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${NODE_LEASE_SECONDS})`,
        ...(opts.started ? { startedAt: sql`coalesce(${nodeJobs.startedAt}, now())` } : {}),
        updatedAt: new Date(),
      })
      .where(heldBy(node, jobId, generation))
      .returning({
        id: nodeJobs.id,
        orgId: nodeJobs.orgId,
        ownerUserId: nodeJobs.ownerUserId,
        threadId: nodeJobs.threadId,
        leaseExpiresAt: nodeJobs.leaseExpiresAt,
        agentId: nodeJobs.agentId,
        kind: nodeJobs.kind,
      }),
  )
  // A node chat turn waiting on its owner is still running: its live snapshot stays.
  if (row) nodeTurnAlive(row)
  if (row && opts.started) {
    // A45: a follow's start is its session's; it opens no connection taint.
    if (row.kind === "follow") await startFollowSession(node, jobId, generation)
    else await openConnectionTurnTaint(node.orgId, row.agentId)
  }
  // P3-fix M5: the run is heard from again; a silent pause ends.
  if (row) await unpauseHeldSession(node, jobId, generation)
  return row?.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : null
}

/** The codes a node may fail a job with; `level_unconfirmed` is a refusal (A21, D24). */
export const NODE_FAIL_CODES = [
  "error",
  "auth_required",
  "auth_expired",
  "sandbox_unavailable",
  "token_limit",
  "aborted",
  // The repository's own Claude settings are not allowed at the job's
  // guardrail level: the job never started (fix8, walk N15).
  "repo_settings_unsafe",
  // P1 sessions (R9): the requested model is not offered, the shared folder
  // is gone, a level above the node's pin came without a confirmation, the
  // worktree or clone could not be made, the run hit its time limit, a
  // settings layer the level refuses, a node older than the server.
  "model_unavailable",
  "folder_missing",
  "level_unconfirmed",
  "worktree_failed",
  "timeout",
  "settings_refused",
  "node_outdated",
  // P3 (G7): the owner's Stop ended the run; the job is cancelled, its
  // session stopped.
  "stopped",
  // W3 (A44): an import's recorded cwd is not a folder inside its shared
  // folder any more (a symlink out, removed): the run never started.
  "unsafe_subdir",
  // B2-3 (D52): the job names an SDK session this node ran for another
  // server (a resume, a Take over and its catch-up): the run never started.
  "already_liaison",
] as const
export type NodeFailCode = (typeof NODE_FAIL_CODES)[number]

/** Codes that mean the job never ran by the node's rule: the job is `refused` (A21). */
const NODE_REFUSAL_CODES = new Set<NodeFailCode>([
  "repo_settings_unsafe",
  "settings_refused",
  "level_unconfirmed",
  "node_outdated",
  "unsafe_subdir",
  "already_liaison",
])

/** The job status a node failure with this code leaves; its session is `failed`, or `stopped` for a Stop. */
export function nodeFailStatus(code: NodeFailCode): "refused" | "failed" | "cancelled" {
  if (code === "stopped") return "cancelled"
  return NODE_REFUSAL_CODES.has(code) ? "refused" : "failed"
}

export async function failNodeJob(
  node: NodeRow,
  jobId: string,
  generation: number,
  failure: { error: string; code: NodeFailCode; refusals?: unknown[]; usage?: unknown },
): Promise<boolean> {
  const status = nodeFailStatus(failure.code)
  const changes: SessionChange[] = []
  const rows = await withPrivilegedDb(node.orgId, "nodes:job-fail", async (tx) => {
    const failed = await tx
      .update(nodeJobs)
      .set({
        status,
        error: failure.error,
        errorCode: failure.code,
        ...(failure.refusals ? { refusals: failure.refusals } : {}),
        ...(failure.usage !== undefined ? { usage: failure.usage } : {}),
        leaseHolder: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(heldBy(node, jobId, generation))
      .returning()
    for (const r of failed) {
      // A45, A53: a follow that failed (its host exited, its lease was lost)
      // ends `follow_ended`; never `failed`, never a resume of its own.
      if (r.kind === "follow") {
        const stopped = failure.code === "stopped"
        const ended = await endFollowSession(tx, r, {
          reason: "follow_ended",
          cause: stopped ? "owner" : "follow",
          commands: stopped ? "applied" : "noop",
        })
        if (ended) changes.push(ended)
        continue
      }
      // S7: a run the node stopped for the owner's Mark done ends `done`.
      const marked = failure.code === "stopped" ? await ownerMarkDone(tx, r) : null
      const change = marked
        ? await endMarkedDone(tx, r, marked)
        : failure.code === "stopped"
          ? await transitionJobSession(tx, r, "stopped", {
              from: LIVE_SESSION_STATUSES,
              reason: "stopped_by_owner",
              cause: "owner",
            })
          : await transitionJobSession(tx, r, "failed", {
              from: LIVE_SESSION_STATUSES,
              error: failure.error,
              code: failure.code,
              cause: "node",
            })
      // F1: what this run never carried out ends with it (a Stop the run's
      // own stop carried out is applied).
      const settled = await settleEndingCommands(
        tx,
        r,
        failure.code === "stopped" ? "applied" : "noop",
        change,
      )
      if (settled) changes.push(settled)
    }
    return failed
  })
  await fanOutAll(changes)
  for (const r of rows) {
    nodeTurnEnded(r, "ended")
    await releaseJobConnection(r)
    await settleRoutineRunForJob(r, { ok: false, error: failure.error })
    await afterRunEnded(r)
  }
  return rows.length > 0
}

/** The owner's Mark done a stopped run carried out (S7). */
interface MarkedDone {
  commandId: string
  acked: boolean
  summary: string | null
}

/**
 * The latest `mark_done` command of this job's session that this run carries:
 * delivered to it (`job_id` = the job, acked or not) or still unacked and
 * undelivered (sent while the run was the session's current one). Null when
 * the owner sent none: the stop is a plain Stop.
 */
async function ownerMarkDone(
  tx: PrivilegedDb,
  job: Pick<NodeJobRow, "id" | "orgId">,
): Promise<MarkedDone | null> {
  const [cmd] = await tx
    .select({
      id: nodeSessionCommands.id,
      ackedAt: nodeSessionCommands.ackedAt,
      payload: nodeSessionCommands.payload,
    })
    .from(nodeSessionCommands)
    .innerJoin(nodeSessions, eq(nodeSessions.id, nodeSessionCommands.sessionId))
    .where(
      and(
        eq(nodeSessions.jobId, job.id),
        eq(nodeSessions.orgId, job.orgId),
        eq(nodeSessionCommands.type, "mark_done"),
        or(
          eq(nodeSessionCommands.jobId, job.id),
          and(isNull(nodeSessionCommands.jobId), isNull(nodeSessionCommands.ackedAt)),
        ),
      ),
    )
    .orderBy(desc(nodeSessionCommands.seq))
    .limit(1)
  if (!cmd) return null
  const summary = typeof cmd.payload.summary === "string" ? cmd.payload.summary.trim() : ""
  return { commandId: cmd.id, acked: cmd.ackedAt !== null, summary: summary || null }
}

/**
 * End a job's session `done` for the owner's Mark done (S7): its status event
 * says so, the command is acked `applied` when the node had not, and its
 * summary, when it has one, becomes the session's.
 */
async function endMarkedDone(
  tx: PrivilegedDb,
  job: Pick<NodeJobRow, "id" | "orgId">,
  marked: MarkedDone,
): Promise<SessionChange | null> {
  const ended = await transitionJobSession(tx, job, "done", {
    from: LIVE_SESSION_STATUSES,
    reason: "marked_done_by_owner",
    cause: "owner",
  })
  if (!ended) return null
  let events = ended.events
  if (!marked.acked) {
    await tx
      .update(nodeSessionCommands)
      .set({ ackedAt: new Date(), outcome: "applied", jobId: job.id })
      .where(and(eq(nodeSessionCommands.id, marked.commandId), isNull(nodeSessionCommands.ackedAt)))
    const applied = await appendServerEvents(tx, job.orgId, ended.row.id, [
      {
        at: new Date().toISOString(),
        type: "command_applied",
        payload: { commandId: marked.commandId, type: "mark_done", outcome: "applied" },
      },
    ])
    if (applied) events = [...events, ...applied.events]
  }
  const [row] = await tx
    .update(nodeSessions)
    .set({
      ...(marked.summary
        ? { resultSummary: Array.from(marked.summary).slice(0, RESULT_SUMMARY_MAX).join("") }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(nodeSessions.id, ended.row.id), eq(nodeSessions.orgId, job.orgId)))
    .returning()
  return { ...ended, row, events }
}

/**
 * F1: no Stop or Mark done outlives the run it was sent to. At the run's end,
 * every one of this run's (delivered to it, or unacked and undelivered) still
 * unacked is acked `outcome` with its `command_applied` event, so a resume
 * run never receives it. The events are added to `change` when it is this
 * session's; otherwise they are returned as their own change.
 */
async function settleEndingCommands(
  tx: PrivilegedDb,
  job: Pick<NodeJobRow, "id" | "orgId">,
  outcome: "applied" | "noop",
  change: SessionChange | null,
): Promise<SessionChange | null> {
  const pending = await tx
    .select({
      id: nodeSessionCommands.id,
      type: nodeSessionCommands.type,
      sessionId: nodeSessionCommands.sessionId,
    })
    .from(nodeSessionCommands)
    .innerJoin(nodeSessions, eq(nodeSessions.id, nodeSessionCommands.sessionId))
    .where(
      and(
        eq(nodeSessions.jobId, job.id),
        eq(nodeSessions.orgId, job.orgId),
        inArray(nodeSessionCommands.type, ["stop", "mark_done"]),
        isNull(nodeSessionCommands.ackedAt),
        or(eq(nodeSessionCommands.jobId, job.id), isNull(nodeSessionCommands.jobId)),
      ),
    )
    .orderBy(asc(nodeSessionCommands.seq))
  if (pending.length === 0) return change
  const sessionId = pending[0].sessionId
  await tx
    .update(nodeSessionCommands)
    .set({ ackedAt: new Date(), outcome, jobId: job.id })
    .where(
      and(
        inArray(
          nodeSessionCommands.id,
          pending.map((c) => c.id),
        ),
        isNull(nodeSessionCommands.ackedAt),
      ),
    )
  const applied = await appendServerEvents(
    tx,
    job.orgId,
    sessionId,
    pending.map((c) => ({
      at: new Date().toISOString(),
      type: "command_applied" as const,
      payload: { commandId: c.id, type: c.type, outcome },
    })),
  )
  if (!applied) return change
  if (change && change.row.id === sessionId) {
    return { ...change, row: applied.row, events: [...change.events, ...applied.events] }
  }
  return change ?? { row: applied.row, events: applied.events }
}

// ── result bookkeeping (the route persists the turn) ────────────────────────

export type ResultReservation =
  | { kind: "reserved"; job: NodeJobRow }
  /** `messageId` null: a dispatch or app result, which posts no message (P1-T18). */
  | { kind: "replay"; messageId: string | null }
  | { kind: "stale" }

/**
 * Take the right to write this generation's result, once (A20). A repeat of a
 * result already written answers its message id (null for a result that
 * posted none and completed the job); any other generation, a job no longer
 * running, or another node gets `stale`.
 */
export async function reserveNodeJobResult(
  node: NodeRow,
  jobId: string,
  generation: number,
): Promise<ResultReservation> {
  return withPrivilegedDb(node.orgId, "nodes:job-result-reserve", async (tx) => {
    const [row] = await tx
      .update(nodeJobs)
      .set({ resultGeneration: generation, updatedAt: new Date() })
      .where(and(heldBy(node, jobId, generation), isNull(nodeJobs.resultGeneration)))
      .returning()
    if (row) return { kind: "reserved", job: row }
    const [current] = await tx
      .select()
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, jobId), eq(nodeJobs.orgId, node.orgId)))
      .limit(1)
    if (current && current.nodeId === node.id && current.resultGeneration === generation) {
      if (current.resultMessageId) return { kind: "replay", messageId: current.resultMessageId }
      // A result that posts no message is written once the job is done.
      if (current.status === "done") return { kind: "replay", messageId: null }
    }
    return { kind: "stale" }
  })
}

/** Give back a reservation whose write failed, so the node may retry it. */
export async function releaseNodeJobResult(job: NodeJobRow, generation: number): Promise<void> {
  await withPrivilegedDb(job.orgId, "nodes:job-result-release", (tx) =>
    tx
      .update(nodeJobs)
      .set({ resultGeneration: null, updatedAt: new Date() })
      .where(
        and(
          eq(nodeJobs.id, job.id),
          eq(nodeJobs.orgId, job.orgId),
          eq(nodeJobs.resultGeneration, generation),
          isNull(nodeJobs.resultMessageId),
          // A result that posted no message is written once the job is done.
          ne(nodeJobs.status, "done"),
        ),
      ),
  )
}

export async function completeNodeJob(
  job: NodeJobRow,
  generation: number,
  done: {
    /** The posted message; null or absent for a dispatch or app result (P1-T18). */
    messageId?: string | null
    requiredScopes: string[]
    refusals: unknown[]
    usage: unknown
    /** The result text: the session's summary when no `result` event gave one. */
    text?: string
    /** The run's completion signal, as the node latched it (S1, S2). */
    completion?: NodeSessionCompletion
    /** The run ended at its hard token limit (S4). */
    endedBy?: "token_limit"
    /** A routine's or agent_tag's posted answer is its deliverable: done (S3). */
    alwaysDone?: boolean
    /** The node wrote a final message: a routine run reports it (routine-report.ts). */
    reported?: boolean
  },
): Promise<void> {
  // D1, S1-S4, S10: done only on a completion signal (never from the text);
  // a run that ended without one needs its person.
  const completion = done.completion
  const to: NodeSessionStatus =
    done.alwaysDone || (completion && completion.by !== "needs_you") ? "done" : "needs_you"
  // S32: a reason code (stuck, the cap, Atelier awaiting, no PR) is the status
  // event's reason, which the row folds into its reason_code (store.ts).
  const reason =
    to === "done"
      ? undefined
      : (completion?.reasonCode ??
        completion?.reason ??
        (done.endedBy === "token_limit" ? "token_limit" : "turn_ended"))
  // S57: the pull request the run opened (the schema admits https only).
  const prUrl = isPrUrl(completion?.prUrl) ? completion.prUrl : undefined
  // A2/A3: the completion's own words win over the run's last text.
  const signalled = (completion?.summary ?? completion?.reason)?.trim()
  const change = await withPrivilegedDb(job.orgId, "nodes:job-complete", async (tx) => {
    const completed = await tx
      .update(nodeJobs)
      .set({
        status: "done",
        resultMessageId: done.messageId ?? null,
        resultRequiredScopes: done.requiredScopes,
        refusals: done.refusals,
        usage: done.usage ?? null,
        leaseHolder: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.id, job.id),
          eq(nodeJobs.orgId, job.orgId),
          eq(nodeJobs.resultGeneration, generation),
        ),
      )
      .returning({ id: nodeJobs.id })
    if (completed.length === 0) return null
    // F1: the owner's Mark done the run ended before carrying out still
    // decides: the session ends `done` by the owner, with its summary.
    const marked = await ownerMarkDone(tx, job)
    const ended = marked
      ? await endMarkedDone(tx, job, marked)
      : await transitionJobSession(tx, job, to, {
          from: LIVE_SESSION_STATUSES,
          ...(reason ? { reason } : {}),
          cause: "node",
        })
    if (!ended) return settleEndingCommands(tx, job, "noop", ended)
    const summary = marked?.summary
      ? ""
      : signalled || (ended.row.resultSummary === null ? done.text?.trim() : "")
    if (!summary && !prUrl) return settleEndingCommands(tx, job, "noop", ended)
    const [row] = await tx
      .update(nodeSessions)
      .set({
        ...(summary
          ? { resultSummary: Array.from(summary).slice(0, RESULT_SUMMARY_MAX).join("") }
          : {}),
        ...(prUrl ? { prUrl } : {}),
      })
      .where(and(eq(nodeSessions.id, ended.row.id), eq(nodeSessions.orgId, job.orgId)))
      .returning()
    return settleEndingCommands(tx, job, "noop", { ...ended, row })
  })
  await fanOutAll([change])
  nodeTurnEnded(job, "answered")
  // The result carries its scopes now (result_required_scopes): the live set is done.
  await releaseJobConnection(job)
  await clearNodeJobTaint(job.id)
  await settleRoutineRunForJob(job, { ok: true, reported: done.reported === true })
  if (change) await afterRunEnded(job)
}

// ── lease expiry, owner decisions ───────────────────────────────────────────

async function notifyInterrupted(job: {
  id: string
  orgId: string
  ownerUserId: string
  agentId: string
  threadId: string | null
}): Promise<void> {
  try {
    await withPrivilegedDb(job.orgId, "nodes:job-interrupted-notify", async (tx) => {
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary: "A job on your computer stopped before it finished: re-run it or discard it.",
          urgency: 60,
          targetUserIds: [job.ownerUserId],
          link: job.threadId
            ? { tabType: "thread", entityId: job.threadId }
            : { tabType: "sessions" },
          nodeJobId: job.id,
          actions: ["rerun", "discard"],
        },
        actorId: job.ownerUserId,
        actorType: "system",
        agentId: job.agentId,
        orgId: job.orgId,
        timestamp: new Date().toISOString(),
      })
    })
  } catch (err) {
    log.error({ err, jobId: job.id }, "node job interrupted notification failed")
  }
}

/** One job's session transition in its own transaction (the sweep and owner actions). */
async function settleJobSession(
  job: Pick<NodeJobRow, "id" | "orgId">,
  to: NodeSessionStatus,
  opts: Parameters<typeof transitionJobSession>[3],
): Promise<void> {
  try {
    const change = await withPrivilegedDb(job.orgId, "nodes:job-session-settle", (tx) =>
      transitionJobSession(tx, job, to, opts),
    )
    await fanOutAll([change])
  } catch (err) {
    log.error({ err, jobId: job.id, to }, "settling a node job's session failed")
  }
}

/**
 * The lease-expiry sweep (every minute, F7): a lease that ran out before the
 * run started puts the job back in the queue and offers it again; one that ran
 * out after it marks the job `interrupted` and asks the owner (A20). A routine
 * run its ended job left `dispatched` is settled (P6-postto). Then the stale
 * connected intervals are closed (F12).
 */
export async function sweepNodeLeases(): Promise<{
  requeued: number
  interrupted: number
  settledRuns: number
  staleSessions: number
}> {
  const requeued = await withSystemDb("nodes:lease-sweep-requeue", (db) =>
    db
      .update(nodeJobs)
      .set({
        status: "queued",
        nodeId: null,
        leaseHolder: null,
        leaseExpiresAt: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.status, "running"),
          lt(nodeJobs.leaseExpiresAt, sql`now()`),
          isNull(nodeJobs.startedAt),
          notOnSimulatedNode,
        ),
      )
      .returning(),
  )
  for (const job of requeued) {
    nodeTurnRequeued(job)
    await releaseJobConnection(job)
    await settleJobSession(job, "queued", { from: ["running", "waiting", "paused"] })
    if (!job.backlog) await offerJob(job).catch(() => 0)
  }
  const interrupted = await withSystemDb("nodes:lease-sweep-interrupt", (db) =>
    db
      .update(nodeJobs)
      .set({
        status: "interrupted",
        leaseHolder: null,
        leaseExpiresAt: null,
        errorCode: "lease_expired",
        error: "The computer stopped answering while the job was running.",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.status, "running"),
          lt(nodeJobs.leaseExpiresAt, sql`now()`),
          sql`${nodeJobs.startedAt} IS NOT NULL`,
          // A session's run is paused, never interrupted, by a lapse (G5):
          // lifecycle.ts sweeps those.
          sql`NOT EXISTS (SELECT 1 FROM ${K()}.node_sessions s WHERE s.job_id = ${nodeJobs.id})`,
          notOnSimulatedNode,
        ),
      )
      .returning(),
  )
  try {
    await sweepSessionLeases()
  } catch (err) {
    log.warn({ err }, "session lease sweep failed")
  }
  for (const job of interrupted) {
    nodeTurnEnded(job, "ended")
    await releaseJobConnection(job)
    // P1 mapping: an interrupted run fails its session (L4 resumes it in P3).
    await settleJobSession(job, "failed", {
      from: LIVE_SESSION_STATUSES,
      error: job.error ?? "The computer stopped answering while the job was running.",
      code: "lease_expired",
    })
    await notifyInterrupted(job)
  }
  let settledRuns = 0
  try {
    settledRuns = await settleOrphanedRoutineRuns()
  } catch (err) {
    log.warn({ err }, "orphaned routine run sweep failed")
  }
  let staleSessions = 0
  try {
    staleSessions = await sweepStaleNodeSessions()
  } catch (err) {
    log.warn({ err }, "stale node session sweep failed")
  }
  return {
    requeued: requeued.length,
    interrupted: interrupted.length,
    settledRuns,
    staleSessions,
  }
}

/** A job in one of these will not run again on its own. `interrupted` waits on
 *  the owner's re-run or discard, but the run it carried has ended. */
const ENDED_JOB_STATUSES = new Set(["done", "failed", "refused", "cancelled", "interrupted"])
/** How long after its job ended a run may still be settled by the job's own
 *  finish step before the sweep does it (the two are idempotent, but a settle
 *  the finish step is about to make should not be made twice). */
const ORPHAN_JOB_GRACE_MS = 2 * 60_000
/** How old a dispatched run must be before a missing job means it never will
 *  have one: the run row is written just before its job, in another commit. */
const ORPHAN_RUN_MIN_AGE = sql`now() - interval '5 minutes'`

/**
 * A `dispatched` routine run whose node job has ended, or no longer exists,
 * is settled here as the job's finish step would have settled it (P6-postto).
 * That step settles the run in its own transaction after the job's; when it
 * failed (demo run 1410efac, a rolled-back settle) nothing looked at the run
 * again and the Routines page read "dispatched" for good. Same outcome, same
 * `run_completed` and status events as a normal finish.
 */
async function settleOrphanedRoutineRuns(): Promise<number> {
  const rows = await withSystemDb("nodes:lease-sweep-orphan-runs", (db) =>
    db
      .select({
        runId: routineRuns.id,
        orgId: routineRuns.orgId,
        routineId: routineRuns.routineId,
        ranAt: routineRuns.ranAt,
        ownerUserId: routines.ownerUserId,
        jobStatus: nodeJobs.status,
        jobError: nodeJobs.error,
        jobCreatedAt: nodeJobs.createdAt,
        jobFinishedAt: nodeJobs.finishedAt,
        jobUpdatedAt: nodeJobs.updatedAt,
      })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .leftJoin(
        nodeJobs,
        and(
          eq(nodeJobs.sourceRef, sql`${routineRuns.id}::text`),
          eq(nodeJobs.orgId, routineRuns.orgId),
        ),
      )
      .where(and(eq(routineRuns.status, "dispatched"), lt(routineRuns.ranAt, ORPHAN_RUN_MIN_AGE)))
      .orderBy(asc(routineRuns.ranAt))
      .limit(500),
  )
  // One run can carry several jobs over time (a re-run reuses the row, a
  // coalesce replaces it): any job still going means the run is not orphaned.
  const byRun = new Map<string, typeof rows>()
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row])
  const cutoff = Date.now() - ORPHAN_JOB_GRACE_MS
  let settled = 0
  for (const [runId, jobs] of byRun) {
    const first = jobs[0]!
    const withJob = jobs.filter((j) => j.jobStatus !== null)
    if (withJob.some((j) => !ENDED_JOB_STATUSES.has(j.jobStatus!))) continue
    const latest = withJob.sort(
      (a, b) => (b.jobCreatedAt?.getTime() ?? 0) - (a.jobCreatedAt?.getTime() ?? 0),
    )[0]
    if (latest && (latest.jobFinishedAt ?? latest.jobUpdatedAt ?? new Date()).getTime() > cutoff) {
      continue
    }
    const outcome: { ok: true } | { ok: false; error: string } = !latest
      ? { ok: false, error: "The job that carried this run no longer exists." }
      : latest.jobStatus === "done"
        ? { ok: true }
        : { ok: false, error: latest.jobError ?? endedJobReason(latest.jobStatus!) }
    await settleRoutineRunForJob(
      {
        orgId: first.orgId,
        routineId: first.routineId,
        sourceRef: runId,
        ownerUserId: first.ownerUserId,
        createdAt: latest?.jobCreatedAt ?? first.ranAt,
        finishedAt: latest?.jobFinishedAt ?? latest?.jobUpdatedAt ?? null,
      },
      outcome,
    )
    settled += 1
  }
  return settled
}

function endedJobReason(status: string): string {
  if (status === "cancelled") return "Discarded."
  if (status === "interrupted") return "The job on your computer stopped before it finished."
  if (status === "refused") return "The computer refused the job."
  return "The job on your computer failed."
}

export type OwnerDecision = "ok" | "not_found" | "wrong_state" | "use_session_commands"

/**
 * A session's run is steered through the session (L4): Resume is a message,
 * Cancel is a Stop. A job is a session's when a session names it, when it is
 * a dispatch or app job, or when it resumed one.
 */
async function isSessionRun(job: NodeJobRow): Promise<boolean> {
  if (job.kind === "interactive") return false
  if (job.source === "dispatch" || job.source === "app" || job.resumeAfter) return true
  const [s] = await withPrivilegedDb(job.orgId, "nodes:job-session-of", (tx) =>
    tx
      .select({ id: nodeSessions.id })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.jobId, job.id), eq(nodeSessions.orgId, job.orgId)))
      .limit(1),
  )
  return !!s
}

/** Re-run (A20): an interrupted or failed job goes back in the queue, offered if a node is live. */
export async function rerunNodeJob(
  orgId: string,
  ownerUserId: string,
  jobId: string,
): Promise<OwnerDecision> {
  const owned = await ownedJob(orgId, ownerUserId, jobId)
  if (!owned) return "not_found"
  if (await isSessionRun(owned)) return "use_session_commands"
  const targets = await liveNodeTargets(orgId, ownerUserId, owned.targetNodeId)
  const [row] = await withPrivilegedDb(orgId, "nodes:job-rerun", async (tx) => {
    const rows = await tx
      .update(nodeJobs)
      .set({
        status: "queued",
        nodeId: null,
        leaseHolder: null,
        leaseExpiresAt: null,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        errorCode: null,
        resultGeneration: null,
        backlog: targets.length === 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.id, jobId),
          eq(nodeJobs.orgId, orgId),
          inArray(nodeJobs.status, ["interrupted", "failed", "refused"]),
        ),
      )
      .returning()
    // fix8 M1: the run this job carried was settled `failed` when the job
    // ended (its finish step or the lease sweep). A re-run reopens it, in the
    // same transaction, so the job's next finish settles it again: without
    // this the run stayed `failed` while the routine's last run said succeeded.
    const job = rows[0]
    if (job?.routineId && job.sourceRef) {
      await tx
        .update(routineRuns)
        .set({ status: "dispatched", error: null })
        .where(
          and(
            eq(routineRuns.id, job.sourceRef),
            eq(routineRuns.orgId, orgId),
            eq(routineRuns.routineId, job.routineId),
          ),
        )
    }
    return rows
  })
  if (!row) return "wrong_state"
  // The run is retried: its session waits again.
  await settleJobSession(row, "queued", { from: ["failed", "running", "waiting", "paused"] })
  if (targets.length > 0) {
    nodeTurnQueued(row)
    await offerJob(row, targets)
  }
  return "ok"
}

/** Discard: a job that has not finished is cancelled. */
export async function discardNodeJob(
  orgId: string,
  ownerUserId: string,
  jobId: string,
): Promise<OwnerDecision> {
  const owned = await ownedJob(orgId, ownerUserId, jobId)
  if (!owned) return "not_found"
  if (await isSessionRun(owned)) return "use_session_commands"
  const rows = await withPrivilegedDb(orgId, "nodes:job-discard", (tx) =>
    tx
      .update(nodeJobs)
      .set({
        status: "cancelled",
        errorCode: "discarded",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeJobs.id, jobId),
          eq(nodeJobs.orgId, orgId),
          inArray(nodeJobs.status, ["queued", "offered", "interrupted", "failed"]),
        ),
      )
      .returning(),
  )
  for (const r of rows) {
    nodeTurnEnded(r, "ended")
    // A discard before the run started stops its session; one after a failed
    // or interrupted run leaves the session failed.
    await settleJobSession(r, "stopped", { from: ["queued"], reason: "discarded" })
    await settleRoutineRunForJob(r, { ok: false, error: "Discarded." })
  }
  return rows.length > 0 ? "ok" : "wrong_state"
}

async function ownedJob(
  orgId: string,
  ownerUserId: string,
  jobId: string,
): Promise<NodeJobRow | null> {
  const [row] = await withPrivilegedDb(orgId, "nodes:job-owned", (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.id, jobId),
          eq(nodeJobs.orgId, orgId),
          eq(nodeJobs.ownerUserId, ownerUserId),
        ),
      )
      .limit(1),
  )
  return row ?? null
}
