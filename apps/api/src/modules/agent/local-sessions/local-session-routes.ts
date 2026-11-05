// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The audit trail for a session that runs on the user's own machine (A20).
//
// A local session's prompts, answers and files never touch the server: the
// Agent SDK runs in the desktop sidecar against the user's own folder. So the
// only record that an agent ran at all, in which mode, on which model, is what
// the desktop posts here. Two routes, both of them writes:
//
//   POST /api/agents/:agentId/local-sessions            -> { sessionId }
//   POST /api/agents/:agentId/local-sessions/:id/events -> 204
//
// NO PATH, EVER. The folder identifies itself with a sha256 the desktop
// computes, and the prompt with a sha256 of its text. Both are 64 hex
// characters and the schema accepts nothing else, so a client that sends a
// path (a bug, or a well meaning "more useful" field) is refused rather than
// having its user's filesystem written into a row admins read. A hash still
// answers the questions the trail is for: the same folder twice, the same
// prompt replayed, one session's turns grouped together.
import { sanitizeLocalTurnRecord } from "@liaison/shared"
import { and, desc, eq, inArray, isNull, like, lte, or, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agentLocalClaims, auditLog, messages } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { users } from "~/db/schema/kernel/users"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { loadBoundedHistory, stripRetrievalToolParts } from "~/modules/agent/context/checkpoint"
import { coldTailBoundaryIndex } from "~/modules/agent/context/cold-resume"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { coldRecall, resumeLine } from "~/modules/agent/context/context"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { liveLocalClaims } from "~/modules/agent/local-sessions/local-claim-service"
import {
  localContextScopes,
  recordLocalRecallScopes,
} from "~/modules/agent/local-sessions/local-context-scopes"
import {
  mintTurnCredential,
  revokeTurnCredentials,
} from "~/modules/agent/local-sessions/turn-credential"
import { betweenTurnsUpkeep, coldResumeAdvanceForTurn } from "~/modules/agent/runtime/agent-service"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { intersectScopes } from "~/modules/agent/subruns/spawn-agent"
import { writeAuditLog } from "~/modules/audit/service"
import {
  connectionTurnTaintPresent,
  loadConnectionTaintLedger,
  loadConnectionTaintMarks,
  loadConnectionTurnTaint,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_TAINT_LEDGER_TTL_SECONDS,
  openConnectionTurnTaint,
} from "~/modules/mcp/connection-service"
import {
  filterByVisibility,
  isMessageVisible,
  type VisibilityViewer,
} from "~/services/security/visibility"

const K = () => sql.raw(schemaRef("kernel"))

export const localSessionRoutes = new Hono<AppEnv>()

/** Every action name this slice writes, so a reader can grep for one place. */
export const LOCAL_SESSION_START = "agent.local_session.start"
export const LOCAL_SESSION_TURN = "agent.local_session.turn"
export const LOCAL_SESSION_END = "agent.local_session.end"
/** The agent's own answer, posted by the machine the turn ran on. */
export const LOCAL_SESSION_REPLY = "agent.local_session.reply"

/** The marker that separates these rows from an in-app turn's rows. */
export const RUN_LOCATION_LOCAL = "local"

/** The stored line of a local turn that called tools and wrote no text. */
export const LOCAL_TURN_NO_TEXT_LINE =
  "The agent stopped before writing an answer. The steps it took are listed above."
/** The stored line of a local turn the SDK reported as failed with no text. */
export const LOCAL_TURN_FAILED_LINE =
  "This response failed on the computer that ran it before an answer was written."

/**
 * A sha256, lowercase. NOT a path, not a name, not a prefix: the point of the
 * field is that the server cannot reconstruct what was hashed, and anything
 * that is not exactly 64 hex characters could be the thing itself.
 */
const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest, never a path")

// Keep in step with the desktop's PERMISSION_MODES (apps/desktop/sidecar/index.ts,
// src-tauri/src/sidecar.rs): a mode the shell can start in but this schema
// refuses turns every local session start into a 400 ("Liaison would not
// record this session"), which is how "auto" first shipped.
const permissionMode = z.enum(["auto", "manual", "edit", "plan", "bypass"])

const startSchema = z.object({
  permissionMode,
  folderHash: sha256Hex,
  model: z.string().min(1).max(200),
  resumeSessionId: z.string().min(1).max(200).optional(),
  /**
   * WHY A START RESUMED NOTHING, when it could have (2026-09-23). A cold turn
   * (`cold_resume`), or an agent whose definition changed since the stored
   * session was created (`definition_changed`), or a stored session from a
   * desktop too old to have recorded which definition it ran with
   * (`definition_unknown`). Absent on a resume and on a first start. An older
   * server strips it, which is the row it always wrote.
   */
  freshReason: z.enum(["cold_resume", "definition_changed", "definition_unknown"]).optional(),
})

/**
 * The session id in the path, as the START route minted it. It is written
 * STRAIGHT INTO the audit trail's `entity_id`, so an unchecked one lets a
 * client attribute rows to a session that never existed, or to another
 * session's id. The server mints a uuid and nothing else is a session.
 */
const sessionIdParam = z.object({ sessionId: z.string().uuid() })

const eventSchema = z.object({
  kind: z.enum(["turn", "end"]),
  promptChecksum: sha256Hex.optional(),
  permissionMode: permissionMode.optional(),
  /**
   * THE CONVERSATION A TURN RUNS IN, so the server runs the same between-turns
   * upkeep a cloud turn gets (checkpoint advance, episode quiet close). Only
   * acted on for a conversation this caller holds the live claim on. An older
   * desktop sends none and gets the trail row it always got.
   */
  threadId: z.string().uuid().optional(),
})

/**
 * The agent this session runs as, or a refusal. An agent of another org and an
 * agent that does not exist get the SAME answer, so the route cannot be used
 * to ask whether some other org owns a given id.
 */
async function requireOwnAgent(orgId: string, agentId: string): Promise<string> {
  return (await loadOwnAgent(orgId, agentId)).id
}

/** The same check, with the name a reply is attributed under and its ceiling. */
async function loadOwnAgent(
  orgId: string,
  agentId: string,
): Promise<{ id: string; displayName: string; scopeCeiling: string[] }> {
  const [agent] = await withSystemDb("local-session-agent-org-check", (tx) =>
    tx
      .select({
        id: agents.id,
        orgId: agents.orgId,
        displayName: agents.displayName,
        scopeCeiling: agents.scopeCeiling,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  )
  if (!agent || agent.orgId !== orgId) {
    throw new HTTPException(403, { message: "this agent is not yours to run" })
  }
  return {
    id: agent.id,
    displayName: agent.displayName,
    scopeCeiling: agent.scopeCeiling ?? [],
  }
}

/**
 * WHAT A LOCAL OR NODE SESSION MAY BE HANDED IN ONE ROOM.
 *
 * A cloud turn reads its context (history, checkpoint, recall, the agent's
 * definition) through one viewer: the requester's id, and the turn's effective
 * scope as the grants, which is the room floor (every human member's grants
 * intersected) ∩ the agent's ceiling ∩ the requester's own grants
 * (`resolveTurnScope`, `assembleContext`'s `contextViewer`). A session running
 * on someone's machine receives that same context over HTTP, so the routes that
 * hand it out apply the same viewer. Without it, an admin's local turn in a room
 * where a member lacks a scope was handed content beyond what that member may
 * read, which the cloud path never puts in front of the model. In a DM the floor
 * is the requester alone, so nothing narrows there.
 *
 * `null` when the agent is not a live agent of the org. A room floor error
 * propagates (fail closed), exactly as on the cloud path.
 */
export async function roomBoundViewer(params: {
  orgId: string
  threadId: string
  agentId: string
  userId: string
  userScopes: string[]
}): Promise<VisibilityViewer | null> {
  const { orgId, threadId, agentId, userId, userScopes } = params
  return withPrivilegedDb(orgId, "local-room-bound-scope", async (tx) => {
    const [agent] = await tx
      .select({ scopeCeiling: agents.scopeCeiling })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .limit(1)
    if (!agent) return null
    const { effectiveScope } = await computeEffectiveScopeForTurn(
      tx,
      orgId,
      threadId,
      userId,
      agent.scopeCeiling ?? [],
    )
    return { userId, grants: intersectScopes(effectiveScope, userScopes) }
  })
}

/** The room-bound viewer of a route's caller, or a refusal: no viewer, no content. */
async function requireRoomBoundViewer(
  c: Parameters<typeof extractRlsContext>[0],
  threadId: string,
  agentId: string,
): Promise<VisibilityViewer> {
  const actor = extractRlsContext(c)
  const viewer = await roomBoundViewer({
    orgId: actor.orgId,
    threadId,
    agentId,
    userId: actor.userId,
    userScopes: actor.scopes,
  })
  if (!viewer) throw new HTTPException(403, { message: "this agent is not yours to run" })
  return viewer
}

/**
 * WHAT A LOCALLY RUN REPLY MAY BE QUOTING (D3, spec-security.md:40; S11 rule 5).
 *
 * `requiredScopes: []` is a positive assertion that the turn touched no scoped
 * data, never the absence of a computation. A turn that ran on someone's
 * machine read Liaison data only through this server: its tool calls (the MCP
 * taint below), the agent's definition and the conversation it was handed
 * (`localContextScopes`). Their union is the stamp, projected onto read scopes
 * like every other stamp (rule 5).
 *
 * It used to be the turn's whole effective scope (room floor intersected with
 * the agent's ceiling). For an admin whose agent's ceiling is `*`, that is `*`:
 * every local reply in a DM required `*`, history carried it into every later
 * cloud turn of the conversation, and a write any non-admin could read was
 * refused from then on (2026-10-08). The effective scope is now only the
 * fallback when the context cannot be read, and is still unioned in, with the
 * ceiling, wherever the taint below cannot be read.
 *
 * THE EXACT TAINT, on top of that bound (T26 F12, the ws_08 item).
 *
 * The sidecar's Liaison calls do not vanish: they go through the agent bound
 * MCP path, which accumulates and PERSISTS what they touched
 * (`mcp/tool-call.ts` -> `saveConnectionTurnTaint`), keyed by org and agent
 * because two connections bound to one agent are one external runtime as far
 * as laundering goes. So the server can read back the leaf scopes this local
 * run actually used and add them to the tag.
 *
 * UNION, not replacement. The MCP taint is the only thing that knows about the
 * tool results, and the context scopes are the only thing that knows about the
 * THREAD and the definition the session was given (a local turn quotes the
 * conversation whether or not it called a tool). Either alone under tags; the
 * union is the honest set.
 *
 * THIS TURN'S TAINT, NOT THE WINDOW'S (P8-FX2, SK-1).
 *
 * The cumulative key is one set per (org, agent), kept for 15 sliding minutes
 * and never cleared, because the write-refusing side of the taint must assume
 * anything the runtime touched is still in reach. Folding all of it into a
 * reply tags this answer with a call made in another conversation a quarter of
 * an hour ago: the reply then requires a scope its own turn never used, and
 * `visible()` hides it from every room member who lacks that scope, the person
 * who asked included. Over-tagging is not the safe direction when the thing
 * over-tagged is the answer somebody is waiting for.
 *
 * The bound is the SESSION'S OWN TURN. The desktop posts a turn event when it
 * hands a prompt to the sidecar, so the server holds a server-stamped time for
 * the turn this reply ends, per session; `recordConnectionTaintMarks` stamps
 * each scope with when it first entered the runtime. Only scopes stamped at or
 * after that turn began are folded in. A session with no turn event yet falls
 * back to its own start, and a session the trail cannot date at all falls back
 * to the whole set, which is exactly the behaviour before this fix.
 *
 * Fallbacks, all closed: unreadable context falls back to the effective
 * scope; a room whose floor cannot be resolved falls back to the agent's
 * ceiling; an UNREADABLE taint (`UNKNOWN_TURN_TAINT`, a marker and
 * not a scope) falls back to the ceiling rather than writing the marker into a
 * message row; unreadable stamps do the same; and a non-empty taint with NO
 * stamps at all (a key written by an older build) falls back to the ceiling
 * too, because a shorter set is the one thing that must never be guessed.
 * A MISSING set for a turn younger than the window is not an empty one (fix8
 * M2): every turn opens it, so missing means lost or expired; the day-long
 * ledger answers when it holds anything, the effective-scope bound when not.
 */
export async function localReplyScope(
  orgId: string,
  threadId: string,
  holderUserId: string,
  ceiling: string[],
  agentId: string,
  turnStartedAt: Date | null,
  runtime: "local" | "node" = "local",
): Promise<string[]> {
  const log = rootLogger.child({ module: "local-session" })
  const project = (scopes: readonly string[]) =>
    projectTaintScopesForOrg([...new Set(scopes)], orgId).sort()

  // The fallback bound, computed only when something cannot be read.
  const effectiveScope = async (): Promise<string[]> => {
    try {
      const { effectiveScope } = await withPrivilegedDb(orgId, "local-reply-scope", (tx) =>
        computeEffectiveScopeForTurn(tx, orgId, threadId, holderUserId, ceiling),
      )
      return effectiveScope
    } catch (err) {
      log.warn({ err, threadId }, "Local reply effective scope failed, tagging with the ceiling")
      return ceiling
    }
  }

  // What Liaison handed this turn besides its tool calls: the definition and the
  // conversation (local-context-scopes.ts). Unreadable, the old conservative bound.
  const context =
    (await localContextScopes({ orgId, threadId, holderUserId, agentId, runtime })) ??
    (await effectiveScope())

  const withCeiling = async () => project([...context, ...(await effectiveScope()), ...ceiling])

  let taint: string[] = []
  let marks: Map<string, number> | null = null
  let present = true
  try {
    taint = await loadConnectionTurnTaint(orgId, agentId)
    marks = await loadConnectionTaintMarks(orgId, agentId)
    present = await connectionTurnTaintPresent(orgId, agentId)
  } catch (err) {
    log.warn({ err, threadId }, "Local reply MCP taint read failed, tagging with the ceiling")
    return withCeiling()
  }
  if (taint.some((scope) => UNKNOWN_TURN_TAINT.includes(scope))) return withCeiling()
  // A turn that cannot be dated cannot tell what of its reads the window has
  // already dropped: the conservative bound stands in for them.
  if (turnStartedAt === null) return project([...context, ...(await effectiveScope()), ...taint])

  // A turn older than the window may have read something the window has since
  // dropped: the day-long ledger keeps when each scope was last read
  // (`mcpTurnTaintLedgerKey`). Older than the ledger, the conservative bound.
  const since = turnStartedAt.getTime()
  const age = Date.now() - since
  let fromLedger: string[] = []
  if (age >= MCP_ACCESS_TOKEN_TTL_SECONDS * 1000) {
    if (age >= MCP_TAINT_LEDGER_TTL_SECONDS * 1000) {
      return project([...context, ...(await effectiveScope()), ...taint])
    }
    let ledger: Map<string, number> | null
    try {
      ledger = await loadConnectionTaintLedger(orgId, agentId)
    } catch (err) {
      log.warn({ err, threadId }, "Local reply taint ledger read failed, tagging with the ceiling")
      return withCeiling()
    }
    if (ledger === null) return withCeiling()
    fromLedger = [...ledger].filter(([, at]) => at >= since).map(([scope]) => scope)
  } else if (!present) {
    // NO SET for a turn younger than the window (fix8 M2). The turn opened it
    // (`openConnectionTurnTaint`), so it either expired under the turn (a set
    // an earlier read made, whose window ran out: that read is in the
    // day-long ledger) or it was lost. A ledger with entries answers exactly;
    // an empty one means the state is gone: the conservative bound, never `[]`.
    let ledger: Map<string, number> | null
    try {
      ledger = await loadConnectionTaintLedger(orgId, agentId)
    } catch (err) {
      log.warn({ err, threadId }, "Local reply taint ledger read failed, tagging with the ceiling")
      return withCeiling()
    }
    if (ledger === null) return withCeiling()
    if (ledger.size === 0) {
      log.warn({ threadId, agentId }, "Local reply taint set missing, tagging with the bound")
      return project([...context, ...(await effectiveScope())])
    }
    return project([
      ...context,
      ...[...ledger].filter(([, at]) => at >= since).map(([scope]) => scope),
    ])
  }

  if (taint.length === 0) return project([...context, ...fromLedger])
  if (marks === null) return withCeiling()
  if (marks.size === 0) return withCeiling()

  // A scope the set carries and the stamps do not is undatable, so it counts:
  // dropping it would be the shorter set this function never guesses at.
  const thisTurn = taint.filter((scope) => (marks.get(scope) ?? since) >= since)
  return project([...context, ...thisTurn, ...fromLedger])
}

/**
 * When the turn this reply ends BEGAN, as the server stamped it: the latest
 * turn event this session posted, or the session's own start when it has
 * posted none yet. `null` when the trail holds neither, which a caller reads
 * as "cannot date this turn" and falls back to the whole taint.
 *
 * The audit trail is the only record a local session leaves, and it is written
 * by the server with the server's clock: a client cannot backdate one, and a
 * client that posts no turn event gets the session start, which is earlier and
 * therefore never narrows the tag.
 */
async function localTurnStartedAt(orgId: string, sessionId: string): Promise<Date | null> {
  const rows = await withPrivilegedDb(orgId, "local-reply-turn-start", (tx) =>
    tx
      .select({ timestamp: auditLog.timestamp, action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.entityType, "agent_local_session"),
          eq(auditLog.entityId, sessionId),
          or(eq(auditLog.action, LOCAL_SESSION_TURN), eq(auditLog.action, LOCAL_SESSION_START)),
        ),
      )
      .orderBy(desc(auditLog.timestamp)),
  )
  const turn = rows.find((r) => r.action === LOCAL_SESSION_TURN)
  const start = rows.find((r) => r.action === LOCAL_SESSION_START)
  return turn?.timestamp ?? start?.timestamp ?? null
}

/**
 * The agent a conversation may be claimed FOR: the mentionable listing's own
 * predicate (A31), which is the set of agents this caller could have addressed
 * in that room anyway. Same org is not enough: a `kind='system'` agent and an
 * archived one are nobody's to run, and answering differently for them would
 * make the route say which is which.
 */
async function requireClaimableAgent(
  orgId: string,
  userId: string,
  agentId: string,
): Promise<string> {
  const id = await requireOwnAgent(orgId, agentId)
  if (!(await isMentionableAgent(orgId, userId, id))) {
    throw new HTTPException(403, { message: "this agent is not yours to run" })
  }
  return id
}

localSessionRoutes.post("/:agentId/local-sessions", zValidator("json", startSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const agentId = await requireClaimableAgent(orgId, userId, c.req.param("agentId"))
  const body = c.req.valid("json")
  // The server names the session, not the client: an id the desktop chose
  // could collide with another machine's and merge two users' trails.
  const sessionId = crypto.randomUUID()
  // fix8 M2: the session's turns are tagged from a set that exists.
  await openConnectionTurnTaint(orgId, agentId)
  await withPrivilegedDb(orgId, "local-session-start", (tx) =>
    writeAuditLog(tx, {
      orgId,
      actorId: userId,
      actorType: "user",
      app: "kernel",
      entityType: "agent_local_session",
      entityId: sessionId,
      action: LOCAL_SESSION_START,
      agentId,
      metadata: {
        sessionId,
        runLocation: RUN_LOCATION_LOCAL,
        permissionMode: body.permissionMode,
        model: body.model,
        folderHash: body.folderHash,
        resumed: body.resumeSessionId !== undefined,
        ...(body.freshReason ? { freshReason: body.freshReason } : {}),
      },
    }),
  )
  return success(c, { sessionId }, undefined, 201)
})

localSessionRoutes.post(
  "/:agentId/local-sessions/:sessionId/events",
  zValidator("param", sessionIdParam),
  zValidator("json", eventSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const agentId = await requireClaimableAgent(orgId, userId, c.req.param("agentId"))
    const sessionId = c.req.param("sessionId")
    const body = c.req.valid("json")
    // fix8 M2: a turn opens the agent's taint set, so a missing one at the
    // reply is a lost one.
    if (body.kind === "turn") await openConnectionTurnTaint(orgId, agentId)
    if (body.kind === "turn" && body.threadId) {
      const threadId = body.threadId
      const actor = extractRlsContext(c)
      // NOT AWAITED: the prompt is already running on the user's machine and
      // the advance can call a model; the desktop is not kept waiting for it.
      void (async () => {
        const claimed = await withSystemDb("local-turn-upkeep-claim", (tx) =>
          liveLocalClaims(tx, { orgId, threadId }),
        )
        if (claimed.get(agentId)?.userId !== userId) return
        await betweenTurnsUpkeep({ agentId, threadId, orgId, actor })
      })().catch((err) =>
        rootLogger
          .child({ module: "local-session" })
          .error({ err, threadId }, "Local turn upkeep failed"),
      )
    }
    await withPrivilegedDb(orgId, "local-session-event", (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "kernel",
        entityType: "agent_local_session",
        entityId: sessionId,
        action: body.kind === "turn" ? LOCAL_SESSION_TURN : LOCAL_SESSION_END,
        agentId,
        metadata: {
          sessionId,
          runLocation: RUN_LOCATION_LOCAL,
          ...(body.promptChecksum ? { promptChecksum: body.promptChecksum } : {}),
          ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
        },
      }),
    )
    return c.body(null, 204)
  },
)

// ---------------------------------------------------------------------------
// THE LOCAL CLAIM (A32)
//
// A local session's input is the conversation it was started from, so while the
// desktop is answering there the server must not also answer. The claim is a
// LEASE with a short TTL that only the holding window renews: a laptop that
// sleeps releases it by doing nothing, and the conversation goes back to being
// answered by the server rather than by nobody. Register and heartbeat are the
// same call, because they are the same act.
// ---------------------------------------------------------------------------

/** How long one registration is honoured without a heartbeat. */
export const LOCAL_CLAIM_TTL_SECONDS = 60

/** A claim was taken on a conversation that had none. */
export const LOCAL_CLAIM_REGISTERED = "agent.local_claim.registered"
/** Another machine took a live claim over, on purpose and in the open. */
export const LOCAL_CLAIM_TAKEN_OVER = "agent.local_claim.taken_over"
/** The holder gave the conversation back to the server. */
export const LOCAL_CLAIM_RELEASED = "agent.local_claim.released"

/**
 * WHO HOLDS A CLAIM: the user AND the window that registered it.
 *
 * `holderKey` is minted by the window and opaque here. It exists because
 * `userId` cannot tell two windows of one person apart, and two windows both
 * pushing one lease is two machines answering one conversation.
 */
const holderKey = z.string().min(8).max(200)

const claimSchema = z.object({
  threadId: z.string().uuid(),
  holderKey,
  /**
   * Take a LIVE claim away from whoever holds it. Never implicit: a silent
   * takeover is how one human message ends up answered by two machines, and it
   * is the state the lease exists to make impossible. Audited when used.
   */
  takeOver: z.boolean().optional(),
  /**
   * THIS CALL IS A REGISTRATION, not a heartbeat. Only a registration may
   * supersede a live claim of the same install (`installOf`): a heartbeat from
   * the instance that was superseded must lose, or a relaunch and the ghost
   * of the previous instance would take the lease back and forth.
   */
  register: z.boolean().optional(),
})

/**
 * WHICH INSTALL a holder key names, or null (2026-09-23).
 *
 * A desktop key reads `d.<install>.<window>`: the install part is a digest the
 * app derives from its own install salt (never the salt itself), the window
 * part is minted per window. A key of any other shape (an older desktop, a
 * test) names no install and never supersedes anything.
 *
 * Why the install matters: an app that is quit has its sidecar killed and
 * often sends no release, so the relaunched app found its own previous lease
 * live for up to a minute and was told another machine held the conversation.
 * The same user on the same install IS that machine, and the previous instance
 * is gone: its lease is superseded at once. No column is needed for it, the
 * install is inside the key the row already stores.
 */
const INSTALL_KEY = /^d\.([0-9a-f]{32})\.[A-Za-z0-9-]{8,}$/

export function installOf(key: string): string | null {
  return INSTALL_KEY.exec(key)?.[1] ?? null
}

/** The holder presenting itself on a call that is not the registration. */
const holderQuery = z.object({ holderKey })

localSessionRoutes.post("/:agentId/local-claims", zValidator("json", claimSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  // The MENTIONABLE predicate (A31), not org membership: a conversation is
  // claimed for an agent the caller could have addressed anyway. A system
  // agent, an archived one and another org's are all the same refusal.
  const agentId = await requireClaimableAgent(orgId, userId, c.req.param("agentId"))
  const { threadId, holderKey: holder, takeOver, register } = c.req.valid("json")
  // A REGISTRATION from the same user on the same install supersedes: the
  // instance holding the lease is this app's previous life (see `installOf`).
  const install = register ? installOf(holder) : null
  const expiresAt = new Date(Date.now() + LOCAL_CLAIM_TTL_SECONDS * 1000)
  const now = new Date()

  // THROUGH RLS, deliberately: the insert policy requires the claimant to be
  // in the room, so a member of the org cannot claim a conversation they
  // cannot see, and the route needs no membership check of its own.
  const outcome = await withRequestRls(c, async (tx) => {
    const [existing] = await tx
      .select({
        userId: agentLocalClaims.userId,
        holderKey: agentLocalClaims.holderKey,
        expiresAt: agentLocalClaims.expiresAt,
      })
      .from(agentLocalClaims)
      .where(and(eq(agentLocalClaims.threadId, threadId), eq(agentLocalClaims.agentId, agentId)))
      .limit(1)
    // THE GUARD IS THE STATEMENT, not this read: two windows registering at
    // once both pass the read and only one passes `setWhere`. The read says
    // which of register, heartbeat and takeover happened, for the audit row.
    const [claim] = await tx
      .insert(agentLocalClaims)
      .values({ orgId, threadId, agentId, userId, holderKey: holder, expiresAt })
      .onConflictDoUpdate({
        target: [agentLocalClaims.threadId, agentLocalClaims.agentId],
        set: { userId, holderKey: holder, expiresAt, updatedAt: now },
        // The holder renews its own lease; anybody else renews a DEAD one, or
        // says out loud that it is taking a live one over.
        setWhere: takeOver
          ? undefined
          : or(
              and(eq(agentLocalClaims.userId, userId), eq(agentLocalClaims.holderKey, holder)),
              lte(agentLocalClaims.expiresAt, sql`${now.toISOString()}::timestamptz`),
              // The install is 32 hex characters, so the pattern holds no
              // wildcard but its own trailing one.
              ...(install
                ? [
                    and(
                      eq(agentLocalClaims.userId, userId),
                      like(agentLocalClaims.holderKey, `d.${install}.%`),
                    ),
                  ]
                : []),
            ),
      })
      .returning({ id: agentLocalClaims.id, expiresAt: agentLocalClaims.expiresAt })
    return { existing, claim }
  })

  const live = outcome.existing && outcome.existing.expiresAt > now ? outcome.existing : null
  if (!outcome.claim) {
    // Somebody else's machine is answering this conversation right now. The
    // expiry is the useful half of the answer: it says how long the wait is,
    // and the alternative to waiting is an explicit takeover.
    if (live) {
      // WHOSE LEASE IT IS (P6d-FX7, SK-5). A window whose release never
      // reached the server argues with its OWN live claim on the next start,
      // and only this row can tell the two apart: the desktop knows the key it
      // presented and nothing about the row it lost to. Told "another machine
      // is running this conversation, stop it there", a user is sent to a
      // machine that does not exist, and the wait is the one thing the
      // sentence never mentioned.
      const heldByYou = live.userId === userId && live.holderKey === holder
      // WHO, when it is somebody else (2026-09-23). "Another machine" alone
      // sends a person looking for a computer: theirs (`sameUser`), or a
      // colleague's, named. The holder is a member of this room (the insert
      // policy requires it), so the name tells the caller nothing the room's
      // own member list does not.
      const sameUser = live.userId === userId
      const holderName = sameUser ? null : await holderDisplayName(live.userId)
      return c.json(
        {
          error: {
            message: heldByYou
              ? "this window's own claim on the conversation is still live"
              : "another machine is running this conversation",
            code: "claim_held",
            details: {
              expiresAt: live.expiresAt.toISOString(),
              heldByYou,
              sameUser,
              holderName,
              // An explicit, audited takeover is open to anybody who may
              // claim the conversation at all, which this caller just proved.
              canTakeOver: true,
            },
          },
        },
        409,
      )
    }
    throw new HTTPException(403, { message: "this conversation is not yours to claim" })
  }

  const isHeartbeat = live !== null && live.userId === userId && live.holderKey === holder
  // A new holder answers this conversation from now on: whatever turn the
  // previous holder was running loses its credential (S59).
  if (
    outcome.existing &&
    (outcome.existing.userId !== userId || outcome.existing.holderKey !== holder)
  ) {
    await revokeTurnCredentials({
      orgId,
      agentId,
      threadId,
      holderKey: outcome.existing.holderKey,
    })
  }
  if (!isHeartbeat) {
    // Registration and takeover are audited; a heartbeat is not. A row every
    // twenty seconds says nothing a reader of the trail wants, and the two
    // events that change WHO answers a conversation would drown in them.
    await withPrivilegedDb(orgId, "local-claim-registered", (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        action: live ? LOCAL_CLAIM_TAKEN_OVER : LOCAL_CLAIM_REGISTERED,
        agentId,
        metadata: {
          threadId,
          runLocation: RUN_LOCATION_LOCAL,
          ...(live ? { previousHolderUserId: live.userId } : {}),
          ...(live && !takeOver && install ? { sameDevice: true } : {}),
        },
      }),
    )
  }
  return success(c, { expiresAt: outcome.claim.expiresAt.toISOString() })
})

/** The holder's display name, or null when it cannot be read. */
async function holderDisplayName(holderUserId: string): Promise<string | null> {
  try {
    const [row] = await withSystemDb("local-claim-holder-name", (tx) =>
      tx.select({ name: users.name }).from(users).where(eq(users.id, holderUserId)).limit(1),
    )
    return row?.name ?? null
  } catch {
    return null
  }
}

localSessionRoutes.delete(
  "/:agentId/local-claims/:threadId",
  zValidator("query", holderQuery),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const agentId = await requireOwnAgent(orgId, c.req.param("agentId"))
    const threadId = c.req.param("threadId")
    const { holderKey: holder } = c.req.valid("query")
    const deleted = await withRequestRls(c, async (tx) => {
      const rows = await tx
        .delete(agentLocalClaims)
        .where(
          and(
            eq(agentLocalClaims.threadId, threadId),
            eq(agentLocalClaims.agentId, agentId),
            eq(agentLocalClaims.userId, userId),
            eq(agentLocalClaims.holderKey, holder),
          ),
        )
        .returning({ id: agentLocalClaims.id })
      if (rows.length > 0) return true
      // Nothing of this holder's was removed: either there was nothing (an
      // idempotent release) or the row belongs to somebody else's machine,
      // which is not this caller's to hand back.
      const [live] = await tx
        .select({ expiresAt: agentLocalClaims.expiresAt })
        .from(agentLocalClaims)
        .where(and(eq(agentLocalClaims.threadId, threadId), eq(agentLocalClaims.agentId, agentId)))
        .limit(1)
      if (live && live.expiresAt > new Date()) {
        throw new HTTPException(403, {
          message: "this conversation is held by another machine",
        })
      }
      return false
    })
    // S59 (D43 F6): the holder's turn credential never outlives its claim.
    await revokeTurnCredentials({ orgId, agentId, threadId, holderKey: holder })
    if (deleted) {
      await withPrivilegedDb(orgId, "local-claim-released", (tx) =>
        writeAuditLog(tx, {
          orgId,
          actorId: userId,
          actorType: "user",
          app: "kernel",
          entityType: "thread",
          entityId: threadId,
          action: LOCAL_CLAIM_RELEASED,
          agentId,
          metadata: { threadId, runLocation: RUN_LOCATION_LOCAL },
        }),
      )
    }
    // 204 whether or not a row was there: a release is idempotent by nature (the
    // window sends one on session end AND on close), and a claim that already
    // lapsed is exactly the state the caller asked for.
    return c.body(null, 204)
  },
)

/**
 * THE TURN CREDENTIAL, minted on the desktop's re-read of the message it is
 * about to run (S59, A34; `turn-credential.ts`). Only when every one holds,
 * otherwise the read answers exactly what it always did:
 * - the person reading wrote the message (`user`, their own);
 * - they hold the live claim on this conversation for this agent, from the
 *   window that presents `holderKey` (as the reply route checks);
 * - the message is unanswered: no agent message points at it, this agent has
 *   not posted since, and no later message of a person made it an earlier turn.
 */
async function mintForLocalTurn(input: {
  orgId: string
  userId: string
  agentId: string
  threadId: string
  holderKey: string
  restricted: boolean
  message: {
    id: string
    authorType: string
    authorId: string
    replyRootId: string | null
  }
}): Promise<string | null> {
  const { orgId, userId, agentId, threadId, message } = input
  if (message.authorType !== "user" || message.authorId !== userId) return null
  const claimed = await withSystemDb("local-turn-credential-claim", (tx) =>
    liveLocalClaims(tx, { orgId, threadId }),
  )
  const claim = claimed.get(agentId)
  if (!claim || claim.userId !== userId || claim.holderKey !== input.holderKey) return null
  // Compared in the database, at its own precision: a JavaScript Date drops the
  // microseconds, and the message would then count as written after itself.
  const later = await withSystemDb("local-turn-credential-unanswered", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(sql`
        SELECT m.id FROM ${K()}.messages m, ${K()}.messages asked
         WHERE asked.id = ${message.id}
           AND m.org_id = ${orgId} AND m.thread_id = ${threadId} AND m.id <> asked.id
           AND m.deleted_at IS NULL
           AND (
             -- an agent's answer to it
             (m.author_type = 'agent' AND m.parent_message_id = asked.id)
             -- this agent spoke after it (a local reply carries no parent link)
             OR (m.author_agent_id = ${agentId} AND m.created_at >= asked.created_at)
             -- a person wrote after it: the conversation's current turn is a later one
             OR (m.author_type = 'user' AND m.created_at > asked.created_at)
           )
         LIMIT 1`),
    ),
  )
  if (later.length > 0) return null
  return mintTurnCredential({
    orgId,
    userId,
    agentId,
    threadId,
    messageId: message.id,
    replyRootId: message.replyRootId ?? null,
    holderKey: input.holderKey,
    restricted: input.restricted,
  })
}

/**
 * THE MESSAGE, AS THE DATABASE HAS IT (A32).
 *
 * The shell learns that a message arrived from a DOM event this app publishes
 * (`desktop-shell-contract.ts`). An event is a fact about the page, not a fact
 * about the conversation: anything that can put HTML or a script into apps/web
 * can dispatch one, and the shell would run its text as a prompt through the
 * user's own Claude Code login, in whatever permission mode the session is in.
 *
 * So the event is a NOTIFICATION and this is the source: the shell fetches the
 * message by id with its agent bound token and runs what comes back, which is
 * what the room actually holds. A forged id reads somebody else's message or
 * nothing at all, and forged text is simply not what runs.
 *
 * Gated by thread membership through RLS, like every other read of a message:
 * a claim is not what makes a conversation readable, being in it is.
 */
localSessionRoutes.get(
  "/:agentId/local-claims/:threadId/messages/:messageId",
  zValidator(
    "param",
    z.object({
      agentId: z.string().uuid(),
      threadId: z.string().uuid(),
      messageId: z.string().uuid(),
    }),
  ),
  zValidator("query", z.object({ holderKey: holderKey.optional() })),
  async (c) => {
    const orgId = c.get("orgId")
    const agentId = await requireOwnAgent(orgId, c.req.param("agentId"))
    const { threadId, messageId } = c.req.valid("param")
    const { holderKey: holder } = c.req.valid("query")
    const [message] = await withRequestRls(c, (tx) =>
      tx
        .select({
          id: messages.id,
          threadId: messages.threadId,
          authorType: messages.authorType,
          authorId: messages.authorId,
          content: messages.content,
          deletedAt: messages.deletedAt,
          replyRootId: messages.replyRootId,
          requiredScopes: messages.requiredScopes,
          disclosureList: messages.disclosureList,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
        .limit(1),
    )
    // A message of another conversation is a 404 here rather than a 403: the
    // route answers about ONE conversation, and saying "that id exists but not
    // here" is more than the caller asked.
    if (!message || message.threadId !== threadId || message.deletedAt) {
      throw new HTTPException(404, { message: "no such message in this conversation" })
    }
    // RLS answers for the CALLER; the session answers the ROOM. A message the
    // room floor does not cover is not what this turn runs, same answer.
    const viewer = await requireRoomBoundViewer(c, threadId, agentId)
    if (
      !isMessageVisible(
        { requiredScopes: message.requiredScopes ?? [], disclosureList: message.disclosureList },
        viewer,
      )
    ) {
      throw new HTTPException(404, { message: "no such message in this conversation" })
    }
    const turnCredential = holder
      ? await mintForLocalTurn({
          orgId,
          userId: c.get("userId"),
          agentId,
          threadId,
          holderKey: holder,
          restricted: c.get("sessionRestricted") === true,
          message,
        })
      : null
    return success(c, {
      id: message.id,
      threadId: message.threadId,
      authorKind: message.authorType,
      text: message.content,
      // A7: the reply thread the message was asked in, so the local answer
      // lands there (the reply route's `replyRootId`); null in the channel.
      replyRootId: message.replyRootId ?? null,
      ...(turnCredential ? { turnCredential } : {}),
    })
  },
)

/**
 * THE COLD DECISION, BEFORE THE LOCAL SESSION EXISTS (P4c-E1).
 *
 * A turn more than the warm window after this agent's last one is not
 * continuing a conversation, it is picking one up, and the server reassembles
 * the context accordingly (`coldResumeAdvanceForTurn`, P4c-T23). A desktop
 * session that RESUMES its old SDK conversation on such a turn hands the model
 * the raw transcript the server just decided to stop using: two different
 * contexts for one rule.
 *
 * The rule belongs to the server, because only the server can see the rows it
 * is measured from, so the desktop ASKS rather than guessing from anything it
 * happens to hold. It runs the SAME cold advance a cloud turn runs
 * (`coldResumeAdvanceForTurn`), so the checkpoint sits at the cold boundary
 * before anything is rendered and the two paths cannot drift.
 *
 * AND THE CONTEXT ITSELF (P4c-T26b). Knowing the turn is cold is only half of
 * parity: a fresh SDK session that is told nothing starts from nothing, which
 * is strictly worse than the stale transcript it replaced. So a cold answer
 * carries what the cloud path assembles for the same turn: the checkpoint
 * summary (the T24 brief core plus its episode titles), the cold tail after
 * `coldTailBoundaryIndex` with the retrieval tool parts stripped (A50), the
 * cold hybrid recall block (T25), and the resume line. Every one of them comes
 * from the function the cloud path calls; nothing here restates a rule.
 *
 * A WARM ANSWER IS `{ coldResume: false }` AND NOTHING ELSE, which is also
 * exactly the shape P4c-T26 shipped: an older desktop reads the boolean it
 * already read and keeps working.
 *
 * A FRESH SESSION ON A WARM TURN (`?fresh=1`, 2026-09-23). The desktop also
 * starts a new SDK session when the agent's definition changed since its
 * stored session was created: resuming hands the model its old transcript,
 * and a wrong answer given under the old definition outvoted the fixed one.
 * Such a turn may be warm, so the time rule above answers no context at all.
 * With `fresh=1` a warm answer carries `fresh: true` and the context a WARM
 * cloud turn runs with: the current checkpoint and every row after it (the
 * bounded history, retrieval parts stripped), with no cold recall and no
 * resume line, because nothing was resumed after a gap. Nothing is advanced:
 * the time rule did not fire, and the checkpoint is shared with the cloud
 * path. An older desktop never sends the flag and reads the same answer as
 * before.
 *
 * Read-only apart from that advance, and gated by thread membership through
 * RLS, like the message read above: a claim is not what makes a conversation
 * readable, being in it is.
 */
localSessionRoutes.get(
  "/:agentId/local-claims/:threadId/turn-context",
  zValidator("param", z.object({ agentId: z.string().uuid(), threadId: z.string().uuid() })),
  zValidator(
    "query",
    z.object({ fresh: z.enum(["1"]).optional(), continuity: z.enum(["1"]).optional() }),
  ),
  async (c) => {
    const orgId = c.get("orgId")
    const agentId = await requireOwnAgent(orgId, c.req.param("agentId"))
    const { threadId } = c.req.valid("param")
    const { fresh, continuity } = c.req.valid("query")
    const actor = extractRlsContext(c)
    // THE ADVANCE FIRST, exactly as a cloud turn does it: the checkpoint has to
    // sit at the cold boundary before the tail below is cut from it, or the
    // desktop is handed a summary of one boundary and a tail of another. A
    // routine tick is not a local turn and never reaches this route.
    const decision = await coldResumeAdvanceForTurn({ agentId, threadId, orgId, actor })
    // WHO ANSWERED LAST, for a desktop deciding whether its stored SDK session
    // still IS this conversation (2026-09-23). A cloud turn, another computer's
    // session or another conversation's session in the same folder all mean the
    // transcript it would resume is missing turns the thread holds, and it
    // starts fresh on the server's history instead. Only on request: the bare
    // warm answer stays `{ coldResume: false }` for everything else.
    if (!decision.cold && fresh !== "1") {
      if (continuity !== "1") return success(c, { coldResume: false })
      return success(c, {
        coldResume: false,
        lastAgentTurn: await lastAgentTurnOf(c, threadId, agentId),
      })
    }
    // EVERYTHING BELOW IS CONTENT, read through the turn's viewer: the room
    // floor ∩ the agent's ceiling ∩ the caller's grants, the bound a cloud
    // turn's assembly applies (`contextViewer`). The rows come back under the
    // caller's RLS, which knows nothing about the other members of the room.
    const viewer = await requireRoomBoundViewer(c, threadId, agentId)
    const checkpointSummary = (cp: { summary: string; requiredScopes: string[] } | null) =>
      cp && isMessageVisible({ requiredScopes: cp.requiredScopes, disclosureList: null }, viewer)
        ? cp.summary
        : ""
    if (!decision.cold) {
      const warm = await loadBoundedHistory({ threadId, orgId, actor, agentId })
      const warmRows = filterByVisibility(stripRetrievalToolParts(warm.messages), viewer)
      const warmNames = await tailAuthorNames(orgId, warmRows)
      return success(c, {
        coldResume: false,
        fresh: true,
        checkpoint: { summary: checkpointSummary(warm.checkpoint) },
        tail: warmRows.map((row) => tailRowOf(row, warmNames)),
        recall: null,
        resumeLine: null,
      })
    }

    const loaded = await loadBoundedHistory({ threadId, orgId, actor, agentId })
    const rows = filterByVisibility(stripRetrievalToolParts(loaded.messages), viewer)
    const tailRows = rows.slice(coldTailBoundaryIndex(rows, estimateTokens))
    const names = await tailAuthorNames(orgId, tailRows)
    // The message this turn answers, which is what the cold recall searches on,
    // same as the cloud assembly.
    const incoming = [...rows].reverse().find((m) => m.authorType === "user")
    const recall = await coldRecall({
      orgId,
      threadId,
      agentId,
      actor,
      // The cloud assembly recalls at `contextViewer.grants`, never the caller's own.
      scopes: viewer.grants,
      query: incoming?.content ?? "",
    })
    // The recall's hits depend on this moment, so the reply cannot recompute
    // them: keep their scopes for the stamp (local-context-scopes.ts). A row
    // that cannot be kept fails the route, and the desktop resumes warm.
    if (recall) {
      await recordLocalRecallScopes({
        orgId,
        threadId,
        agentId,
        userId: actor.userId,
        injectedScopes: recall.injectedScopes,
      })
    }
    return success(c, {
      coldResume: true,
      checkpoint: { summary: checkpointSummary(loaded.checkpoint) },
      tail: tailRows.map((row) => tailRowOf(row, names)),
      recall: recall?.text ?? null,
      // The SAME gap the advance measured, rather than a second measurement of
      // the same clock: two numbers for one turn is how they disagree.
      resumeLine:
        decision.sinceLastTurnSeconds === null
          ? null
          : resumeLine(decision.sinceLastTurnSeconds * 1000),
    })
  },
)

/** One tail row, as the desktop reads it. */
/**
 * The latest message this agent wrote in the conversation, as far as where it
 * ran: `local` with the SDK session that wrote it, or `cloud`. Read under the
 * caller's RLS, like the rest of this route. Null when the agent has not
 * answered here yet.
 */
async function lastAgentTurnOf(
  c: Parameters<typeof withRequestRls>[0],
  threadId: string,
  agentId: string,
): Promise<{ runLocation: "local" | "cloud"; sdkSessionId: string | null } | null> {
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.authorType, "agent"),
          eq(messages.authorAgentId, agentId),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1),
  )
  if (!row) return null
  const meta = (row.metadata ?? {}) as { runLocation?: unknown; localSdkSessionId?: unknown }
  return meta.runLocation === RUN_LOCATION_LOCAL
    ? {
        runLocation: "local",
        sdkSessionId: typeof meta.localSdkSessionId === "string" ? meta.localSdkSessionId : null,
      }
    : { runLocation: "cloud", sdkSessionId: null }
}

function tailRowOf(
  row: {
    id: string
    authorType: string
    createdAt: Date
    content: string | null
    metadata: unknown
  },
  names: Map<string, string>,
) {
  return {
    id: row.id,
    authorType: row.authorType,
    authorName: names.get(row.id) ?? null,
    createdAt: row.createdAt.toISOString(),
    content: row.content ?? "",
    // The tools this row CALLED, by name and never their results, exactly as
    // the cloud path's `convertRegion` names them. It is also what makes the
    // A50 strip observable from outside: a retrieval call that survived it
    // would show up here.
    toolNames: toolNamesOf(row.metadata),
  }
}

/** The tool names one stored row's metadata carries, if any. Names only. */
function toolNamesOf(metadata: unknown): string[] {
  const meta = metadata as { toolCalls?: Array<{ toolName?: string }> } | null
  if (!meta || !Array.isArray(meta.toolCalls)) return []
  return meta.toolCalls.map((tc) => String(tc?.toolName ?? "")).filter((n) => n.length > 0)
}

/**
 * WHO SAID EACH ROW, by id. The `messages` row names an author id and an agent
 * id but no name, and a transcript whose every line reads "user" is a
 * transcript the model cannot attribute. Two reads, both keyed by ids the
 * caller may already read: this route's rows came back through RLS.
 */
async function tailAuthorNames(
  orgId: string,
  rows: Array<{ id: string; authorId: string | null; authorAgentId: string | null }>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (rows.length === 0) return names
  const userIds = [...new Set(rows.map((r) => r.authorId).filter((v): v is string => v !== null))]
  const agentIds = [
    ...new Set(rows.map((r) => r.authorAgentId).filter((v): v is string => v !== null)),
  ]
  const [userRows, agentRows] = await withSystemDb("local-cold-context-authors", async (tx) => [
    userIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds)),
    agentIds.length === 0
      ? []
      : await tx
          .select({ id: agents.id, name: agents.displayName })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds))),
  ])
  const byUser = new Map(userRows.map((r) => [r.id, r.name]))
  const byAgent = new Map(agentRows.map((r) => [r.id, r.name]))
  for (const row of rows) {
    // The AGENT wins on an agent-authored row: `author_id` there is the human
    // whose turn it answered, not who spoke.
    const name =
      (row.authorAgentId ? byAgent.get(row.authorAgentId) : undefined) ??
      (row.authorId ? byUser.get(row.authorId) : undefined)
    if (name) names.set(row.id, name)
  }
  return names
}

/**
 * THE AGENT'S ANSWER, from a turn that ran on the user's machine.
 *
 * It goes through `sendMessage`'s own agent-authored path, so the row is the row
 * a cloud turn would have written: the agent as author, the same thread, the
 * same websocket frame to everyone in the room. Only the audit row differs, and
 * only in saying where the turn ran.
 *
 * It is refused unless a LIVE CLAIM for this agent on this thread exists. The
 * claim is what stopped the server answering; without one the server IS
 * answering, and accepting a reply here would post the second of two.
 */
const replySchema = z.object({
  threadId: z.string().uuid(),
  /**
   * Every text the turn produced, in order (a cloud turn's text is the same
   * accumulation). Empty only for a turn that has a record: a turn that called
   * tools and never answered is stored with an explicit line, as a cloud turn
   * that ends without text is.
   */
  text: z.string().max(100_000),
  /**
   * WHAT THE TURN DID, in the shape a cloud turn stores it
   * (`@liaison/shared` `LocalTurnRecord`): tool calls, timeline, reasoning,
   * usage and model. Loosely typed on purpose: the server never stores what
   * the client sent, it stores `sanitizeLocalTurnRecord` of it, which checks
   * every field, bounds it and redacts every free text again. Absent from an
   * older desktop, whose reply is stored with no activity, as before.
   */
  turn: z.record(z.string(), z.unknown()).optional(),
  /**
   * The reply thread the answered message was posted in (0112, A7): the local
   * answer lands there, as a cloud turn's does. Checked by the write path (a
   * root of this thread the holder can read, not itself a reply). Absent from
   * a desktop that does not send it: the answer goes to the channel.
   */
  replyRootId: z.string().uuid().optional(),
  /**
   * WHICH MACHINE is answering. The claim is what stopped the server, and the
   * holder of that claim is the only party whose answer is the one the room is
   * waiting for: without this, any member of the room could post as the agent
   * by borrowing somebody else's lease.
   */
  holderKey,
})

localSessionRoutes.post(
  "/:agentId/local-sessions/:sessionId/reply",
  zValidator("param", sessionIdParam),
  zValidator("json", replySchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const agent = await loadOwnAgent(orgId, c.req.param("agentId"))
    const agentId = agent.id
    const sessionId = c.req.param("sessionId")
    const { threadId, text, holderKey: holder, turn: rawTurn, replyRootId } = c.req.valid("json")
    if (!text.trim() && !rawTurn) {
      throw new HTTPException(400, { message: "a reply carries text or the turn it ends" })
    }

    const claimed = await withSystemDb("local-reply-claim-check", (tx) =>
      liveLocalClaims(tx, { orgId, threadId }),
    )
    const claim = claimed.get(agentId)
    if (!claim) {
      throw new HTTPException(409, {
        message: "this conversation is not claimed for a local session by that agent",
      })
    }
    // A CLAIM BELONGS TO ITS HOLDER. Another member of the room (or another
    // window of the same person) presenting an answer here is posting as the
    // agent on a turn it did not run.
    if (claim.userId !== userId || claim.holderKey !== holder) {
      throw new HTTPException(403, {
        message: "another machine is running this conversation",
      })
    }

    const requiredScopes = await localReplyScope(
      orgId,
      threadId,
      userId,
      agent.scopeCeiling,
      agentId,
      await localTurnStartedAt(orgId, sessionId),
    )
    // THE SAME ROW A CLOUD TURN WRITES (2026-09-23). Through the one
    // persistence path (`persist-agent-turn.ts`), with the metadata in the
    // cloud's keys, so the thread view draws the activity, the next turn's
    // history replays the tool calls, the checkpoint budget counts them and
    // the compaction trigger reads the usage, wherever the turn ran.
    const record = rawTurn ? sanitizeLocalTurnRecord(rawTurn) : null
    const content = text.trim()
      ? text
      : // A cloud turn that ends with no text stores an explicit line, never a
        // blank bubble (`agent-service.ts` finalize); so does a local one.
        record?.finishReason === "error"
        ? LOCAL_TURN_FAILED_LINE
        : LOCAL_TURN_NO_TEXT_LINE
    const metadata: Record<string, unknown> = {
      runLocation: RUN_LOCATION_LOCAL,
      localSessionId: sessionId,
      // The SDK session that ran it: the next local start resumes only the
      // session that wrote the conversation's last agent turn.
      ...(record?.sdkSessionId ? { localSdkSessionId: record.sdkSessionId } : {}),
      ...(record
        ? {
            modelId: record.modelId ?? undefined,
            toolCalls: record.toolCalls.length > 0 ? record.toolCalls : undefined,
            stepCount: record.stepCount,
            usage: record.usage,
            reasoning: record.reasoning || undefined,
            timeline: record.timeline.length > 0 ? record.timeline : undefined,
            finishReason: record.finishReason,
          }
        : {}),
    }
    const sent = await persistAgentTurn({
      // The reply of the turn that ran on the person's machine ends it.
      endsTurn: true,
      write: (fn) => withRequestRls(c, (tx) => fn(tx)),
      orgId,
      userId,
      threadId,
      content,
      agentId,
      agentAuthorLabel: agent.displayName,
      // The turn's effective scope, not an empty assertion: see
      // `localReplyScope` above. Never taken from the client.
      requiredScopes,
      metadata,
      // A7: the answer lands in the reply thread it was asked in.
      replyRootId: replyRootId ?? null,
    })
    if (!sent) {
      throw new HTTPException(403, { message: "this conversation is not yours to post in" })
    }

    await withPrivilegedDb(orgId, "local-session-reply", (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "agent",
        app: "kernel",
        entityType: "message",
        entityId: sent.id,
        action: LOCAL_SESSION_REPLY,
        agentId,
        metadata: { sessionId, threadId, runLocation: RUN_LOCATION_LOCAL },
      }),
    )
    // The turn is over: its credential answers nothing any more (S59).
    await revokeTurnCredentials({ orgId, agentId, threadId, holderKey: holder })
    return success(c, { messageId: sent.id }, undefined, 201)
  },
)
