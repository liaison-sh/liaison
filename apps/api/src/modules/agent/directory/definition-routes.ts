// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The composition API (spec-runtime.md): what a desktop client fetches before
// starting a local SDK session, composed by the SAME function the in-app turn
// goes through, so a Local-model session and a Liaison-model session get the
// same definition (S14).
import {
  AGENT_AVATAR_COLOR_COUNT,
  agentAvatarColorSchema,
  classifyConversation,
} from "@liaison/shared"
import { and, count, desc, eq, gt, ilike, inArray, isNull, lt, max, or, sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agentKnowledgePointers } from "~/db/schema/kernel/agent-knowledge-pointers"
import { agentLocalClaims } from "~/db/schema/kernel/agent-local-claims"
import { agentMemory } from "~/db/schema/kernel/agent-memory"
import { type Agent, agents } from "~/db/schema/kernel/agents"
import { auditLog } from "~/db/schema/kernel/audit-log"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { messages, threadParticipants, threadReferences, threads } from "~/db/schema/kernel/threads"
import { users } from "~/db/schema/kernel/users"
import { deleteObject, putObject } from "~/infra/storage/object-storage"
import { success } from "~/lib/response"
import { UUID_RE } from "~/lib/uuid"
import { requireScope } from "~/middleware/require-scope"
import {
  capabilityCategories,
  composeAgentDefinition,
  deriveAgentPurpose,
  fullAgentPurpose,
  UnknownAgentError,
} from "~/modules/agent/context/context"
import {
  ArchiveBlockedError,
  ArchiveCrossOrgError,
  ArchiveForbiddenError,
  archiveAgent,
  BASE_AGENT_HANDLE,
  BaseAgentNotArchivableError,
  checkArchiveBlockers,
} from "~/modules/agent/directory/archive"
import { pickAgentAvatarColor } from "~/modules/agent/directory/avatar-color"
import { listDirectoryAgents, listMentionableAgents } from "~/modules/agent/directory/listing"
import { personalCeiling } from "~/modules/agent/directory/personal-agent"
import { roomBoundViewer } from "~/modules/agent/local-sessions/local-session-routes"
import { pathForRow } from "~/modules/agent/memory/memory-tree"
import { RoomFloorError } from "~/modules/agent/scopes/room-floor"
import { isScopeSubset } from "~/modules/agent/subruns/sub-agent-definitions"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { isDmShapedThread } from "~/modules/threads/dm-shape"
import {
  AVATAR_STORED_MIME,
  MAX_AVATAR_UPLOAD_BYTES,
  normalizeAvatar,
  validateAvatarBytes,
} from "~/modules/users/avatar-image"
import { avatarPublicUrl, avatarStorageKey } from "~/modules/users/avatar-service"
import { filterByVisibility } from "~/services/security/visibility"

export const definitionRoutes = new Hono<AppEnv>()

/** One room an agent sits in, as the agent page and the directory card name it. */
interface AgentChannel {
  id: string
  handle: string
  name: string
}

/**
 * The caller's OWN actor, with their real scopes and dimension grants, so
 * every read below is the read RLS would allow them anywhere else. The
 * listing's own context carries no scopes because an agent row needs none;
 * the counts do (skills, routines and memory are scope-gated), and inventing
 * a wider actor for them would report rows the viewer may not see.
 */
function callerActor(c: Context<AppEnv>): UserContext {
  return {
    actorType: "user",
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    scopes: (c.get("scopes") as string[]) ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
    roles: c.get("roles") ?? [],
  }
}

/**
 * The rooms these agents sit in, per agent, as THIS viewer may see them.
 *
 * Two reads because the disclosure rule is two-branched and already written
 * down in `threads_select` (0077): a member sees a thread they are in, and
 * any member sees a DISCOVERABLE one. The first branch is the RLS read, which
 * also hides the agent's participant row for a thread the viewer is not in
 * (`tp_select` is membership-gated). The second branch cannot come from that
 * read for exactly that reason, so it is a privileged read pinned to
 * `discoverable = true` in this org: it discloses nothing `threads_select`
 * would not already hand the same caller.
 *
 * A CHANNEL IS NOT A DM (P4c-T32 fix). A thread this viewer shares with the
 * agent one-to-one is a conversation, never a room in the roster: it is
 * excluded with `isDmShapedThread` (`modules/threads/dm-shape.ts`), the same
 * predicate the push fanout uses, so the agent page and the push rule cannot
 * disagree about what counts as a room. The shape is a property of the ROOM,
 * not of what this viewer alone can see in it, so the seat counts and
 * reference count behind it are read privileged.
 */
async function readAgentChannels(
  actor: UserContext,
  agentIds: string[],
): Promise<Map<string, AgentChannel[]>> {
  const byAgent = new Map<string, AgentChannel[]>()
  if (agentIds.length === 0) return byAgent
  const fields = {
    agentId: threadParticipants.agentId,
    id: threads.id,
    handle: threads.handle,
    title: threads.title,
    type: threads.type,
    isPinned: threads.isPinned,
    createdFrom: threads.createdFrom,
  }
  const mine = await withRlsContext(actor, (tx) =>
    tx
      .select(fields)
      .from(threadParticipants)
      .innerJoin(threads, eq(threads.id, threadParticipants.threadId))
      .where(
        and(
          eq(threadParticipants.orgId, actor.orgId),
          eq(threadParticipants.participantType, "agent"),
          inArray(threadParticipants.agentId, agentIds),
        ),
      ),
  )
  const open = await withSystemDb("agent-page-discoverable-channels", (tx) =>
    tx
      .select(fields)
      .from(threadParticipants)
      .innerJoin(threads, eq(threads.id, threadParticipants.threadId))
      .where(
        and(
          eq(threads.orgId, actor.orgId),
          eq(threads.discoverable, true),
          eq(threadParticipants.participantType, "agent"),
          inArray(threadParticipants.agentId, agentIds),
        ),
      ),
  )
  const seen = new Set<string>()
  const candidates = new Map<
    string,
    {
      agentId: string
      id: string
      handle: string
      title: string | null
      type: string
      isPinned: boolean
      createdFrom: unknown
    }
  >()
  for (const row of [...mine, ...open]) {
    if (!row.agentId) continue
    const key = `${row.agentId}:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.set(key, {
      agentId: row.agentId,
      id: row.id,
      handle: row.handle,
      title: row.title,
      type: row.type,
      isPinned: row.isPinned,
      createdFrom: row.createdFrom,
    })
  }
  if (candidates.size === 0) return byAgent

  const threadIds = [...new Set([...candidates.values()].map((c) => c.id))]
  const seatRows = await withSystemDb("agent-page-channel-seats", (tx) =>
    tx
      .select({
        threadId: threadParticipants.threadId,
        userId: threadParticipants.userId,
        agentId: threadParticipants.agentId,
      })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.orgId, actor.orgId),
          inArray(threadParticipants.threadId, threadIds),
        ),
      ),
  )
  const seatsByThread = new Map<string, { humanCount: number; agentCount: number }>()
  for (const row of seatRows) {
    const cur = seatsByThread.get(row.threadId) ?? { humanCount: 0, agentCount: 0 }
    if (row.userId) cur.humanCount += 1
    if (row.agentId) cur.agentCount += 1
    seatsByThread.set(row.threadId, cur)
  }
  const refRows = await withSystemDb("agent-page-channel-refs", (tx) =>
    tx
      .select({ threadId: threadReferences.threadId, n: count() })
      .from(threadReferences)
      .where(
        and(eq(threadReferences.orgId, actor.orgId), inArray(threadReferences.threadId, threadIds)),
      )
      .groupBy(threadReferences.threadId),
  )
  const refsByThread = new Map(refRows.map((r) => [r.threadId, Number(r.n)]))

  for (const c of candidates.values()) {
    const seats = seatsByThread.get(c.id) ?? { humanCount: 0, agentCount: 0 }
    const isDm = isDmShapedThread({
      type: c.type,
      title: c.title,
      isPinned: c.isPinned,
      createdFrom: c.createdFrom,
      referenceCount: refsByThread.get(c.id) ?? 0,
      humanCount: seats.humanCount,
      agentCount: seats.agentCount,
    })
    if (isDm) continue
    // A35 rule 1: an `agent_chat` is a DM named by its agent, whatever its
    // title. `isDmShapedThread` answers the NARROWER
    // dedupe/fanout question and lets `agent_chat` through, so the Overview
    // listed every 1:1 chat as a channel called `thread-19`.
    if (c.type === "agent_chat") continue
    const list = byAgent.get(c.agentId) ?? []
    list.push({ id: c.id, handle: c.handle, name: c.title ?? c.handle })
    byAgent.set(c.agentId, list)
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.handle.localeCompare(b.handle))
  return byAgent
}

/**
 * Everything the Overview counts, read in one transaction under the caller's
 * own actor. `agent_memory` counts the CURRENT files only: supersession keeps
 * the old row, and counting it would report a tree twice the size of the one
 * the Memory tab renders.
 */
async function readAgentStats(actor: UserContext, agentId: string) {
  return withRlsContext(actor, async (tx) => {
    const [skillRow] = await tx
      .select({ n: count() })
      .from(skills)
      .where(and(eq(skills.orgId, actor.orgId), eq(skills.ownerAgentId, agentId)))
    const [routineRow] = await tx
      .select({ n: count() })
      .from(routines)
      .where(and(eq(routines.orgId, actor.orgId), eq(routines.ownerAgentId, agentId)))
    const [memoryRow] = await tx
      .select({ n: count() })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, actor.orgId),
          eq(agentMemory.ownerAgentId, agentId),
          isNull(agentMemory.supersededAt),
        ),
      )
    const [pointerRow] = await tx
      .select({ n: count() })
      .from(agentKnowledgePointers)
      .where(
        and(
          eq(agentKnowledgePointers.orgId, actor.orgId),
          eq(agentKnowledgePointers.agentId, agentId),
        ),
      )
    // RUN LOCATION (A32). A live lease on any conversation the viewer shares
    // with this agent means a desktop, not the server, is answering it there.
    // The claim policy is membership-gated on purpose, so this answers "where
    // does it run for YOU", never "whose laptop is awake".
    const claims = await tx
      .select({ id: agentLocalClaims.id })
      .from(agentLocalClaims)
      .where(
        and(
          eq(agentLocalClaims.orgId, actor.orgId),
          eq(agentLocalClaims.agentId, agentId),
          gt(agentLocalClaims.expiresAt, sql`now()`),
        ),
      )
      .limit(1)
    return {
      counts: {
        skills: skillRow?.n ?? 0,
        routines: routineRow?.n ?? 0,
        memoryFiles: memoryRow?.n ?? 0,
        knowledgePointers: pointerRow?.n ?? 0,
      },
      runsOn: claims.length > 0 ? ("local" as const) : ("liaison" as const),
    }
  })
}

/**
 * WHEN THIS AGENT LAST SPOKE, anywhere in its org.
 *
 * Deliberately NOT the caller's RLS read. `messages_select` stays
 * membership-gated even for a discoverable channel (0077), so the RLS answer
 * is "the last time it spoke somewhere you are", which reads as "never
 * active" on the page of a perfectly busy agent and changes meaning from one
 * colleague to the next. A single timestamp is envelope, not content: no
 * room, no author, no text, and the agent is one the caller may already
 * address.
 */
async function readLastActivityAt(orgId: string, agentId: string): Promise<Date | null> {
  const [row] = await withSystemDb("agent-page-last-activity", (tx) =>
    tx
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.authorAgentId, agentId))),
  )
  return row?.at ?? null
}

/**
 * `kernel.agents` has no lifecycle column of its own: a row is live or it
 * carries `archivedAt`. The live turn state the DM header shows (`Working`,
 * `Stuck`, `Failed`) is per conversation and arrives over the websocket; this
 * field is the agent's own state and nothing else.
 */
function agentState(row: Agent): "active" | "archived" {
  return row.archivedAt ? "archived" : "active"
}

/**
 * Identity comes from the SESSION and from nowhere else: there is no `asUser`,
 * no admin impersonation path, ever. A request that even names another user is
 * refused with 400 rather than quietly ignored, so the omission is enforced
 * instead of assumed: a client that believes it is fetching somebody else's
 * definition must be told it is not, not handed its own and left to think
 * otherwise.
 *
 * The gate is the MENTIONABLE LISTING's own predicate, not an admin scope: a
 * user may read the definition of any agent they can DM, which is exactly the
 * visibility the listing below already grants them. So the caller holds
 * `kernel:threads:read` (what the listing requires) and the agent must be one
 * `listMentionableAgents` would return for them: same org, live, not a
 * `kind='system'` agent. Anything the listing would not return is 404, never
 * 403, so the route is no more of an existence oracle than the listing is.
 * `kernel:agents:read` remains the ADMIN read and still answers everything
 * this route ever answered, unchanged.
 *
 * A PERSONAL AGENT SOMEBODY ELSE OWNS is composed for its owner and for an
 * admin holding `kernel:agents:read`, and for nobody else. That refusal used
 * to be a 403, because the listing itself disclosed that the agent existed;
 * since A41 narrowed the listing (`modules/agent/directory/listing.ts`) it no longer
 * does, so the refusal is the same 404 as any other unlisted agent and the
 * two answers cannot disagree about whose Liaison exists.
 *
 * An agent the caller's org does not own is 404, and so is an archived one:
 * archived reads as missing (the slice-wide rule), and the 404 never
 * distinguishes the two, so the route is not an existence oracle on another
 * org's agents.
 */
/**
 * The org's addressable agents: what the mention picker and the DM picker
 * offer (P4b-H3). Metadata only, the four fields a picker renders. The system
 * prompt, the ceiling and the skill bodies belong to the definition route
 * above, which is gated far harder for exactly that reason.
 *
 * Gated on `kernel:threads:read`, not `kernel:agents:read`: this is the roster
 * of who you can address in your own org, the same sensitivity as the member
 * directory, and every member needs it to mention anybody. `kernel:agents:read`
 * is the ADMIN read (prompts, ceilings) and ordinary members do not hold it.
 *
 * Agents carry no avatar of their own, so `avatarUrl` is always null today; it
 * is in the payload because every picker in the web client renders the same
 * participant shape and a missing key reads as a bug rather than as "no avatar".
 */
definitionRoutes.get("/", requireScope("kernel:threads:read"), async (c) => {
  // `@base` (P4c FX-F3): the `kind='system'` row is part of the DIRECTORY for
  // an admin, who is the only person with a reason to look at it, and for
  // nobody else. It is still absent from the DM picker and from mention
  // completion for everyone, admin included: those call the addressable
  // listing, which excludes it unconditionally.
  const includeSystem = hasScope("kernel:agents:admin", (c.get("scopes") as string[]) ?? [])
  const rows = await listDirectoryAgents(c.get("orgId"), c.get("userId"), { includeSystem })
  // The directory card renders state, purpose and a channel count, so they
  // ride here rather than costing one page request per card (P4c-T31).
  const channels = await readAgentChannels(
    callerActor(c),
    rows.map((a) => a.id),
  )
  return success(
    c,
    rows.map((a) => ({
      id: a.id,
      handle: a.handle,
      displayName: a.displayName,
      purpose: deriveAgentPurpose(a),
      state: agentState(a),
      channelCount: channels.get(a.id)?.length ?? 0,
      // Which agents a member may start a conversation WITH: a role agent is
      // the org's, a personal one belongs to one colleague and is nobody
      // else's to DM. The caller decides; the list stays the same.
      kind: a.kind,
      // WHICH PERSONAL AGENT IS THE CALLER'S OWN. A surface that has to name
      // "my Liaison" (the desktop shell's local session entry point reads it
      // off the agent panel) cannot tell one colleague's personal agent from
      // another's without it. Echoed ONLY when it is the caller: the listing
      // already reveals that these agents exist, and who owns which one is not
      // this route's to hand out.
      ownerUserId: a.ownerUserId === c.get("userId") ? a.ownerUserId : null,
      avatarUrl: a.avatarUrl ?? null,
      // The disc's colour slot (0221), so every surface draws the same one.
      avatarColor: a.avatarColor ?? null,
    })),
  )
})

/**
 * THE AGENTS SIDEBAR'S SEARCH BOX: one query, four kinds of answer.
 *
 * The sidebar lists the agents and searches across what they carry, so a
 * member typing "refund" finds the skill, the routine and the memory entry
 * without knowing which agent owns which. Fanning out from the client would
 * be one request per agent per kind; this is the same reads, once.
 *
 * PERMISSION IS THE SAME PERMISSION. The agents are `listDirectoryAgents`, the
 * one predicate every addressable-agent read shares; the skills and routines
 * are read under the CALLER's own RLS exactly as their own list routes read
 * them (`skills_select` 0047, `routines_select` 0048), so an owner_agent_id
 * the caller cannot see matches no row; the memory rows go through the verbs'
 * own `filterByVisibility` on top of RLS, so a row whose `requiredScopes` the
 * caller lacks is absent rather than redacted. Nothing here widens anything.
 *
 * Substring matching, not ranking: a sidebar box is a filter over a few
 * hundred rows, and the caps below are what keep the answer readable.
 */
const SEARCH_HITS_PER_KIND = 10

/** `%` and `_` are ILIKE metacharacters; a person typing them means them
 *  literally. */
function likeNeedle(query: string): string {
  return `%${query.replace(/([\\%_])/g, "\\$1")}%`
}

definitionRoutes.get("/search", requireScope("kernel:threads:read"), async (c) => {
  const query = (c.req.query("q") ?? "").trim()
  const empty = { agents: [], skills: [], routines: [], memories: [] }
  if (query.length === 0) return success(c, empty)

  const scopes = (c.get("scopes") as string[]) ?? []
  const orgId = c.get("orgId") as string
  const userId = c.get("userId") as string
  const includeSystem = hasScope("kernel:agents:admin", scopes)
  const visible = await listDirectoryAgents(orgId, userId, { includeSystem })
  if (visible.length === 0) return success(c, empty)

  const byId = new Map(visible.map((a) => [a.id, a]))
  const agentIds = visible.map((a) => a.id)
  const needle = likeNeedle(query)
  const lower = query.toLowerCase()
  const actor = callerActor(c)
  const named = (agentId: string | null) => {
    const row = agentId ? byId.get(agentId) : undefined
    return {
      agentId: row?.id ?? "",
      agentHandle: row?.handle ?? "",
      agentName: row?.displayName ?? row?.handle ?? "",
    }
  }

  const [skillRows, routineRows, memoryRows] = await withRlsContext(actor, async (tx) => {
    const skillHits = await tx
      .select({
        id: skills.id,
        name: skills.name,
        description: skills.description,
        ownerAgentId: skills.ownerAgentId,
      })
      .from(skills)
      .where(
        and(
          eq(skills.orgId, orgId),
          inArray(skills.ownerAgentId, agentIds),
          or(ilike(skills.name, needle), ilike(skills.description, needle)),
        ),
      )
      .limit(SEARCH_HITS_PER_KIND)
    const routineHits = await tx
      .select({
        id: routines.id,
        name: routines.name,
        description: routines.description,
        ownerAgentId: routines.ownerAgentId,
      })
      .from(routines)
      .where(
        and(
          eq(routines.orgId, orgId),
          inArray(routines.ownerAgentId, agentIds),
          or(ilike(routines.name, needle), ilike(routines.description, needle)),
        ),
      )
      .limit(SEARCH_HITS_PER_KIND)
    const memoryHits = await tx
      .select({
        type: agentMemory.type,
        name: agentMemory.name,
        path: agentMemory.path,
        description: agentMemory.description,
        requiredScopes: agentMemory.requiredScopes,
        ownerAgentId: agentMemory.ownerAgentId,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, orgId),
          inArray(agentMemory.ownerAgentId, agentIds),
          or(
            ilike(agentMemory.name, needle),
            ilike(agentMemory.description, needle),
            ilike(agentMemory.content, needle),
          ),
        ),
      )
      .limit(SEARCH_HITS_PER_KIND * 3)
    return [skillHits, routineHits, memoryHits] as const
  })

  // The verbs' own visibility filter, on top of RLS: a memory row whose
  // `requiredScopes` this caller lacks is absent, never redacted.
  const memoriesVisible = filterByVisibility(memoryRows, { userId, grants: scopes }).slice(
    0,
    SEARCH_HITS_PER_KIND,
  )

  return success(c, {
    agents: visible
      .filter(
        (a) =>
          a.handle.toLowerCase().includes(lower) || a.displayName.toLowerCase().includes(lower),
      )
      .slice(0, SEARCH_HITS_PER_KIND)
      .map((a) => ({ agentId: a.id, handle: a.handle, displayName: a.displayName })),
    skills: skillRows.map((s) => ({
      ...named(s.ownerAgentId),
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    routines: routineRows.map((r) => ({
      ...named(r.ownerAgentId),
      id: r.id,
      name: r.name,
      description: r.description,
    })),
    memories: memoriesVisible.map((m) => ({
      ...named(m.ownerAgentId),
      path: pathForRow(m),
      name: m.name,
      description: m.description,
    })),
  })
})

/**
 * THE AGENT PAGE'S GATE (A41, narrowed): the caller's own personal agent and
 * the org's role agents, never another colleague's personal agent. `@base` is
 * a `kind='system'` row the listing never returns, so it is reachable only by
 * an ADMIN holding `kernel:agents:read`; that same admin read answers for
 * every agent of the org, another colleague's personal agent included.
 *
 * Shared by every agent-page read (`/:agentId`, `/:agentId/knowledge`) so
 * they cannot drift into disagreeing about which agent exists: each answers
 * `null` (never 403) for anything outside the caller's reach, so none of them
 * is more of an existence oracle than the listing is, and an archived agent
 * reads as missing like everywhere else in this slice.
 */
async function resolvePageAgent(
  c: Context<AppEnv>,
  agentId: string,
): Promise<{ row: Agent; adminRead: boolean } | null> {
  const scopes = (c.get("scopes") as string[]) ?? []
  const adminRead = hasScope("kernel:agents:read", scopes)
  if (!adminRead && !hasScope("kernel:threads:read", scopes)) {
    throw new PermissionDeniedError({ missingScope: "kernel:threads:read" })
  }
  // A malformed id is a miss, not a 500 from the uuid cast.
  if (!UUID_RE.test(agentId)) return null
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  let row: Agent | undefined
  if (adminRead) {
    const [found] = await withSystemDb("agent-page-admin-read", (tx) =>
      tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
        .limit(1),
    )
    row = found
  } else {
    // The listing itself, never a copy of its predicate: the page and the DM
    // picker have to agree about who exists.
    row = (await listMentionableAgents(orgId, userId)).find((a) => a.id === agentId)
  }
  if (!row) return null
  return { row, adminRead }
}

/**
 * THE AGENT PAGE'S ONE READ (P4c-T31): everything the Overview and the
 * directory card show about a single agent, so neither has to fan out.
 *
 * NOTHING HERE NAMES A SCOPE. The ceiling is reported through the A14
 * category mapping, which keeps the app and drops the grant, and the system
 * prompt stays behind `/definition`: `purpose` is its first substantive line
 * and nothing more.
 */
definitionRoutes.get("/:agentId", async (c) => {
  const notFound = () => c.json({ error: { message: "agent not found" } }, 404)
  const resolved = await resolvePageAgent(c, c.req.param("agentId"))
  if (!resolved) return notFound()
  const { row, adminRead } = resolved
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  const actor = callerActor(c)
  const channels = (await readAgentChannels(actor, [row.id])).get(row.id) ?? []
  const stats = await readAgentStats(actor, row.id)
  return success(c, {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    kind: row.kind,
    // Whose agent this is, for the owner and for an admin. A colleague who can
    // merely see a role agent learns nothing about ownership here.
    ownerUserId: adminRead || row.ownerUserId === userId ? row.ownerUserId : null,
    purpose: fullAgentPurpose(row),
    // The picture the Settings tab saves (0096), null until one is set: every
    // header in the web client renders the same participant shape.
    avatarUrl: row.avatarUrl ?? null,
    avatarColor: row.avatarColor ?? null,
    state: agentState(row),
    lastActivityAt: await readLastActivityAt(orgId, row.id),
    channels,
    counts: stats.counts,
    capabilityCategories: capabilityCategories(row.scopeCeiling ?? []),
    runsOn: stats.runsOn,
  })
})

/**
 * THE AGENT PAGE'S KNOWLEDGE TAB (P4c-T32): every Knowledge collection this
 * agent has been pointed at, with the collection's name so the tab need not
 * fan out to the Knowledge app for it.
 *
 * SAME GATE as `/:agentId` (`resolvePageAgent`, A41 narrowed): a tab request
 * for an agent outside the caller's reach is the same 404, never an existence
 * oracle of its own.
 *
 * `agent_knowledge_pointers` carries no Drizzle-level FK into
 * `app_knowledge.collections` (see the schema file's own note), so the name
 * lookup is a raw join through `knowledgeRel`, on the SAME RLS actor as the
 * pointer read: a caller who cannot read Knowledge collections
 * (`knowledge:documents:read`) sees the pointer without a name rather than an
 * error, which is a narrower disclosure than failing the whole tab.
 */
definitionRoutes.get("/:agentId/knowledge", async (c) => {
  const notFound = () => c.json({ error: { message: "agent not found" } }, 404)
  const resolved = await resolvePageAgent(c, c.req.param("agentId"))
  if (!resolved) return notFound()
  const { row } = resolved
  const orgId = c.get("orgId")

  const actor = callerActor(c)
  const pointers = await withRlsContext(actor, (tx) =>
    tx
      .select({
        id: agentKnowledgePointers.id,
        collectionId: agentKnowledgePointers.collectionId,
        createdAt: agentKnowledgePointers.createdAt,
      })
      .from(agentKnowledgePointers)
      .where(
        and(eq(agentKnowledgePointers.orgId, orgId), eq(agentKnowledgePointers.agentId, row.id)),
      ),
  )
  if (pointers.length === 0) return success(c, [])

  // A NAME ALONE IS NOT A ROW. The tab printed the collection's name and
  // nothing else, so every pointer looked identical and said nothing about
  // what the agent actually reads. The count and the freshness come from the
  // collection's own memberships, read in the CALLER's RLS context, so the
  // number is the number of documents this reader may see and never a wider
  // one leaked through a join.
  const collectionIds = [...new Set(pointers.map((p) => p.collectionId))]
  const collectionRows = await withRlsContext(actor, (tx) =>
    tx.execute(sql`
      SELECT c.id,
             c.name,
             count(d.id) AS document_count,
             max(d.updated_at) AS last_updated_at
      FROM ${knowledgeRel("collections")} c
      LEFT JOIN ${knowledgeRel("collection_memberships")} m
        ON m.collection_id = c.id AND m.org_id = c.org_id AND m.target_type = 'document'
      LEFT JOIN ${knowledgeRel("documents")} d
        ON d.id = m.target_id AND d.org_id = c.org_id AND d.archived_at IS NULL
      WHERE c.org_id = ${orgId}
        AND c.id IN (${sql.join(
          collectionIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
      GROUP BY c.id, c.name
    `),
  )
  const collections = new Map(
    extractRows<{
      id: string
      name: string
      document_count: string | number
      last_updated_at: string | Date | null
    }>(collectionRows).map((r) => [r.id, r]),
  )

  return success(
    c,
    pointers.map((p) => {
      const collection = collections.get(p.collectionId)
      return {
        id: p.id,
        collectionId: p.collectionId,
        collectionName: collection?.name ?? null,
        documentCount: collection ? Number(collection.document_count) : null,
        lastUpdatedAt: collection?.last_updated_at
          ? new Date(collection.last_updated_at).toISOString()
          : null,
        createdAt: p.createdAt,
      }
    }),
  )
})

/**
 * THE AGENT PAGE'S ACTIVITY TAB (P4c-T37): one timeline of what this agent did,
 * read straight off `kernel.audit_log`, newest first, in pages of 50.
 *
 * THE AUDIT ROW IS THE RECORD, AND NOTHING OF IT IS ECHOED. `changes` carries a
 * message preview and a turn's tool calls, and `metadata` carries whatever the
 * writer put there, so neither is ever returned: a row's `summary` is built
 * from its ACTION alone, through the table below, and the only fields read out
 * of the payload are a thread id and `runLocation`. A new audit writer can
 * therefore not widen this response by accident, which is the whole point of
 * mapping rather than projecting.
 *
 * WHICH ACTIONS ARE A TIMELINE ROW is a closed list (A11 keys every agent row
 * on `agent_id`, so the filter is `agent_id = :id` plus this list). An action
 * nobody has mapped is NOT shown: a timeline that grows a nameless row the
 * first time a new event ships is worse than one that lags a release.
 *
 * ASK vs TURN. `agents_ask` posts an ordinary message through the one writer
 * (`modules/agent/tools/coordination-tools.ts`), so it lands as the same
 * `message.create` row a reply does; what tells them apart is the agent mention
 * the question carries, which is already in the row's own payload as a parsed
 * `mentions` list. Reading it costs no extra query and leaks nothing: the
 * answer is a KIND, never the mention.
 */
const ACTIVITY_PAGE_SIZE = 50

type ActivityKind = "turn" | "routine_tick" | "sub_run" | "ask" | "memory_write" | "approval"

/**
 * Audit action -> what the row is, and the one sentence that describes it.
 * Every summary is a fixed string: no row's own words ever reach it.
 */
const ACTIVITY_ACTIONS: Record<string, { kind: ActivityKind; summary: string }> = {
  "message.create": { kind: "turn", summary: "Replied in a conversation" },
  "agent.local_session.reply": { kind: "turn", summary: "Replied from a local session" },
  "agent.local_session.turn": { kind: "turn", summary: "Took a turn in a local session" },
  "routine.status": { kind: "routine_tick", summary: "A routine changed state" },
  "routine.run_completed": { kind: "routine_tick", summary: "Finished a routine run" },
  "sub_run.create": { kind: "sub_run", summary: "Started a sub run" },
  "sub_run.update": { kind: "sub_run", summary: "A sub run advanced" },
  memory_file_edited: { kind: "memory_write", summary: "Edited a memory file" },
  memory_fact_written: { kind: "memory_write", summary: "Wrote a fact to memory" },
  memory_episode_written: { kind: "memory_write", summary: "Wrote a conversation to memory" },
  memory_episode_rebuilt: { kind: "memory_write", summary: "Rebuilt a memory episode" },
  memory_index_rebuilt: { kind: "memory_write", summary: "Rebuilt the memory index" },
  memory_thread_forgotten: { kind: "memory_write", summary: "Forgot a conversation" },
  "approval_request.create": { kind: "approval", summary: "Asked for an approval" },
  "approval_request.update": { kind: "approval", summary: "An approval was decided" },
}

/** The `message.create` summary an ASK gets instead of a reply's. */
const ASK_SUMMARY = "Asked another agent a question"

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The conversation a row belongs to. Three shapes, because three writers:
 * `entity_type = 'thread'` puts it in `entity_id` (the consolidation and forget
 * writers), the local session writers put it in `metadata`, and the event
 * consumer leaves the event's own `data` in `changes`. Anything else has no
 * conversation, which is a null and not a guess.
 */
function activityThreadId(row: {
  entityType: string | null
  entityId: string | null
  changes: unknown
  metadata: unknown
}): string | null {
  if (row.entityType === "thread" && row.entityId && UUID_RE.test(row.entityId)) return row.entityId
  for (const source of [asRecord(row.metadata), asRecord(row.changes)]) {
    const value = source.threadId
    if (typeof value === "string" && UUID_RE.test(value)) return value
  }
  return null
}

/**
 * WHERE THE TURN RAN. The local writers stamp `metadata.runLocation = "local"`
 * on every row they record (`local-session-routes.ts`, `RUN_LOCATION_LOCAL`),
 * so the row itself answers it and a live claim read would not: a claim lapses
 * in a minute, and this timeline is history. A node job's result is persisted
 * with `runLocation: "node"` (P4, A19) and is named as such (F15).
 */
export function activityRunLocation(metadata: unknown): "liaison" | "local" | "node" {
  const location = asRecord(metadata).runLocation
  return location === "local" || location === "node" ? location : "liaison"
}

/** True when this message row is an agent asking another agent (A29/A30). */
function mentionsAnAgent(changes: unknown): boolean {
  const mentions = asRecord(changes).mentions
  return Array.isArray(mentions) && mentions.some((m) => asRecord(m).type === "agent")
}

/**
 * The names of the conversations a page links to, as THIS viewer may see them,
 * under the same two-branch disclosure rule `readAgentChannels` follows: the
 * RLS read for a room they are in, plus a privileged read pinned to
 * `discoverable = true`. A room that is neither is linked but not named, which
 * is narrower than naming it and narrower than dropping the row.
 */
async function readThreadNames(
  actor: UserContext,
  threadIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (threadIds.length === 0) return names
  const fields = {
    id: threads.id,
    handle: threads.handle,
    title: threads.title,
    type: threads.type,
    discoverable: threads.discoverable,
  }
  const mine = await withRlsContext(actor, (tx) =>
    tx
      .select(fields)
      .from(threads)
      .where(and(eq(threads.orgId, actor.orgId), inArray(threads.id, threadIds))),
  )
  const open = await withSystemDb("agent-activity-discoverable-threads", (tx) =>
    tx
      .select(fields)
      .from(threads)
      .where(
        and(
          eq(threads.orgId, actor.orgId),
          eq(threads.discoverable, true),
          inArray(threads.id, threadIds),
        ),
      ),
  )
  const visible = new Map<string, (typeof mine)[number]>()
  for (const row of [...mine, ...open]) visible.set(row.id, row)
  if (visible.size === 0) return names

  // A DM HAS NO TITLE, AND ITS HANDLE IS A DATABASE KEY. Falling straight
  // through to `threads.handle` printed "thread-22" on the timeline, which
  // names nobody and leaks the row's internal key. A titled room is its title;
  // an untitled one is named by its other participants, exactly as the Chats
  // list names it (`conversationDisplayName`, over the shared
  // `classifyConversation` rule applied to a titleless row).
  const untitled = [...visible.values()].filter((row) => !row.title)
  for (const row of visible.values()) if (row.title) names.set(row.id, row.title)
  if (untitled.length === 0) return names

  const seats = await readThreadSeats(
    actor.orgId,
    untitled.map((row) => row.id),
  )
  for (const row of untitled) {
    const participants = seats.get(row.id) ?? []
    const others = participants.filter((p) => p.id !== actor.userId)
    const kind = classifyConversation({
      title: null,
      type: row.type,
      discoverable: row.discoverable,
      currentUserId: actor.userId,
      participants: participants.map((p) => ({ id: p.id, participantType: p.participantType })),
    })
    // A 1:1 with an agent is the agent, in full: "Support Agent", not "Support".
    // A room of people is their first names, as every conversation list writes
    // them.
    const name =
      kind.group === "dm" && kind.namedBy === "agent"
        ? (others[0]?.name ?? "")
        : others
            .map((p) => p.name.split(" ")[0])
            .filter(Boolean)
            .join(", ")
    // A room whose seats this viewer cannot read is linked but NOT named: the
    // handle would say nothing at all, which is the bug this fixes.
    if (name) names.set(row.id, name)
  }
  return names
}

/** Every seat of the named threads, with the display name each seat answers to.
 *  Read privileged: the caller has already reduced the set to rooms this viewer
 *  may see, and the participant list of such a room is not a further secret. */
async function readThreadSeats(
  orgId: string,
  threadIds: string[],
): Promise<Map<string, Array<{ id: string; participantType: "user" | "agent"; name: string }>>> {
  const out = new Map<
    string,
    Array<{ id: string; participantType: "user" | "agent"; name: string }>
  >()
  if (threadIds.length === 0) return out
  const rows = await withSystemDb("agent-activity-thread-seats", (tx) =>
    tx
      .select({
        threadId: threadParticipants.threadId,
        userId: threadParticipants.userId,
        agentId: threadParticipants.agentId,
        participantType: threadParticipants.participantType,
        userName: users.name,
        agentName: agents.displayName,
      })
      .from(threadParticipants)
      .leftJoin(users, eq(users.id, threadParticipants.userId))
      .leftJoin(agents, eq(agents.id, threadParticipants.agentId))
      .where(
        and(eq(threadParticipants.orgId, orgId), inArray(threadParticipants.threadId, threadIds)),
      ),
  )
  for (const row of rows) {
    const isAgent = row.participantType === "agent"
    const id = isAgent ? row.agentId : row.userId
    if (!id) continue
    const name = (isAgent ? row.agentName : row.userName) ?? ""
    const list = out.get(row.threadId) ?? []
    list.push({ id, participantType: isAgent ? "agent" : "user", name })
    out.set(row.threadId, list)
  }
  return out
}

definitionRoutes.get("/:agentId/activity", async (c) => {
  const notFound = () => c.json({ error: { message: "agent not found" } }, 404)
  const resolved = await resolvePageAgent(c, c.req.param("agentId"))
  if (!resolved) return notFound()
  const { row } = resolved
  const userId = c.get("userId")
  // ADMINISTRATION, NOT VISIBILITY. An agent the caller cannot see is a 404
  // above; one they can see but may not administer is a 403, the same split the
  // page's own tab strip renders (`AgentPage.tsx`, `canAdminister`).
  const isAdmin = hasScope("kernel:agents:admin", (c.get("scopes") as string[]) ?? [])
  const isOwner = row.kind === "personal" && row.ownerUserId === userId
  if (!isAdmin && !isOwner) {
    return c.json({ error: { message: "this agent's activity is not yours to read" } }, 403)
  }

  const requested = Number.parseInt(c.req.query("limit") ?? "", 10)
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, ACTIVITY_PAGE_SIZE)
      : ACTIVITY_PAGE_SIZE
  const beforeRaw = c.req.query("before")
  const before = beforeRaw ? new Date(beforeRaw) : null
  if (before && Number.isNaN(before.getTime())) {
    return c.json({ error: { message: "before must be a timestamp" } }, 400)
  }

  const conditions = [
    eq(auditLog.orgId, row.orgId),
    eq(auditLog.agentId, row.id),
    inArray(auditLog.action, Object.keys(ACTIVITY_ACTIONS)),
  ]
  if (before) conditions.push(lt(auditLog.timestamp, before))
  const rows = await withSystemDb("agent-activity-timeline", (tx) =>
    tx
      .select({
        timestamp: auditLog.timestamp,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        changes: auditLog.changes,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.timestamp))
      .limit(limit),
  )

  const threadIds = [
    ...new Set(rows.map((r) => activityThreadId(r)).filter((id): id is string => id !== null)),
  ]
  const names = await readThreadNames(callerActor(c), threadIds)

  return success(
    c,
    rows.map((r) => {
      const mapped = ACTIVITY_ACTIONS[r.action]
      const ask = r.action === "message.create" && mentionsAnAgent(r.changes)
      const threadId = activityThreadId(r)
      return {
        at: r.timestamp,
        kind: ask ? ("ask" as ActivityKind) : mapped.kind,
        threadId,
        threadName: threadId ? (names.get(threadId) ?? null) : null,
        summary: ask ? ASK_SUMMARY : mapped.summary,
        // The catalog key for the same sentence, so the reader's language
        // renders it (kernel.agentUi.activity.<summaryKey>); `summary` stays
        // the English fallback for older clients.
        summaryKey: ask ? "ask" : r.action.replace(/[^a-z0-9]+/gi, "_"),
        runLocation: activityRunLocation(r.metadata),
      }
    }),
  )
})

/**
 * P4b-D5: archive an agent.
 *
 * The blockers are checked FIRST and answered as a 409 carrying the list, so
 * the admin surface can name each shared routine and cross-referenced skill
 * and offer to hand it to another agent (PATCH /api/agent/routines/:id and
 * /api/agent/skills/:id). The list rides in `error.details`, which is where
 * the web api client puts a failed call's body.
 *
 * `@base` is never archivable and an agent of another org is 404, so the route
 * is not an existence oracle on somebody else's agents. `archiveAgent` itself
 * re-checks the blockers and the scope: this route hands it the caller's real
 * scopes rather than deciding on its own.
 */
definitionRoutes.post("/:agentId/archive", requireScope("kernel:agents:admin"), async (c) => {
  const orgId = c.get("orgId")
  const agentId = c.req.param("agentId")
  // WHOSE agent this is, decided BEFORE anything about it is read back. The
  // blocker list names routines and skills, so answering it for an agent the
  // caller's org does not own hands an admin of one org the names of another
  // org's work. An absent agent and a foreign one are the same 404 here, so
  // the route is not an existence oracle either.
  const [target] = await withSystemDb("archive-agent-org-check", (tx) =>
    tx
      .select({ orgId: agents.orgId, handle: agents.handle })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  )
  if (!target || target.orgId !== orgId) throw new HTTPException(404, { message: "Not found" })
  if (target.handle === BASE_AGENT_HANDLE) {
    throw new HTTPException(409, { message: "base agent is not archivable" })
  }
  const blockers = await checkArchiveBlockers(agentId, orgId)
  if (blockers.blocked) {
    return c.json(
      {
        error: {
          message: "This agent still owns skills or routines. Reassign them first.",
          code: "archive_blocked",
          details: { blocked: true, routines: blockers.routines, skills: blockers.skills },
        },
      },
      409,
    )
  }
  try {
    await archiveAgent(orgId, agentId, c.get("scopes") as string[])
  } catch (err) {
    if (err instanceof ArchiveForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof ArchiveCrossOrgError) {
      throw new HTTPException(404, { message: "Not found" })
    }
    if (err instanceof BaseAgentNotArchivableError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof ArchiveBlockedError) {
      return c.json(
        {
          error: {
            message: err.message,
            code: "archive_blocked",
            details: { blocked: true, routines: err.routines, skills: err.skills },
          },
        },
        409,
      )
    }
    throw err
  }
  const [row] = await withSystemDb("archive-agent-read-back", (tx) =>
    tx.select({ archivedAt: agents.archivedAt }).from(agents).where(eq(agents.id, agentId)),
  )
  // `archiveAgent` returns silently for an agent that does not exist at all,
  // so the read back is what tells the two apart: no row, no archive, 404.
  if (!row) throw new HTTPException(404, { message: "Not found" })
  return success(c, { blocked: false, archivedAt: row.archivedAt })
})

/**
 * THE DEFINITION WRITES (P4c-T38): what the Settings tab saves, and the one
 * rule that decides who may save which half of it.
 *
 * TWO CALLERS, NOT ONE. `kernel:agents:admin` edits every field of every agent
 * in its org. The OWNER of a personal agent edits three: the name, the picture
 * and the prompt. That is not a UI convenience: an owner who could raise their
 * own agent's ceiling would be granting themselves scopes, so the owner branch
 * is enforced here and the surface merely renders what it allows.
 *
 * A FIELD AN OWNER MAY NOT WRITE IS REFUSED, NEVER DROPPED. A body naming the
 * ceiling, the purpose or the model comes back 403 with a code rather than a
 * 200 that silently saved three fields out of four: a quietly ignored write
 * reads, on any surface, exactly like a saved one.
 *
 * THE CEILING IS BOUNDED BY THE CALLER'S OWN GRANTABLE SCOPES, through the
 * SAME predicate `sub-agent-definitions.ts` applies to a sub-agent role
 * (`isScopeSubset`, which understands `*`, `:*` globs and bare prefixes). An
 * admin cannot hand an agent a scope they do not themselves hold.
 */
const EDITABLE_FIELDS = [
  "displayName",
  "avatarUrl",
  "avatarColor",
  "purpose",
  "systemPrompt",
  "modelPreference",
  "scopeCeiling",
] as const
type EditableField = (typeof EDITABLE_FIELDS)[number]

/** What an owner writes on their OWN personal agent (its name, its picture and
 *  colour, its prompt), and no more. */
const OWNER_FIELDS = new Set<EditableField>([
  "displayName",
  "avatarUrl",
  "avatarColor",
  "systemPrompt",
])

/** Handles are addressed by people and typed by hand: one shape, one org. */
const HANDLE_RE = /^@[a-z0-9][a-z0-9_-]{0,30}$/

interface DefinitionWrite {
  displayName?: string
  avatarUrl?: string | null
  avatarColor?: number
  purpose?: string | null
  systemPrompt?: string
  modelPreference?: string | null
  scopeCeiling?: string[]
}

/** A field's value as the columns store it, or the message that refuses it. */
function readWrite(body: Record<string, unknown>): DefinitionWrite | string {
  const out: DefinitionWrite = {}
  const optionalText = (key: "avatarUrl" | "purpose" | "modelPreference"): string | undefined => {
    const value = body[key]
    if (value === null) {
      out[key] = null
      return undefined
    }
    if (typeof value !== "string") return `${key} must be a string or null`
    out[key] = value.trim() === "" ? null : value.trim()
    return undefined
  }
  if ("displayName" in body) {
    const value = body.displayName
    if (typeof value !== "string" || value.trim() === "") return "displayName must not be empty"
    out.displayName = value.trim().slice(0, 200)
  }
  if ("avatarColor" in body) {
    // A slot of the agent palette. Null is refused, not "back to the hash": a
    // stored colour is what keeps an org's agents apart.
    const parsed = agentAvatarColorSchema.safeParse(body.avatarColor)
    if (!parsed.success) {
      return `avatarColor must be an integer from 0 to ${AGENT_AVATAR_COLOR_COUNT - 1}`
    }
    out.avatarColor = parsed.data
  }
  if ("systemPrompt" in body) {
    if (typeof body.systemPrompt !== "string") return "systemPrompt must be a string"
    out.systemPrompt = body.systemPrompt
  }
  for (const key of ["avatarUrl", "purpose", "modelPreference"] as const) {
    if (!(key in body)) continue
    const refusal = optionalText(key)
    if (refusal) return refusal
  }
  if ("scopeCeiling" in body) {
    const value = body.scopeCeiling
    if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
      return "scopeCeiling must be an array of scope strings"
    }
    out.scopeCeiling = value as string[]
  }
  return out
}

/** The agent as the Settings tab reads it back. A scope name rides only to a
 *  caller who may edit the ceiling, which is the admin and nobody else. */
function definitionPayload(row: Agent, adminView: boolean) {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    kind: row.kind,
    ownerUserId: row.ownerUserId,
    purpose: fullAgentPurpose(row),
    avatarUrl: row.avatarUrl ?? null,
    avatarColor: row.avatarColor ?? null,
    systemPrompt: row.systemPrompt,
    modelPreference: row.modelPreference ?? null,
    state: agentState(row),
    ...(adminView ? { scopeCeiling: row.scopeCeiling ?? [] } : {}),
  }
}

/**
 * WHAT THE SETTINGS TAB READS BEFORE IT WRITES. The page read (`/:agentId`)
 * deliberately names no scope and carries no prompt, so a form that edits both
 * cannot be built from it: this route answers the row as its editor sees it,
 * behind the same gate the write is behind, and echoes the ceiling only to the
 * admin who may change it.
 */
definitionRoutes.get("/:agentId/settings", async (c) => {
  const agentId = c.req.param("agentId")
  const notFound = () => c.json({ error: { message: "agent not found" } }, 404)
  if (!UUID_RE.test(agentId)) return notFound()
  const scopes = (c.get("scopes") as string[]) ?? []
  const isAdmin = hasScope("kernel:agents:admin", scopes)
  const [row] = await withSystemDb("agent-settings-read", (tx) =>
    tx
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.orgId, c.get("orgId")), isNull(agents.archivedAt)),
      )
      .limit(1),
  )
  if (!row) return notFound()
  const isOwner = row.kind === "personal" && row.ownerUserId === c.get("userId")
  if (!isAdmin && !isOwner) {
    if (row.kind === "personal") return notFound()
    return c.json({ error: { message: "this agent is not yours to edit" } }, 403)
  }
  return success(c, definitionPayload(row, isAdmin))
})

definitionRoutes.patch("/:agentId", async (c) => {
  const agentId = c.req.param("agentId")
  const notFound = () => c.json({ error: { message: "agent not found" } }, 404)
  if (!UUID_RE.test(agentId)) return notFound()
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const scopes = (c.get("scopes") as string[]) ?? []
  const isAdmin = hasScope("kernel:agents:admin", scopes)

  const [row] = await withSystemDb("agent-definition-write-read", (tx) =>
    tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .limit(1),
  )
  if (!row) return notFound()
  const isOwner = row.kind === "personal" && row.ownerUserId === userId
  if (!isAdmin && !isOwner) {
    // The same split the rest of the page draws: an agent the caller cannot
    // see at all is a 404 (another colleague's personal agent is not theirs to
    // learn about), one they can see but may not administer is a 403.
    if (row.kind === "personal") return notFound()
    return c.json({ error: { message: "this agent is not yours to edit" } }, 403)
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: { message: "a body is required" } }, 400)
  }
  const keys = Object.keys(body)
  const unknown = keys.filter((k) => !(EDITABLE_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    return c.json(
      { error: { message: `not an editable field: ${unknown.join(", ")}`, code: "unknown_field" } },
      400,
    )
  }
  if (!isAdmin) {
    const forbidden = keys.filter((k) => !OWNER_FIELDS.has(k as EditableField))
    if (forbidden.length > 0) {
      return c.json(
        {
          error: {
            message: `an owner may edit the name, the picture, the colour and the prompt: ${forbidden.join(", ")} needs an administrator`,
            code: "owner_field_forbidden",
          },
        },
        403,
      )
    }
  }
  const write = readWrite(body)
  if (typeof write === "string") return c.json({ error: { message: write } }, 400)
  if (write.scopeCeiling && !isScopeSubset(write.scopeCeiling, scopes)) {
    return c.json(
      {
        error: {
          message: "that ceiling is wider than what you may grant",
          code: "scope_ceiling_exceeded",
        },
      },
      403,
    )
  }
  if (Object.keys(write).length === 0) return success(c, definitionPayload(row, isAdmin))

  const [updated] = await withSystemDb("agent-definition-write", async (tx) => {
    // A ceiling an administrator sets on a PERSONAL agent is a deliberate
    // narrowing, kept apart from the derived ceiling (0218) so the recompute
    // every grant change runs keeps it: the ceiling is the owner's current
    // scopes the restriction covers. A ceiling covering everything the owner
    // holds narrows nothing and clears the restriction.
    if (write.scopeCeiling && row.kind === "personal" && row.ownerUserId) {
      const { scopes: ownerScopes } = await loadEffectivePermissions(tx, row.ownerUserId, orgId)
      const restriction = isScopeSubset(ownerScopes, write.scopeCeiling) ? null : write.scopeCeiling
      return tx
        .update(agents)
        .set({
          ...write,
          scopeCeiling: personalCeiling(ownerScopes, restriction),
          ceilingRestriction: restriction,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
        .returning()
    }
    return tx
      .update(agents)
      .set({ ...write, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .returning()
  })
  if (!updated) return notFound()
  return success(c, definitionPayload(updated, isAdmin))
})

/**
 * THE AGENT'S PICTURE, UPLOADED (not a URL typed by hand).
 *
 * The Settings tab used to offer a bare text box for `avatarUrl`, which meant
 * the only way to give an agent a face was to know a URL and paste it. These
 * two routes are the user avatar pipeline (`modules/users/avatar-image`,
 * `avatarStorageKey`) pointed at an agent row: magic-byte validation, a webp
 * normalization, one immutable object per upload and the previous object
 * purged. The stored value is the same capability URL a user's picture gets
 * (`/api/avatars/<key>`), which is why `resolveAvatarForServe` now resolves a
 * key against agents as well as users.
 *
 * The authority is the authority the PATCH already answers with: the agents
 * admin, or the owner of their own personal agent (the picture is one of the
 * three OWNER_FIELDS), with the same 404/403 split.
 */
async function agentAvatarTarget(
  c: Context<AppEnv>,
): Promise<{ row: Agent } | { refusal: Response }> {
  const agentId = c.req.param("agentId") ?? ""
  const notFound = () =>
    ({ refusal: c.json({ error: { message: "agent not found" } }, 404) }) as const
  if (!UUID_RE.test(agentId)) return notFound()
  const [row] = await withSystemDb("agent-avatar-read", (tx) =>
    tx
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.orgId, c.get("orgId")), isNull(agents.archivedAt)),
      )
      .limit(1),
  )
  if (!row) return notFound()
  const isAdmin = hasScope("kernel:agents:admin", (c.get("scopes") as string[]) ?? [])
  const isOwner = row.kind === "personal" && row.ownerUserId === c.get("userId")
  if (!isAdmin && !isOwner) {
    if (row.kind === "personal") return notFound()
    return { refusal: c.json({ error: { message: "this agent is not yours to edit" } }, 403) }
  }
  return { row }
}

/** The opaque key inside a stored `/api/avatars/<key>` URL, or null when the
 *  row carries some other URL (a hand-typed one from before this route). */
function avatarKeyOf(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null
  const match = /^\/api\/avatars\/([A-Za-z0-9_-]{16,64})$/.exec(avatarUrl)
  return match ? match[1] : null
}

async function writeAgentAvatar(
  c: Context<AppEnv>,
  row: Agent,
  avatarUrl: string | null,
): Promise<Agent | null> {
  const [updated] = await withSystemDb("agent-avatar-write", (tx) =>
    tx
      .update(agents)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(and(eq(agents.id, row.id), eq(agents.orgId, c.get("orgId"))))
      .returning(),
  )
  return updated ?? null
}

definitionRoutes.post("/:agentId/avatar", async (c) => {
  const target = await agentAvatarTarget(c)
  if ("refusal" in target) return target.refusal
  const { row } = target
  const orgId = c.get("orgId")

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: { message: "empty image upload" } }, 400)
  if (bytes.byteLength > MAX_AVATAR_UPLOAD_BYTES) {
    return c.json({ error: { message: "image is too large (maximum 5 MB)" } }, 413)
  }
  const validation = await validateAvatarBytes(bytes)
  if (!validation.ok) {
    return c.json(
      { error: { message: "unsupported image type. Use a PNG, JPEG, WEBP or GIF image." } },
      400,
    )
  }
  let webp: Buffer
  try {
    webp = await normalizeAvatar(Buffer.from(bytes))
  } catch {
    return c.json({ error: { message: "that image could not be processed." } }, 400)
  }

  const avatarKey = crypto.randomUUID()
  // The object lands BEFORE the row flips, so `avatar_url` never points at an
  // object that is not there yet.
  await putObject({
    key: avatarStorageKey(orgId, avatarKey),
    body: webp,
    contentType: AVATAR_STORED_MIME,
  })
  const updated = await writeAgentAvatar(c, row, avatarPublicUrl(avatarKey))
  if (!updated) return c.json({ error: { message: "agent not found" } }, 404)

  const previousKey = avatarKeyOf(row.avatarUrl)
  if (previousKey && previousKey !== avatarKey) {
    await deleteObject(avatarStorageKey(orgId, previousKey)).catch(() => {})
  }
  const isAdmin = hasScope("kernel:agents:admin", (c.get("scopes") as string[]) ?? [])
  return success(c, definitionPayload(updated, isAdmin))
})

definitionRoutes.delete("/:agentId/avatar", async (c) => {
  const target = await agentAvatarTarget(c)
  if ("refusal" in target) return target.refusal
  const { row } = target
  const updated = await writeAgentAvatar(c, row, null)
  if (!updated) return c.json({ error: { message: "agent not found" } }, 404)
  const previousKey = avatarKeyOf(row.avatarUrl)
  if (previousKey) {
    await deleteObject(avatarStorageKey(c.get("orgId"), previousKey)).catch(() => {})
  }
  const isAdmin = hasScope("kernel:agents:admin", (c.get("scopes") as string[]) ?? [])
  return success(c, definitionPayload(updated, isAdmin))
})

/**
 * CREATE A ROLE AGENT (P4c-T38). Only a role agent: a personal one belongs to
 * exactly one colleague and is created with their account, never from here,
 * and a `kind='system'` row is the product's own.
 */
definitionRoutes.post("/", requireScope("kernel:agents:admin"), async (c) => {
  const orgId = c.get("orgId")
  const scopes = (c.get("scopes") as string[]) ?? []
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: { message: "a body is required" } }, 400)
  }
  const rawHandle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : ""
  const handle = rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`
  if (!HANDLE_RE.test(handle)) {
    return c.json(
      { error: { message: "a handle is letters, digits, dashes and underscores" } },
      400,
    )
  }
  const write = readWrite(body)
  if (typeof write === "string") return c.json({ error: { message: write } }, 400)
  if (!write.displayName) {
    return c.json({ error: { message: "displayName must not be empty" } }, 400)
  }
  const scopeCeiling = write.scopeCeiling ?? []
  if (!isScopeSubset(scopeCeiling, scopes)) {
    return c.json(
      {
        error: {
          message: "that ceiling is wider than what you may grant",
          code: "scope_ceiling_exceeded",
        },
      },
      403,
    )
  }

  const [created] = await withSystemDb("agent-definition-create", async (tx) =>
    tx
      .insert(agents)
      .values({
        orgId,
        kind: "role",
        handle,
        displayName: write.displayName as string,
        purpose: write.purpose ?? null,
        avatarUrl: write.avatarUrl ?? null,
        avatarColor: write.avatarColor ?? (await pickAgentAvatarColor(tx, orgId)),
        modelPreference: write.modelPreference ?? null,
        systemPrompt: write.systemPrompt ?? "",
        scopeCeiling,
      })
      .onConflictDoNothing({ target: [agents.orgId, agents.handle] })
      .returning(),
  )
  // The unique index is the authority on the handle, so a conflict is reported
  // as one rather than overwriting the agent already answering under it.
  if (!created) {
    return c.json(
      { error: { message: "an agent already answers to that handle", code: "handle_taken" } },
      409,
    )
  }
  return success(c, definitionPayload(created, true), undefined, 201)
})

definitionRoutes.get("/:agentId/definition", async (c) => {
  const scopes = (c.get("scopes") as string[]) ?? []
  // The admin read is unchanged and is checked first: it answers for every
  // agent this route ever answered for, `@base` and another colleague's
  // personal agent included.
  const adminRead = hasScope("kernel:agents:read", scopes)
  if (!adminRead && !hasScope("kernel:threads:read", scopes)) {
    throw new PermissionDeniedError({ missingScope: "kernel:threads:read" })
  }

  for (const param of ["userId", "asUser"]) {
    if (c.req.query(param) !== undefined) {
      return c.json(
        {
          error: {
            message: `this endpoint never acts for another user: remove the ${param} parameter`,
          },
        },
        400,
      )
    }
  }

  // Where the definition runs (P4, A30): a desktop local session (absent) or
  // a node job (`runtime=node`), which carries the node's where-this-runs
  // section instead of the local one. Any other value is refused in words.
  const runtimeParam = c.req.query("runtime")
  if (runtimeParam !== undefined && runtimeParam !== "node" && runtimeParam !== "local") {
    return c.json({ error: { message: "runtime must be local or node" } }, 400)
  }
  const runtime: "local" | "node" = runtimeParam === "node" ? "node" : "local"

  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const agentId = c.req.param("agentId")

  if (!adminRead) {
    // The listing itself, not a re-implementation of it: a predicate copied
    // here would drift from the one the DM picker offers, and the gap between
    // the two IS the bug.
    const listed = (await listMentionableAgents(orgId, userId)).find((a) => a.id === agentId)
    if (!listed) return c.json({ error: { message: "agent not found" } }, 404)
  }

  // THE ROOM THE SESSION RUNS IN (`?threadId=`). A local or node session in a
  // room is handed what a cloud turn there would read: the room floor ∩ the
  // agent's ceiling ∩ the caller's grants (`roomBoundViewer`), never the DM
  // scope a session with no room gets. The room must be one the caller can
  // read, so the route cannot be used to probe another room's members.
  const threadParam = c.req.query("threadId")
  let effectiveScope: string[] | undefined
  if (threadParam !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadParam)) {
      return c.json({ error: { message: "threadId must be a uuid" } }, 400)
    }
    const actor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: c.get("scopes"),
      dimensionGrants: c.get("dimensionGrants") ?? {},
    }
    const [readable] = await withRlsContext(actor, (tx) =>
      tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.id, threadParam), eq(threads.orgId, orgId)))
        .limit(1),
    )
    if (!readable) return c.json({ error: { message: "thread not found" } }, 404)
    try {
      const viewer = await roomBoundViewer({
        orgId,
        threadId: threadParam,
        agentId,
        userId,
        userScopes: c.get("scopes") ?? [],
      })
      if (!viewer) return c.json({ error: { message: "agent not found" } }, 404)
      effectiveScope = viewer.grants
    } catch (err) {
      if (err instanceof RoomFloorError) {
        return c.json({ error: { message: "this conversation has no agent room" } }, 400)
      }
      throw err
    }
  }

  try {
    const result = await composeAgentDefinition({
      agentId,
      requestingActor: {
        actorType: "user",
        userId,
        orgId,
        scopes: c.get("scopes"),
        dimensionGrants: c.get("dimensionGrants") ?? {},
      },
      orgId,
      runtime,
      ...(effectiveScope ? { effectiveScope } : {}),
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      return c.json({ error: { message: "agent not found" } }, 404)
    }
    throw err
  }
})
