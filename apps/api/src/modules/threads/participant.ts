// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  MENTION_SEAT_ORIGIN,
  AGENT_GUEST_SEAT_ROLE as SHARED_AGENT_GUEST_SEAT_ROLE,
} from "@liaison/shared"
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import {
  agents,
  messages,
  threadParticipants,
  threads,
  users,
  userThreadState,
} from "~/db/schema/kernel"

interface AddParticipantParams {
  orgId: string
  userId: string
  threadId: string
  targetUserId: string
}

interface RemoveParticipantParams {
  orgId: string
  userId: string
  threadId: string
  targetUserId: string
  isAdmin: boolean
}

export async function addParticipant(db: RlsClient, params: AddParticipantParams) {
  const { orgId, userId, threadId, targetUserId } = params

  // Verify acting user is a participant in this org
  const [actorParticipant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!actorParticipant) return null

  // Verify target user belongs to the same org and is active
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.orgId, orgId), eq(users.status, "active")))
    .limit(1)
  if (!targetUser) return null

  const [thread] = await db
    .select({
      id: threads.id,
      type: threads.type,
      title: threads.title,
      handle: threads.handle,
      createdFrom: threads.createdFrom,
      tainted: threads.tainted,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    .limit(1)
  if (!thread) return null

  const promotesAgentChat = thread.type === "agent_chat"

  // Wrap mutation + event in transaction for atomicity
  try {
    await db.transaction(async (tx) => {
      await tx.insert(threadParticipants).values({ threadId, userId: targetUserId, orgId })
      await tx
        .insert(userThreadState)
        .values({ userId: targetUserId, threadId, orgId })
        .onConflictDoNothing()
      await tx
        .update(threads)
        .set({ updatedAt: new Date(), type: promotesAgentChat ? "thread" : thread.type })
        .where(eq(threads.id, threadId))

      const [user] = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, targetUserId))
      await tx.queueEvent({
        app: "kernel",
        entity: "participant",
        action: "add",
        entityId: threadId,
        orgId,
        actorId: userId,
        data: { threadId, userId: targetUserId, userName: user?.name },
      })

      if (promotesAgentChat) {
        const participantRows = await tx
          .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
          .from(threadParticipants)
          .innerJoin(users, eq(users.id, threadParticipants.userId))
          .where(eq(threadParticipants.threadId, threadId))

        await tx.queueEvent({
          app: "kernel",
          entity: "thread",
          action: "update",
          entityId: threadId,
          orgId,
          actorId: userId,
          data: {
            id: threadId,
            title: thread.title,
            handle: thread.handle,
            createdFrom: thread.createdFrom,
            tainted: thread.tainted,
            participants: participantRows,
            changes: { type: "thread" },
          },
        })
      }
    })
  } catch (err: any) {
    if (err.code === "23505" || err.cause?.code === "23505") return { added: false }
    throw err
  }

  return { added: true }
}

/**
 * Seat the members a person just @-mentioned, inside the send's own
 * transaction, and return the ones who were not seated before.
 *
 * A mention of a colleague who was not in the thread wrote them a "mentioned
 * you" attention row for a thread they could not open: the messages policy
 * reads participation, and so does the push fan-out, which dropped them. The
 * picker offers every member of the org, so the mention is how the writer
 * brings someone in, exactly as an agent mention seats the agent. The seat is
 * the same row and the same `participant:add` event the header's "Add people"
 * writes, under the same rule: the writer is a participant (the send already
 * checked it) and the member is an active user of this org. Anyone else named
 * in a mention (a foreign or suspended id) is skipped, never seated.
 */
export async function seatMentionedMembers(
  tx: RlsTx,
  params: { orgId: string; threadId: string; actorUserId: string; userIds: string[] },
): Promise<string[]> {
  const { orgId, threadId, actorUserId } = params
  const wanted = [...new Set(params.userIds)].filter((id) => id !== actorUserId)
  if (wanted.length === 0) return []

  const seatedRows = await tx
    .select({ userId: threadParticipants.userId })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.orgId, orgId),
        inArray(threadParticipants.userId, wanted),
      ),
    )
  const seated = new Set(seatedRows.map((r) => r.userId))
  const missing = wanted.filter((id) => !seated.has(id))
  if (missing.length === 0) return []

  const members = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, missing), eq(users.orgId, orgId), eq(users.status, "active")))
  if (members.length === 0) return []

  const added: string[] = []
  for (const member of members) {
    const inserted = await tx
      .insert(threadParticipants)
      .values({ threadId, userId: member.id, orgId })
      .onConflictDoNothing()
      .returning({ id: threadParticipants.id })
    if (inserted.length === 0) continue
    await tx
      .insert(userThreadState)
      .values({ userId: member.id, threadId, orgId })
      .onConflictDoNothing()
    await tx.queueEvent({
      app: "kernel",
      entity: "participant",
      action: "add",
      entityId: threadId,
      orgId,
      actorId: actorUserId,
      data: { threadId, userId: member.id, userName: member.name, via: "mention" },
    })
    added.push(member.id)
  }
  return added
}

export async function removeParticipant(db: RlsClient, params: RemoveParticipantParams) {
  const { orgId, userId, threadId, targetUserId, isAdmin } = params

  // Verify thread belongs to this org
  const [thread] = await db
    .select({ id: threads.id, createdBy: threads.createdBy })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    .limit(1)
  if (!thread) return { removed: false }

  // Verify actor is a participant (or admin) before allowing any removal
  if (isAdmin) {
    // Admin must belong to the same org as the thread (cross-org admin attack prevention)
    const [adminUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1)
    if (!adminUser) return { removed: false }
  } else {
    const [actorParticipant] = await db
      .select({ id: threadParticipants.id })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.userId, userId),
          eq(threadParticipants.orgId, orgId),
        ),
      )
      .limit(1)
    if (!actorParticipant) return { removed: false }
  }

  // Self-removal allowed; removing others requires admin scope or thread creator
  const isCreator = userId === thread.createdBy
  if (userId !== targetUserId && !isAdmin && !isCreator) return { removed: false }

  // The target may be an AGENT seat: the conversation menu removes an agent by
  // its id through this same route. An agent seat is not somebody left alone in
  // a room, so the last-human rule below does not apply to it (walk
  // 2026-10-12: removing an agent from a one-human room answered "Cannot remove
  // the last participant", and from a larger room 404).
  const [agentSeat] = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.orgId, orgId),
        eq(threadParticipants.participantType, "agent"),
        eq(threadParticipants.agentId, targetUserId),
      ),
    )
    .limit(1)
  if (agentSeat) {
    return db.transaction(async (tx) => {
      const out = await removeAgentParticipant(tx as unknown as RlsClient, {
        orgId,
        threadId,
        agentId: targetUserId,
        actorUserId: userId,
      })
      if (out.removed) {
        await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId))
      }
      return out
    })
  }

  // Wrap deletion + state cleanup + event in a transaction
  const removed = await db.transaction(async (tx) => {
    // Serialize concurrent removals on this thread — prevents the TOCTOU race
    // where two concurrent removes both read count=2 before either commits, and
    // both delete, leaving the thread empty. A `SELECT ... FOR UPDATE` row lock
    // cannot be used here: kernel.thread_participants has UPDATE REVOKEd from
    // liaison_rls (role changes go through the service layer, see 0000_initial),
    // and Postgres requires the UPDATE privilege to acquire a FOR UPDATE row
    // lock — so the row lock threw "permission denied" under the RLS role. A
    // transaction-scoped advisory lock keyed on the thread id gives the same
    // mutual exclusion without needing table UPDATE privilege (same pattern as
    // thread dedup in thread.ts).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadId}, 0))`)
    // Count under the advisory lock (concurrent removers block above until
    // commit). HUMANS only, the same predicate the three read-side counts use:
    // an agent seat is not somebody who can be left alone in a room, so counting
    // it here would let the last person leave whenever an agent had been added.
    const locked = await tx
      .select({ id: threadParticipants.id })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.participantType, "user"),
        ),
      )
    if (locked.length <= 1) {
      throw new HTTPException(400, { message: "Cannot remove the last participant from a thread" })
    }

    const rows = await tx
      .delete(threadParticipants)
      .where(
        and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.userId, targetUserId)),
      )
      .returning({ id: threadParticipants.id })

    if (rows.length === 0) return false

    // Clean up stale thread state (mute, archive, read markers)
    await tx
      .delete(userThreadState)
      .where(and(eq(userThreadState.threadId, threadId), eq(userThreadState.userId, targetUserId)))
    await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId))

    await tx.queueEvent({
      app: "kernel",
      entity: "participant",
      action: "remove",
      entityId: threadId,
      orgId,
      actorId: userId,
      data: { threadId, userId: targetUserId },
    })
    return true
  })

  return { removed }
}

interface JoinChannelParams {
  orgId: string
  threadId: string
  userId: string
}

/**
 * A member of the org joins a DISCOVERABLE channel on their own (P4b-T09,
 * spec-home.md "One channel type"). Unlike `addParticipant`, the caller does
 * NOT have to be a participant already: being let in is precisely what the
 * discoverable flag grants. Everything else is the same seat: role 'member',
 * `participantType: 'user'`, its own `userThreadState` row.
 *
 * Returns `null` when the thread is not a discoverable channel of this org
 * (the route answers 404), and `{ added: false }` when the user is already a
 * member, so joining twice is a no-op rather than an error.
 */
export async function joinDiscoverableChannel(db: RlsClient, params: JoinChannelParams) {
  const { orgId, threadId, userId } = params

  const [thread] = await db
    .select({ id: threads.id, discoverable: threads.discoverable, title: threads.title })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId), eq(threads.discoverable, true)))
    .limit(1)
  if (!thread) return null

  const [existing] = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (existing) return { added: false }

  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(threadParticipants)
        .values({ threadId, orgId, userId, participantType: "user", role: "member" })
      await tx.insert(userThreadState).values({ userId, threadId, orgId }).onConflictDoNothing()

      const [user] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId))
      await tx.queueEvent({
        app: "kernel",
        entity: "participant",
        action: "add",
        entityId: threadId,
        orgId,
        actorId: userId,
        data: {
          threadId,
          userId,
          userName: user?.name,
          participantType: "user",
          agentId: null,
          agentName: null,
        },
      })
    })
  } catch (err: any) {
    // Two clicks on Join race to the same seat; the unique index settles it.
    if (err.code === "23505" || err.cause?.code === "23505") return { added: false }
    throw err
  }

  return { added: true }
}

interface AddAgentParticipantParams {
  orgId: string
  threadId: string
  agentId: string
  /** Whose action seated the agent, for the event's actor. */
  actorUserId: string
  /**
   * The message that SUMMONED the agent, when this seat is the auto-add half of
   * a mention or an `agents_ask` (spec-agents.md S9).
   *
   * The seat's `created_at` is the anchor `agentJoinPoint` slices the rendered
   * tail at, and the seat is always written AFTER the mention was persisted. So
   * a seat stamped `now()` anchors PAST the very message the agent was summoned
   * to answer, and the turn is assembled with no user message in it at all: the
   * model then answers from whatever else the prompt carries (the runtime
   * context's pending approvals block, the recalled memory block), which is the
   * cross-thread replay. Stamping the seat at the trigger message puts the
   * mention itself at the join point, and nothing before it.
   *
   * Omitted on an invite, which starts no turn and must NOT hand the invited
   * agent the room's backlog.
   */
  joinedAtMessageId?: string
  /**
   * A GUEST seat: seated to answer one question and unseated again when the
   * turn settles, so the room is never told about a membership that does not
   * outlive the answer. The `participant:add` event is skipped, the caller
   * skips the "added to the conversation" line, and the row is MARKED as a
   * guest through its `role`, so the unseat can tell a seat it may take back
   * from one somebody deliberately asked for.
   */
  silent?: boolean
  /**
   * An @mention seated this agent (D23a): the seat is recorded as a mention
   * seat, which does not turn the DM between two people into a group. Absent
   * means an add on purpose ("Add people", an invite, the agent a chat is
   * created with); such an add over an existing mention seat re-records it as
   * one, keeping its join point.
   */
  viaMention?: boolean
}

interface RemoveAgentParticipantParams {
  orgId: string
  threadId: string
  agentId: string
  /** Whose action unseated the agent, for the event's actor. */
  actorUserId?: string
  /** Skip the `participant:remove` event, the guest seat's other half. */
  silent?: boolean
  /**
   * Take back a GUEST seat only. A guest turn that ran while a person
   * mentioned the same agent finds a seat that was PROMOTED to a real one
   * (`role: 'member'`), and revoking that is revoking what the person asked
   * for.
   */
  onlyGuest?: boolean
}

/** What `role` marks a seat that lasts exactly one turn. */
export const AGENT_GUEST_SEAT_ROLE = SHARED_AGENT_GUEST_SEAT_ROLE

/**
 * Seat an AGENT in a thread (P4b-T14, S9's auto-add half). The same table and
 * the same shape as a human seat, per the home-messaging reading that agents
 * and humans are the same row: `participantType: 'agent'`, `agentId` set,
 * `userId` null, role 'member'.
 *
 * Idempotent, and it must say so: `null` when the agent already sits in this
 * thread, so the caller does not post a second "added" line. The ON CONFLICT
 * target NAMES the partial index's predicate (`agent_id IS NOT NULL`), without
 * which Postgres cannot plan against a partial unique index at all (42P10).
 */
/**
 * The subset of `agentIds` that names a LIVE agent of this org (S12). A mention
 * carries a uuid and nothing else: `parseMentions` validates its SHAPE, so a
 * nonexistent, foreign-org or archived id reaches the send route looking exactly
 * like a real one. Resolving the whole batch in ONE query before any dispatch is
 * what makes "an unresolvable mention addresses nobody" true: it can neither
 * seat an agent nor start a turn, and in particular never falls through to the
 * requester's own personal agent answering in a room it has no seat in.
 *
 * Order is not preserved and duplicates collapse; callers dispatch per id.
 */
export async function resolveLiveAgentIds(
  db: RlsClient,
  params: { orgId: string; agentIds: string[] },
): Promise<string[]> {
  const { orgId, agentIds } = params
  if (agentIds.length === 0) return []
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), isNull(agents.archivedAt)))
  return rows.map((r) => r.id)
}

/**
 * The ONE live agent seated in this thread, or null.
 *
 * FAIL CLOSED like every other resolution here: no seat and more than one seat
 * are both null, never a guess at which of two seated agents a message with no
 * mention was addressed to. A 1:1 agent chat has exactly one.
 */
export async function resolveSeatedAgentId(
  db: RlsClient | PrivilegedDb,
  params: { orgId: string; threadId: string },
): Promise<string | null> {
  const rows = await db
    .select({ id: threadParticipants.agentId })
    .from(threadParticipants)
    .innerJoin(agents, eq(agents.id, threadParticipants.agentId))
    .where(
      and(
        eq(threadParticipants.threadId, params.threadId),
        eq(threadParticipants.orgId, params.orgId),
        eq(threadParticipants.participantType, "agent"),
        isNull(agents.archivedAt),
      ),
    )
    .limit(2)
  return rows.length === 1 ? (rows[0].id ?? null) : null
}

/**
 * ONE live agent of this org whose handle matches, or null.
 *
 * FAIL CLOSED, the Buzz rule: zero rows and more than one row are both null,
 * never a guess at which of two agents the caller meant. `@base` is excluded
 * for the same reason a roster excludes it: it is the org's fallback speaker,
 * not a specialist anyone addresses by name. The handle is matched with and
 * without its leading `@` and in any case, because a model writes it every way.
 *
 * The same predicate `resolveLiveAgentIds` applies to a uuid mention, expressed
 * over handles: `agents_ask` and `agents_invite` both resolve through here, so
 * neither can admit an agent the mention path would refuse.
 */
export interface ResolvedLiveAgent {
  id: string
  handle: string
  displayName: string
  kind: "role" | "personal" | "system"
  /** Set on a personal agent: the person it acts for. */
  ownerUserId: string | null
  /** The owner's own name, so a refusal can name the PERSON to address. */
  ownerName: string | null
}

export async function resolveLiveAgentByHandle(
  db: RlsClient,
  params: { orgId: string; handle: string },
): Promise<ResolvedLiveAgent | null> {
  const bare = params.handle.trim().replace(/^@+/, "").toLowerCase()
  if (bare.length === 0 || bare === "base") return null
  const live = and(
    eq(agents.orgId, params.orgId),
    isNull(agents.archivedAt),
    ne(agents.handle, "@base"),
  )
  const columns = {
    id: agents.id,
    handle: agents.handle,
    displayName: agents.displayName,
    kind: agents.kind,
    ownerUserId: agents.ownerUserId,
    ownerName: users.name,
  }
  const byHandle = await db
    .select(columns)
    .from(agents)
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(live, inArray(sql`lower(${agents.handle})`, [bare, `@${bare}`])))
    .limit(2)
  if (byHandle.length === 1) return byHandle[0]
  if (byHandle.length > 1) return null
  // A person names an agent the way the app shows it ("Growth"), and a client
  // relays that word. Matched on the display name only when exactly one agent
  // carries it, so this never guesses between two, and only among role agents:
  // a personal agent is named after its owner, so "Riley" means the person.
  const byName = await db
    .select(columns)
    .from(agents)
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(live, eq(agents.kind, "role"), eq(sql`lower(${agents.displayName})`, bare)))
    .limit(2)
  return byName.length === 1 ? byName[0] : null
}

/**
 * The handles a person may address, for a refusal that has to say what exists
 * rather than leave the caller to guess again. The app's addressable rule: no
 * system agent and no colleague's personal agent, which the app never shows.
 */
export async function listLiveAgentHandles(
  db: RlsClient,
  params: { orgId: string; userId: string; excludeAgentId: string | null },
): Promise<string[]> {
  const rows = await db
    .select({ handle: agents.handle })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, params.orgId),
        isNull(agents.archivedAt),
        ne(agents.kind, "system"),
        ne(agents.handle, "@base"),
        or(ne(agents.kind, "personal"), eq(agents.ownerUserId, params.userId)),
        ...(params.excludeAgentId ? [ne(agents.id, params.excludeAgentId)] : []),
      ),
    )
    .orderBy(agents.handle)
    .limit(50)
  return rows.map((r) => r.handle)
}

export async function addAgentParticipant(db: RlsClient, params: AddAgentParticipantParams) {
  const { orgId, threadId, agentId, actorUserId } = params

  const [agent] = await db
    .select({ id: agents.id, displayName: agents.displayName, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  if (!agent) return null

  const [existing] = await db
    .select({
      id: threadParticipants.id,
      role: threadParticipants.role,
      seatOrigin: threadParticipants.seatOrigin,
      createdAt: threadParticipants.createdAt,
    })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.agentId, agentId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  // A DELIBERATE add that meets a GUEST seat PROMOTES it. Without this a person
  // who mentions the agent while its guest turn is still running gets no seat
  // at all (the insert is a no-op on the guest row), no "added" line, and then
  // the guest unseat deletes the seat they asked for. The promotion is a delete
  // plus an insert rather than an UPDATE because UPDATE on
  // kernel.thread_participants is REVOKEd from liaison_rls (0000_initial): seat
  // changes go through this service layer, never a column write.
  // D23a: an add ON PURPOSE over a seat an @mention made turns the room into a
  // group (the person chose to add the agent), so the seat is re-recorded as
  // an explicit one. It keeps its join point: the agent has been reading the
  // room since the mention.
  const upgradesMentionSeat =
    existing !== undefined &&
    !params.silent &&
    !params.viaMention &&
    existing.role !== AGENT_GUEST_SEAT_ROLE &&
    existing.seatOrigin === MENTION_SEAT_ORIGIN
  if (existing) {
    if (!upgradesMentionSeat && (params.silent || existing.role !== AGENT_GUEST_SEAT_ROLE)) {
      return null
    }
    await db
      .delete(threadParticipants)
      .where(eq(threadParticipants.id, existing.id))
      .returning({ id: threadParticipants.id })
  }

  // The seat's anchor: the summoning message when there is one, otherwise the
  // column default (`now()`).
  //
  // A summons from a HIDDEN reply (a reply the channel does not show) anchors
  // at the reply's ROOT instead. The seat anchors the agent's CHANNEL tail, and
  // a hidden reply is never in that tail: anchored on it, the channel history
  // began after a message the agent never saw, and the root it was asked about
  // (which the channel does show) fell before its seat.
  let joinedAt: Date | undefined = upgradesMentionSeat ? existing?.createdAt : undefined
  if (params.joinedAtMessageId && !upgradesMentionSeat) {
    const findMessage = async (id: string) => {
      const [row] = await db
        .select({
          createdAt: messages.createdAt,
          replyRootId: messages.replyRootId,
          alsoInChannel: messages.alsoInChannel,
        })
        .from(messages)
        .where(and(eq(messages.id, id), eq(messages.threadId, threadId), eq(messages.orgId, orgId)))
        .limit(1)
      return row
    }
    const trigger = await findMessage(params.joinedAtMessageId)
    const anchor =
      trigger?.replyRootId && !trigger.alsoInChannel
        ? ((await findMessage(trigger.replyRootId)) ?? trigger)
        : trigger
    if (anchor?.createdAt) joinedAt = anchor.createdAt
  }

  const inserted = await db
    .insert(threadParticipants)
    .values({
      threadId,
      orgId,
      agentId,
      participantType: "agent",
      role: params.silent ? AGENT_GUEST_SEAT_ROLE : "member",
      ...(params.viaMention ? { seatOrigin: MENTION_SEAT_ORIGIN } : {}),
      ...(joinedAt ? { createdAt: joinedAt } : {}),
    })
    .onConflictDoNothing({
      target: [threadParticipants.threadId, threadParticipants.agentId],
      where: sql`agent_id IS NOT NULL`,
    })
    .returning({ id: threadParticipants.id })
  if (inserted.length === 0) return null

  if (params.silent) return { added: true, agentHandle: agent.handle, agentName: agent.displayName }

  await db.queueEvent({
    app: "kernel",
    entity: "participant",
    action: "add",
    entityId: threadId,
    orgId,
    actorId: actorUserId,
    data: {
      threadId,
      userId: null,
      userName: null,
      participantType: "agent",
      agentId,
      agentName: agent.displayName,
      agentHandle: agent.handle,
      // The web applies the DM rule to its own copy of the seats (D23a).
      role: "member",
      seatOrigin: params.viaMention ? MENTION_SEAT_ORIGIN : null,
    },
  })

  return { added: true, agentHandle: agent.handle, agentName: agent.displayName }
}

/**
 * Unseat an AGENT from a thread. The counterpart of `addAgentParticipant`, and
 * deliberately NOT `removeParticipant`: that one is about people, with the
 * last-human guard, the creator and admin checks and the `user_thread_state`
 * cleanup an agent seat has none of.
 *
 * `silent` skips the `participant:remove` event, which is what a guest seat
 * wants: the room was never told the agent joined, so it must not be told it
 * left. Returns whether a row was actually deleted.
 */
export async function removeAgentParticipant(
  db: RlsClient,
  params: RemoveAgentParticipantParams,
): Promise<{ removed: boolean }> {
  const { orgId, threadId, agentId } = params

  const rows = await db
    .delete(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.agentId, agentId),
        eq(threadParticipants.orgId, orgId),
        eq(threadParticipants.participantType, "agent"),
        ...(params.onlyGuest ? [eq(threadParticipants.role, AGENT_GUEST_SEAT_ROLE)] : []),
      ),
    )
    .returning({ id: threadParticipants.id })
  if (rows.length === 0) return { removed: false }

  if (!params.silent) {
    await db.queueEvent({
      app: "kernel",
      entity: "participant",
      action: "remove",
      entityId: threadId,
      orgId,
      actorId: params.actorUserId ?? null,
      data: { threadId, userId: null, participantType: "agent", agentId },
    })
  }

  return { removed: true }
}
