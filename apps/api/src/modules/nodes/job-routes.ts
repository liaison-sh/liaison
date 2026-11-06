// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Node jobs and profiles API (S20, S22, S23, A19-A21, A23, F7), under
 * /api/nodes, on the owner's session.
 *
 * Node calls (also `X-Node-Credential`; fenced by `leaseGeneration`):
 *   POST /jobs/:id/claim       {mcpConnectionId?} -> job, leaseGeneration, 120 s lease,
 *                              profile (level, Liaison tools; the connection carries the job's taint),
 *                              session (P1: folder path on this node, model, level, confirmations);
 *                              header X-Liaison-Node-Protocol: 2, else 409 node_outdated (D46)
 *   POST /jobs/:id/connection  {leaseGeneration, mcpConnectionId}: bind it after the claim
 *   POST /jobs/:id/heartbeat   extend the lease (409: stale generation, abort)
 *   POST /jobs/:id/started     the run began (a later lapse is `interrupted`)
 *   POST /jobs/:id/result      the reply, refusals, usage (idempotent per generation);
 *                              a dispatch or app result is its session's, never a message (S11)
 *   POST /jobs/:id/fail        {error, code}
 *
 * Owner calls:
 *   GET    /me/jobs?status=&backlog=1   the queue, oldest first (backlog: created while no node was live)
 *   GET    /jobs/:id                    one of the caller's jobs (404 for anyone else's)
 *   POST   /jobs/:id/rerun              an interrupted, failed or refused job back to the queue
 *   POST   /jobs/:id/discard            cancel a job that has not finished
 *   GET    /me/profiles                 the caller's profiles (level, Liaison tools, each node's confirmed level)
 *   PUT    /me/profiles/:agentId        set the profile for one agent; a raise, any Open, or a node
 *                                       pinned below asks an in-app confirmation per node (D24, D42)
 *   DELETE /me/profiles/:agentId        back to the default profile (voids the raises above it)
 */
import {
  levelNeedsConfirmation,
  levelRank,
  minLevel,
  NODE_LEVELS,
  NODE_PROTOCOL_AUTONOMY,
  NODE_PROTOCOL_IMPORT,
  type NodeLevel,
  nodeFollowResultSchema,
  nodeGuardrailRiskNote,
  nodeSessionCompletionSchema,
  redactSecrets,
  sanitizeLocalTurnRecord,
  suggestedNodeGuardrail,
} from "@liaison/shared"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  agents,
  messages,
  NODE_JOB_STATUSES,
  nodeJobs,
  nodeProfiles,
  nodes,
  routines,
  threadNodeSettings,
  users,
} from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { redactStoredToolCalls } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { taintApprovalAudienceGapDetail } from "~/modules/agent/scopes/taint-approval-audience"
import {
  attachConfirmation,
  attachedProfileRaises,
  voidProfileConfirmationsAbove,
} from "~/modules/node-sessions/confirmations"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { requireNodeCredential } from "./credentials"
import { nodeJobReplyScope } from "./job-taint"
import {
  bindNodeJobConnection,
  claimNodeJob,
  completeFollowJob,
  completeNodeJob,
  DEFAULT_NODE_PROFILE,
  discardNodeJob,
  failNodeJob,
  followInPlaceAfterResult,
  heartbeatNodeJob,
  loadNodeProfile,
  NODE_FAIL_CODES,
  NODE_LEASE_SECONDS,
  NODE_OUTDATED_ERROR,
  NODE_PROTOCOL_HEADER,
  type NodeJobRow,
  nodeFailStatus,
  releaseNodeJobResult,
  rerunNodeJob,
  reserveNodeJobResult,
} from "./jobs"
import { publishOwnerNodesChange } from "./node-broadcast"
import { loadNodePins, nodePinFor } from "./routes"
import { loadThreadNodeSetting } from "./thread-settings"

const log = rootLogger.child({ module: "node-job-routes" })

/** A job with a conversation to post in (an app job has none, D32). */
type ThreadNodeJobRow = NodeJobRow & { threadId: string }

export const nodeJobRoutes = new Hono<AppEnv>()

/** The marker on every row a node job wrote. */
export const RUN_LOCATION_NODE = "node"

const jobIdParam = z.object({ id: z.string().uuid() })
const agentIdParam = z.object({ agentId: z.string().uuid() })
const generation = z.number().int().positive()

const refusalSchema = z.object({
  tool: z.string().max(200),
  reason: z.string().max(1000),
  detail: z.string().max(2000).optional(),
})

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

const resultSchema = z
  .object({
    leaseGeneration: generation,
    /** Required for a run; a follow's result (`follow`) carries none. */
    text: z.string().max(100_000).optional(),
    /** The turn record, as a local reply sends it; sanitised server side. */
    turn: z.record(z.string(), z.unknown()).optional(),
    refusals: z.array(refusalSchema).max(200).default([]),
    usage: usageSchema.optional(),
    /** Interactive jobs (S24): the SDK session the next turn of this chat resumes. */
    sdkSessionId: z.string().min(1).max(200).optional(),
    /** The model the node actually ran the job on (its SDK's own word). */
    modelId: z.string().min(1).max(200).optional(),
    /** S1, S2: the run's completion signal (absent: the session needs its person). */
    completion: nodeSessionCompletionSchema.optional(),
    /** S4: the run ended at its hard token limit, not at a turn end. */
    endedBy: z.literal("token_limit").optional(),
    /** A45, A62: a follow job's end (why, and the byte offset it reached); never with `completion`. */
    follow: nodeFollowResultSchema.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.follow && b.completion) {
      ctx.addIssue({
        code: "custom",
        path: ["follow"],
        message: "follow and completion are exclusive",
      })
    }
    if (!b.follow && b.text === undefined) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "text is required" })
    }
  })

const fenceSchema = z.object({ leaseGeneration: generation })

const claimSchema = z.object({ mcpConnectionId: z.string().uuid().optional() }).default({})

const bindSchema = z.object({ leaseGeneration: generation, mcpConnectionId: z.string().uuid() })

const failSchema = z.object({
  leaseGeneration: generation,
  error: z.string().min(1).max(2000),
  code: z.enum(NODE_FAIL_CODES).default("error"),
  refusals: z.array(refusalSchema).max(200).optional(),
  usage: usageSchema.optional(),
})

const listSchema = z.object({
  status: z.enum(NODE_JOB_STATUSES).optional(),
  backlog: z.enum(["0", "1"]).optional(),
})

/** A profile is the level and Liaison tools only (S20, D18). */
const profileSchema = z
  .object({
    level: z.enum(NODE_LEVELS),
    liaisonTools: z.boolean(),
    /**
     * D24, D42: the in-app `profile_raise` confirmations, one per node whose
     * confirmed level is below the saved one (or any node, for Open).
     */
    confirmationIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict()

/** The model each agent asks for (null: Auto), by id. */
async function agentModels(orgId: string, ids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await withSystemDb("nodes:agent-models", (tx) =>
    tx
      .select({ id: agents.id, model: agents.modelPreference })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, unique))),
  )
  return new Map(rows.map((r) => [r.id, r.model ?? null]))
}

/** The model a routine names for its runs (null: its agent's). */
async function routineModel(orgId: string, routineId: string): Promise<string | null> {
  const [row] = await withSystemDb("nodes:routine-model", (tx) =>
    tx
      .select({ model: routines.agentModelId })
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
      .limit(1),
  )
  return row?.model ?? null
}

/**
 * D18, L18: the level suggested for an agent's node model, and the note that
 * goes with it. Only a Claude preference runs on the node as itself; a cloud
 * model (Gemini) says nothing about the node's model, so nothing is suggested.
 */
function guardrailAdvice(model: string | null) {
  const suggested = model?.toLowerCase().startsWith("claude-")
    ? suggestedNodeGuardrail(model)
    : null
  return {
    suggestedGuardrail: suggested,
    riskNote: suggested ? nodeGuardrailRiskNote(suggested) : null,
  }
}

/** Display names of agents of one org, by id (the queue and profile lists name them). */
async function agentNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await withSystemDb("nodes:agent-names", (tx) =>
    tx
      .select({ id: agents.id, name: agents.displayName })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, unique))),
  )
  return new Map(rows.map((r) => [r.id, r.name]))
}

function jobView(job: NodeJobRow, agentName: string | null = null) {
  return {
    id: job.id,
    nodeId: job.nodeId,
    agentId: job.agentId,
    agentName,
    threadId: job.threadId,
    source: job.source,
    sourceRef: job.sourceRef,
    routineId: job.routineId,
    runsOn: job.runsOn,
    kind: job.kind,
    permissionMode: job.permissionMode,
    sdkSessionId: job.sdkSessionId,
    prompt: job.prompt,
    trigger: job.trigger,
    tokenBudget: job.tokenBudget,
    hardTokenLimit: job.hardTokenLimit,
    status: job.status,
    backlog: job.backlog,
    skippedCount: job.skippedCount,
    createdAt: job.createdAt.toISOString(),
  }
}

// ── node calls ──────────────────────────────────────────────────────────────

nodeJobRoutes.post("/jobs/:id/claim", zValidator("param", jobIdParam), async (c) => {
  const node = await requireNodeCredential(c)
  // An empty body is a claim with no connection (a job with no Liaison tools).
  const raw = await c.req.json().catch(() => ({}))
  const parsed = claimSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new HTTPException(400, { message: "mcpConnectionId must be a uuid" })
  const protocol = Number.parseInt(c.req.header(NODE_PROTOCOL_HEADER) ?? "", 10)
  const outcome = await claimNodeJob(node, c.req.valid("param").id, {
    ...parsed.data,
    protocol: Number.isFinite(protocol) ? protocol : 0,
  })
  switch (outcome.kind) {
    case "claimed": {
      // The node runs the job on the agent's own model when it can (a
      // Claude model its SDK offers), else on its default (local Haiku).
      // A routine's own model wins over its agent's, and so does the model
      // picked for a My node chat in its conversation (0170).
      const ownModel = outcome.job.routineId
        ? await routineModel(outcome.job.orgId, outcome.job.routineId)
        : outcome.job.kind === "interactive" && outcome.job.threadId
          ? ((
              await loadThreadNodeSetting(
                outcome.job.orgId,
                outcome.job.threadId,
                outcome.job.agentId,
              )
            )?.model ?? null)
          : null
      const [models, names] = await Promise.all([
        agentModels(outcome.job.orgId, [outcome.job.agentId]),
        agentNames(outcome.job.orgId, [outcome.job.agentId]),
      ])
      return success(c, {
        job: {
          ...jobView(outcome.job, names.get(outcome.job.agentId) ?? null),
          agentModel: ownModel ?? models.get(outcome.job.agentId) ?? null,
        },
        leaseGeneration: outcome.leaseGeneration,
        leaseExpiresAt: outcome.leaseExpiresAt.toISOString(),
        leaseSeconds: NODE_LEASE_SECONDS,
        profile: outcome.profile,
        ...(outcome.session ? { session: outcome.session } : {}),
        caps: outcome.caps,
        // D43 F2: the node protocol this server speaks, so a node decides
        // from it (never from what a claim happens to carry) and keeps it.
        serverProtocol: NODE_PROTOCOL_AUTONOMY,
      })
    }
    case "claimed_follow": {
      // A45: a follow's answer. No profile, model or caps: it reads and streams
      // a transcript, it never runs Claude Code.
      const names = await agentNames(outcome.job.orgId, [outcome.job.agentId])
      return success(c, {
        kind: "follow",
        job: jobView(outcome.job, names.get(outcome.job.agentId) ?? null),
        leaseGeneration: outcome.leaseGeneration,
        leaseExpiresAt: outcome.leaseExpiresAt.toISOString(),
        leaseSeconds: NODE_LEASE_SECONDS,
        session: outcome.session,
        follow: outcome.follow,
        serverProtocol: NODE_PROTOCOL_IMPORT,
      })
    }
    case "node_outdated":
      return c.json({ error: { code: "node_outdated", message: NODE_OUTDATED_ERROR } }, 409)
    case "not_found":
      throw new HTTPException(404, { message: "no such job" })
    case "node_disabled":
      throw new HTTPException(403, { message: "this node is switched off" })
    case "bad_connection":
      return c.json(
        {
          error: {
            code: "bad_connection",
            message: "that MCP connection is not yours for this job's agent",
          },
        },
        422,
      )
    case "refused":
      return c.json({ error: { code: outcome.code, message: outcome.error } }, 403)
    case "conflict":
      return c.json(
        { error: { code: outcome.reason, message: "this job cannot be claimed now" } },
        409,
      )
  }
})

const stale = (c: { json: (b: unknown, s: 409) => Response }) =>
  c.json(
    { error: { code: "stale_lease", message: "this lease is no longer yours: stop the run" } },
    409,
  )

nodeJobRoutes.post(
  "/jobs/:id/connection",
  zValidator("param", jobIdParam),
  zValidator("json", bindSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const body = c.req.valid("json")
    const jobId = c.req.valid("param").id
    // Fenced like every node signal: only the holder of this generation binds.
    if (!(await heartbeatNodeJob(node, jobId, body.leaseGeneration))) return stale(c)
    const bound = await bindNodeJobConnection(node, jobId, body.mcpConnectionId)
    if (bound === "not_held") return stale(c)
    if (bound === "bad_connection") {
      return c.json(
        {
          error: {
            code: "bad_connection",
            message: "that MCP connection is not yours for this job's agent",
          },
        },
        422,
      )
    }
    return success(c, { mcpConnectionId: body.mcpConnectionId })
  },
)

nodeJobRoutes.post(
  "/jobs/:id/heartbeat",
  zValidator("param", jobIdParam),
  zValidator("json", fenceSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const held = await heartbeatNodeJob(
      node,
      c.req.valid("param").id,
      c.req.valid("json").leaseGeneration,
    )
    if (!held) return stale(c)
    return success(c, { leaseExpiresAt: held.leaseExpiresAt.toISOString() })
  },
)

nodeJobRoutes.post(
  "/jobs/:id/started",
  zValidator("param", jobIdParam),
  zValidator("json", fenceSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const held = await heartbeatNodeJob(
      node,
      c.req.valid("param").id,
      c.req.valid("json").leaseGeneration,
      {
        started: true,
      },
    )
    if (!held) return stale(c)
    return success(c, { leaseExpiresAt: held.leaseExpiresAt.toISOString() })
  },
)

nodeJobRoutes.post(
  "/jobs/:id/fail",
  zValidator("param", jobIdParam),
  zValidator("json", failSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const body = c.req.valid("json")
    const ok = await failNodeJob(node, c.req.valid("param").id, body.leaseGeneration, {
      error: redactSecrets(body.error),
      code: body.code,
      refusals: body.refusals?.map(redactRefusal),
      usage: body.usage,
    })
    if (!ok) return stale(c)
    return success(c, { status: nodeFailStatus(body.code) })
  },
)

function redactRefusal(r: z.infer<typeof refusalSchema>) {
  return {
    tool: r.tool,
    reason: redactSecrets(r.reason),
    ...(r.detail !== undefined ? { detail: redactSecrets(r.detail) } : {}),
  }
}

/** The stored line of a node job that ended with no text (as a local turn's). */
export const NODE_JOB_NO_TEXT_LINE =
  "The job ended on the computer that ran it before an answer was written."

nodeJobRoutes.post(
  "/jobs/:id/result",
  zValidator("param", jobIdParam),
  zValidator("json", resultSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const jobId = c.req.valid("param").id
    const body = c.req.valid("json")
    const reservation = await reserveNodeJobResult(node, jobId, body.leaseGeneration)
    if (reservation.kind === "replay") {
      return success(
        c,
        reservation.messageId
          ? { messageId: reservation.messageId, replay: true }
          : { replay: true },
      )
    }
    if (reservation.kind === "stale") return stale(c)
    // A45: a follow job's result is its follow's end, and only a follow's.
    if ((reservation.job.kind === "follow") !== (body.follow !== undefined)) {
      await releaseNodeJobResult(reservation.job, body.leaseGeneration)
      return c.json(
        {
          error: {
            code: "bad_result",
            message: "a follow job ends with `follow`, and only a follow job does",
          },
        },
        422,
      )
    }
    if (body.follow) {
      try {
        await completeFollowJob(reservation.job, body.leaseGeneration, body.follow)
      } catch (err) {
        await releaseNodeJobResult(reservation.job, body.leaseGeneration)
        throw err
      }
      return success(c, { messageId: null }, undefined, 201)
    }
    if (SESSION_RESULT_SOURCES.has(reservation.job.source)) {
      return completeSessionResult(c, reservation.job, body)
    }
    const threadId = reservation.job.threadId
    if (!threadId) {
      await releaseNodeJobResult(reservation.job, body.leaseGeneration)
      throw new HTTPException(409, { message: "this job has no conversation to post in" })
    }
    const job: ThreadNodeJobRow = { ...reservation.job, threadId }

    try {
      const [agent] = await withSystemDb("nodes:result-agent", (tx) =>
        tx
          .select({ displayName: agents.displayName, scopeCeiling: agents.scopeCeiling })
          .from(agents)
          .where(and(eq(agents.id, job.agentId), eq(agents.orgId, job.orgId)))
          .limit(1),
      )
      if (!agent) throw new HTTPException(409, { message: "the job's agent is gone" })
      // Never the client's: the job's taint union its source scopes (A18).
      const requiredScopes = await nodeJobReplyScope(job, agent.scopeCeiling ?? [])
      const record = body.turn ? sanitizeLocalTurnRecord(body.turn) : null
      const toolCalls = record ? await redactStoredToolCalls(job.orgId, record.toolCalls) : []
      const refusals = body.refusals.map(redactRefusal)
      const metadata: Record<string, unknown> = {
        runLocation: RUN_LOCATION_NODE,
        nodeJobId: job.id,
        nodeId: node.id,
        ...(refusals.length > 0 ? { refusals } : {}),
        ...(body.usage ? { usage: body.usage } : {}),
        ...(body.modelId ? { modelId: body.modelId } : {}),
        ...(record
          ? {
              modelId: record.modelId ?? body.modelId ?? undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              stepCount: record.stepCount,
              usage: body.usage ?? record.usage,
              reasoning: record.reasoning || undefined,
              timeline: record.timeline.length > 0 ? record.timeline : undefined,
              finishReason: record.finishReason,
            }
          : {}),
      }
      // A19: through the one persistence path, under the owner's own RLS; it
      // never takes (or needs) the interactive local claim.
      const text = body.text ?? ""
      const answer = text.trim() ? text : NODE_JOB_NO_TEXT_LINE
      const sent = await persistAgentTurn({
        // The answer of the turn that ran on the node: the end of what was asked.
        endsTurn: true,
        write: (fn) => withRequestRls(c, (tx) => fn(tx)),
        orgId: job.orgId,
        userId: job.ownerUserId,
        threadId: job.threadId,
        content: answer,
        agentId: job.agentId,
        agentAuthorLabel: agent.displayName,
        requiredScopes,
        metadata,
      })
      if (!sent)
        throw new HTTPException(403, { message: "this conversation is not yours to post in" })
      await completeNodeJob(job, body.leaseGeneration, {
        messageId: sent.id,
        requiredScopes,
        refusals,
        usage: body.usage ?? record?.usage ?? null,
        text: answer,
        // S3: a routine's or agent_tag's posted answer is its deliverable.
        alwaysDone: true,
        // Only words the node wrote are a routine's report, never the no-text line.
        reported: text.trim().length > 0,
      })
      if (job.kind === "interactive" && body.sdkSessionId) {
        await rememberSdkSession(job, body.sdkSessionId)
      }
      // Asked in the job thread itself, the result above IS the answer there.
      if (
        job.source === "agent_tag" &&
        job.replyThreadId &&
        job.requesterUserId &&
        job.replyThreadId !== job.threadId
      ) {
        await postAnswerBack(job, sent.id, agent.displayName, requiredScopes, answer)
      }
      return success(c, { messageId: sent.id }, undefined, 201)
    } catch (err) {
      await releaseNodeJobResult(job, body.leaseGeneration)
      throw err
    }
  },
)

/**
 * S11, A25: a dispatch's or an app session's result is its session's. The
 * conversation already holds the session card (P1-T20), and an app session has
 * no conversation (D32), so no message is posted: the job and its session are
 * done, the session's summary taken from the text when no `result` event gave
 * one. Routines and agent_tag runs still post their turn.
 */
// W3 (A44): a taken-over import's runs end like any session's.
const SESSION_RESULT_SOURCES = new Set<NodeJobRow["source"]>(["dispatch", "app", "import"])

async function completeSessionResult(
  c: Context,
  job: NodeJobRow,
  body: z.infer<typeof resultSchema>,
): Promise<Response> {
  try {
    await completeNodeJob(job, body.leaseGeneration, {
      messageId: null,
      // No message carries them; the job keeps its source scopes on record.
      requiredScopes: job.sourceRequiredScopes,
      refusals: body.refusals.map(redactRefusal),
      usage: body.usage ?? null,
      text: body.text?.trim() ? body.text : NODE_JOB_NO_TEXT_LINE,
      ...(body.completion ? { completion: body.completion } : {}),
      ...(body.endedBy ? { endedBy: body.endedBy } : {}),
    })
  } catch (err) {
    await releaseNodeJobResult(job, body.leaseGeneration)
    throw err
  }
  // D28 (b): refused because VS Code or a terminal drives it: follow it read-only.
  try {
    await followInPlaceAfterResult(job, body.completion?.reasonCode)
  } catch (err) {
    log.warn({ err, jobId: job.id }, "starting the in-place follow failed")
  }
  return success(c, { messageId: null }, undefined, 201)
}

/**
 * S24: the session an interactive node chat resumes on its next turn, kept on
 * the thread's node runtime (only the owner's own row for that agent).
 */
async function rememberSdkSession(job: ThreadNodeJobRow, sdkSessionId: string): Promise<void> {
  try {
    await withPrivilegedDb(job.orgId, "nodes:sdk-session", (tx) =>
      tx
        .update(threadNodeSettings)
        .set({ sdkSessionId, updatedAt: new Date() })
        .where(
          and(
            eq(threadNodeSettings.orgId, job.orgId),
            eq(threadNodeSettings.threadId, job.threadId),
            eq(threadNodeSettings.agentId, job.agentId),
            eq(threadNodeSettings.ownerUserId, job.ownerUserId),
          ),
        ),
    )
  } catch (err) {
    log.warn({ err, jobId: job.id }, "keeping the node chat's SDK session failed")
  }
}

/**
 * A17 as amended by D22 (2026-10-12): the asker gets THE ANSWER, in the thread
 * they asked in. A link alone pointed into the node owner's own thread with
 * the agent, which nobody else can open, so a colleague who asked never got
 * their answer (walk N8).
 *
 * Bounded like every node and local reply (S11): the answer carries the job's
 * `requiredScopes` (taint union source scopes, `nodeJobReplyScope`), and it is
 * posted only when every reader of the asking thread holds them: the asker and
 * every human member (`taintApprovalAudienceGapDetail`, the room floor's own
 * member list, the rule a tainted approval card is staged under). Otherwise the
 * thread gets a plain notice naming why and who can share it, readable by all
 * and quoting nothing of the answer; never a dead link.
 *
 * The job thread is named only in the metadata (`nodeResultThreadId`,
 * `nodeOwnerUserId`): the web draws the link for the owner alone, the one
 * person who can open it. Best effort: the result is stored whatever happens.
 */
async function postAnswerBack(
  job: NodeJobRow,
  resultMessageId: string,
  agentName: string,
  requiredScopes: string[],
  answer: string,
): Promise<void> {
  const requester = job.requesterUserId as string
  const replyThreadId = job.replyThreadId as string
  try {
    const perms = await withPrivilegedDb(job.orgId, "nodes:answer-back-perms", (tx) =>
      loadEffectivePermissions(tx, requester, job.orgId),
    )
    const gap = await taintApprovalAudienceGapDetail({
      orgId: job.orgId,
      threadId: replyThreadId,
      requesterUserId: requester,
      requesterScopes: perms.scopes,
      taintScopes: requiredScopes,
    })
    const ownerName = gap ? await nodeOwnerName(job.orgId, job.ownerUserId) : null
    // Asked inside a reply thread: the answer lands in that same reply thread.
    const [question] = job.replyMessageId
      ? await withPrivilegedDb(job.orgId, "nodes:link-back-root", (tx) =>
          tx
            .select({ id: messages.id, replyRootId: messages.replyRootId })
            .from(messages)
            .where(
              and(eq(messages.id, job.replyMessageId as string), eq(messages.orgId, job.orgId)),
            )
            .limit(1),
        )
      : []
    await persistAgentTurn({
      // The answer handed back to the person who asked: the end of their ask.
      endsTurn: true,
      write: (fn) =>
        withRlsContext(
          {
            actorType: "user",
            userId: requester,
            orgId: job.orgId,
            scopes: perms.scopes,
            dimensionGrants: perms.dimensionGrants,
          },
          (tx) => fn(tx),
        ),
      orgId: job.orgId,
      userId: requester,
      threadId: replyThreadId,
      content: gap ? withheldAnswerNotice(ownerName, gap) : answer,
      agentId: job.agentId,
      agentAuthorLabel: agentName,
      // The notice quotes nothing of the answer, so every reader may see it.
      requiredScopes: gap ? [] : requiredScopes,
      // TOP LEVEL, never a reply to the asking agent's question: the web folds
      // every reply under a person's message into "N messages between agents",
      // so the person who asked never saw that their answer had arrived. The
      // question it answers stays on the row (`nodeReplyToMessageId`).
      parentMessageId: null,
      ...(question?.replyRootId ? { replyRootId: question.replyRootId } : {}),
      metadata: {
        ...(job.replyMessageId ? { nodeReplyToMessageId: job.replyMessageId } : {}),
        runLocation: RUN_LOCATION_NODE,
        nodeJobId: job.id,
        nodeResultMessageId: resultMessageId,
        nodeResultThreadId: job.threadId,
        nodeOwnerUserId: job.ownerUserId,
        ...(gap ? { nodeAnswerWithheld: true } : {}),
      },
    })
  } catch (err) {
    log.warn({ err, jobId: job.id }, "node job answer back failed")
  }
}

/** The node owner's name as the asking thread is told it. */
async function nodeOwnerName(orgId: string, userId: string): Promise<string | null> {
  const [row] = await withSystemDb("nodes:answer-back-owner", (db) =>
    db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  return row?.name?.trim() || null
}

/**
 * D22: what the asking thread reads when the answer may not be shown there.
 * Names the scopes (as every taint refusal does), never who lacks them.
 */
export function withheldAnswerNotice(
  ownerName: string | null,
  gap: { audience: "requester" | "member"; missingScopes: string[] },
): string {
  const where = ownerName ? `${ownerName}'s computer` : "a colleague's computer"
  const who = ownerName ?? "the person whose computer answered"
  const needs =
    gap.missingScopes.length > 0
      ? `it draws on data that requires ${gap.missingScopes.join(", ")}`
      : "the access it draws on could not be checked for this conversation"
  const lacking =
    gap.missingScopes.length === 0
      ? ""
      : gap.audience === "requester"
        ? ", which the person who asked does not hold"
        : ", which not everyone in this conversation holds"
  return `Answered on ${where}. Its content can't be shown in this conversation because ${needs}${lacking}; ask ${who} to share it.`
}

// ── owner calls ─────────────────────────────────────────────────────────────

nodeJobRoutes.get("/me/jobs", zValidator("query", listSchema), async (c) => {
  const userId = c.get("userId")
  const q = c.req.valid("query")
  // "queued" is the waiting state as the user sees it: offered is still waiting.
  const statuses =
    q.status === "queued" ? (["queued", "offered"] as const) : q.status ? [q.status] : undefined
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.ownerUserId, userId),
          ...(statuses ? [inArray(nodeJobs.status, [...statuses])] : []),
          ...(q.backlog === "1" ? [eq(nodeJobs.backlog, true)] : []),
          ...(q.backlog === "0" ? [eq(nodeJobs.backlog, false)] : []),
        ),
      )
      .orderBy(asc(nodeJobs.createdAt))
      .limit(200),
  )
  const names = await agentNames(
    c.get("orgId"),
    rows.map((r) => r.agentId),
  )
  return success(
    c,
    rows.map((r) => jobView(r, names.get(r.agentId) ?? null)),
  )
})

/** L24: one of the caller's jobs (the runner reads it instead of scanning the queue). */
nodeJobRoutes.get("/jobs/:id", zValidator("param", jobIdParam), async (c) => {
  const userId = c.get("userId")
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.id, c.req.valid("param").id),
          eq(nodeJobs.orgId, c.get("orgId")),
          eq(nodeJobs.ownerUserId, userId),
        ),
      )
      .limit(1),
  )
  if (!row) throw new HTTPException(404, { message: "no such job" })
  const names = await agentNames(c.get("orgId"), [row.agentId])
  return success(c, jobView(row, names.get(row.agentId) ?? null))
})

/** A session's run: Resume is a message to the session, Cancel is its Stop (P3, L4). */
const useSessionCommands = (c: Context) =>
  c.json(
    {
      error: {
        code: "use_session_commands",
        message: "This job is a session's run: send the session a message, or stop it.",
      },
    },
    409,
  )

nodeJobRoutes.post("/jobs/:id/rerun", zValidator("param", jobIdParam), async (c) => {
  const r = await rerunNodeJob(c.get("orgId"), c.get("userId"), c.req.valid("param").id)
  if (r === "not_found") throw new HTTPException(404, { message: "no such job" })
  if (r === "use_session_commands") return useSessionCommands(c)
  if (r === "wrong_state")
    throw new HTTPException(409, { message: "only an interrupted or failed job can run again" })
  return success(c, { status: "queued" })
})

nodeJobRoutes.post("/jobs/:id/discard", zValidator("param", jobIdParam), async (c) => {
  const r = await discardNodeJob(c.get("orgId"), c.get("userId"), c.req.valid("param").id)
  if (r === "not_found") throw new HTTPException(404, { message: "no such job" })
  if (r === "use_session_commands") return useSessionCommands(c)
  if (r === "wrong_state")
    throw new HTTPException(409, { message: "this job has already finished" })
  return success(c, { status: "cancelled" })
})

/** Rolls a profile save back: these nodes still need a confirmation. */
class UnconfirmedNodes extends Error {
  constructor(readonly nodeIds: string[]) {
    super("confirmation_required")
  }
}

/** The caller's enabled, unrevoked nodes, read through their own RLS. */
async function ownEnabledNodes(
  c: Context<AppEnv>,
): Promise<Array<{ id: string; name: string; lastSeenAt: Date | null }>> {
  const userId = c.get("userId")
  return withRequestRls(c, (tx) =>
    tx
      .select({ id: nodes.id, name: nodes.name, lastSeenAt: nodes.lastSeenAt })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerUserId, userId),
          eq(nodes.orgId, c.get("orgId")),
          eq(nodes.enabled, true),
          isNull(nodes.revokedAt),
        ),
      )
      .orderBy(asc(nodes.createdAt)),
  )
}

nodeJobRoutes.get("/me/profiles", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodeProfiles)
      .where(eq(nodeProfiles.nodeOwnerUserId, userId))
      .orderBy(asc(nodeProfiles.createdAt)),
  )
  const ids = rows.map((p) => p.agentId)
  const [names, models, owned, pins, pending] = await Promise.all([
    agentNames(orgId, ids),
    agentModels(orgId, ids),
    ownEnabledNodes(c),
    loadNodePins(orgId, userId),
    attachedProfileRaises(orgId, userId),
  ])
  // D42 with D7: the node's pin, or a raise confirmed for it that its next
  // session consumes, whichever is higher.
  const confirmedOn = (nodeId: string, agentId: string): NodeLevel => {
    const pin = nodePinFor(pins, nodeId, agentId)
    const raise = pending.get(nodeId)?.get(agentId)
    return raise && levelRank(raise) > levelRank(pin) ? raise : pin
  }
  return success(
    c,
    rows.map((p) => ({
      id: p.id,
      agentId: p.agentId,
      agentName: names.get(p.agentId) ?? null,
      level: p.level,
      liaisonTools: p.liaisonTools,
      ...guardrailAdvice(models.get(p.agentId) ?? null),
      updatedAt: p.updatedAt.toISOString(),
      // D42: what each node has confirmed for this agent (Strict when it published none).
      nodes: owned.map((n) => ({
        nodeId: n.id,
        nodeName: n.name,
        confirmedLevel: confirmedOn(n.id, p.agentId),
        // D6: tells same-named computers apart.
        lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
      })),
    })),
  )
})

nodeJobRoutes.put(
  "/me/profiles/:agentId",
  zValidator("param", agentIdParam),
  zValidator("json", profileSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { agentId } = c.req.valid("param")
    const body = c.req.valid("json")
    if (!(await isMentionableAgent(orgId, userId, agentId))) {
      throw new HTTPException(403, { message: "this agent is not yours to run" })
    }
    const [saved, owned, pins] = await Promise.all([
      loadNodeProfile(orgId, userId, agentId),
      ownEnabledNodes(c),
      loadNodePins(orgId, userId),
    ])
    // D42: a node needs this save confirmed when the level is above what it
    // runs today (the stricter of the saved level and its pin), and for Open
    // always (K18): a raise, a migrated level its pin never confirmed, a node
    // enrolled after the raise.
    const needing = owned
      .map((n) => n.id)
      .filter((nodeId) =>
        levelNeedsConfirmation(
          minLevel(saved.level, nodePinFor(pins, nodeId, agentId)),
          body.level,
        ),
      )
    const profile = { level: body.level, liaisonTools: body.liaisonTools }
    const ids = [...new Set(body.confirmationIds ?? [])]
    const missing = await withPrivilegedDb(orgId, "nodes:profile-save", async (tx) => {
      const unconfirmed: string[] = []
      for (const nodeId of needing) {
        let attached = false
        for (const id of ids) {
          const outcome = await attachConfirmation(tx, {
            id,
            orgId,
            ownerUserId: userId,
            nodeId,
            agentId,
            level: body.level,
            purpose: "profile_raise",
          })
          if (outcome.ok) {
            attached = true
            break
          }
        }
        if (!attached) unconfirmed.push(nodeId)
      }
      // Nothing is saved or attached unless every node that asks is confirmed,
      // except (P1-walk D7) when the level is unchanged and the save brings
      // confirmations: that is a Confirm on some computers, which attaches
      // theirs and leaves the others as they were (no level moves anywhere).
      const confirmsSome =
        body.level === saved.level && ids.length > 0 && unconfirmed.length < needing.length
      if (unconfirmed.length > 0 && !confirmsSome) throw new UnconfirmedNodes(unconfirmed)
      if (levelRank(body.level) < levelRank(saved.level)) {
        await voidProfileConfirmationsAbove(tx, {
          orgId,
          ownerUserId: userId,
          agentId,
          level: body.level,
        })
      }
      await tx
        .insert(nodeProfiles)
        .values({ orgId, nodeOwnerUserId: userId, agentId, ...profile })
        .onConflictDoUpdate({
          target: [nodeProfiles.nodeOwnerUserId, nodeProfiles.agentId],
          set: { ...profile, updatedAt: new Date() },
        })
      return unconfirmed
    }).catch((err: unknown) => {
      if (err instanceof UnconfirmedNodes) return err.nodeIds
      throw err
    })
    const partial = body.level === saved.level && ids.length > 0 && missing.length < needing.length
    if (missing.length > 0 && !partial) {
      return c.json(
        {
          error: {
            code: "confirmation_required",
            message: "Confirm this level in the app for each computer named.",
            nodeIds: missing,
          },
        },
        403,
      )
    }
    await publishOwnerNodesChange({ orgId, ownerUserId: userId, change: "profile" })
    const models = await agentModels(orgId, [agentId])
    return success(c, {
      agentId,
      ...profile,
      ...guardrailAdvice(models.get(agentId) ?? null),
      ...(missing.length > 0 ? { unconfirmedNodeIds: missing } : {}),
    })
  },
)

nodeJobRoutes.delete("/me/profiles/:agentId", zValidator("param", agentIdParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { agentId } = c.req.valid("param")
  const rows = await withRequestRls(c, (tx) =>
    tx
      .delete(nodeProfiles)
      .where(and(eq(nodeProfiles.nodeOwnerUserId, userId), eq(nodeProfiles.agentId, agentId)))
      .returning({ id: nodeProfiles.id }),
  )
  if (rows.length === 0) throw new HTTPException(404, { message: "no profile for this agent" })
  // Back to Strict: no raise above it stays waiting for a node to consume.
  await withPrivilegedDb(orgId, "nodes:profile-reset", (tx) =>
    voidProfileConfirmationsAbove(tx, {
      orgId,
      ownerUserId: userId,
      agentId,
      level: DEFAULT_NODE_PROFILE.level,
    }),
  )
  await publishOwnerNodesChange({ orgId, ownerUserId: userId, change: "profile" })
  return success(c, { agentId, ...DEFAULT_NODE_PROFILE })
})
