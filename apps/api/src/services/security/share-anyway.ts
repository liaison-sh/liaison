// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Share anyway" (spec-security.md D4, S6, S7). When the room floor withheld a
// capability, the requester (and only the requester) may rerun that turn at
// `agent ceiling ∩ requester grants`, bypassing the room floor for this one
// turn. The resulting message keeps the rerun's requiredScopes and gains a
// disclosure list: a snapshot of the room's human members at the moment of
// disclosure, never a live grant. The messages SELECT policy (0060) then lets
// exactly those members read it, plus anyone who holds the scopes anyway.
//
// The scope is computed by 2a's `effectiveScopeDm`, the same `ceiling ∩
// requester` intersection a DM turn uses, so globs resolve identically. The
// room floor (`resolveRoomFloor` / `computeEffectiveScopeForTurn`) is
// deliberately not applied: bypassing it is the point of Share anyway.
//
// "Requester grants" here means the live grants intersected with the scopes the
// requester's own session carries, so the disclosure is never wider than either
// the database or the requester's current token (see the privileged block).
//
// No transaction is held across the model call. The turn check and the member
// snapshot run in one short RLS transaction, the rerun runs with none, and the
// shared messages are written in a second short RLS transaction. That second
// transaction also writes the disclosure's audit row (S6), so a disclosed
// message can never exist without the row naming who disclosed it, at what
// scope, and to whom.

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents, auditLog, messages, threadParticipants } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { rerunAgentTurn, resolveActingAgent } from "~/modules/agent/runtime/agent-service"
import { effectiveScopeDm, withheldCapabilities } from "~/modules/agent/scopes/effective-scope"
import { intersectScopes, isScopeSubset } from "~/modules/agent/subruns/spawn-agent"
import { resolveAuditAgentId } from "~/modules/audit/resolve-agent"
import { writeAuditLog } from "~/modules/audit/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { listBlockingNonDisclosableScopes } from "~/modules/permissions/scope-disclosure-policy"
import { sendMessage } from "~/modules/threads/message"
import { assertDisclosureUserIds, ShareAnywayError } from "~/services/security/disclosure-list"

const log = rootLogger.child({ module: "share-anyway" })

export { assertDisclosureUserIds } from "~/services/security/disclosure-list"

/** What the agent-turn entry point is asked to rerun. */
export type ShareAnywayRerunInput = {
  orgId: string
  threadId: string
  /** The requester's message that triggered the withheld turn. */
  turnId: string
  requesterId: string
  agentId: string
  /** `ceiling ∩ requester`: the rerun must run at exactly this scope. */
  effectiveScope: string[]
}

/** One message the rerun produced, not yet persisted. */
export type ShareAnywayRerunMessage = {
  content: string
  /** The rerun turn's accumulated requiredScopes. */
  requiredScopes: string[]
  agentAuthorLabel?: string
  metadata?: unknown
}

export type ShareAnywayRerun = (input: ShareAnywayRerunInput) => Promise<ShareAnywayRerunMessage[]>

export type ShareAnywayScope =
  | { ok: true; scope: string[] }
  | { ok: false; nonDisclosable: string[] }

/** The production rerun: the real agent turn, at the given scope, not persisted. */
export const agentTurnRerun: ShareAnywayRerun = async (input) => [await rerunAgentTurn(input)]

/** What one disclosure records (spec-security.md S6, "Audit rows"). */
export type ShareAnywayAuditRow = {
  orgId: string
  /** Who disclosed: the requester who pressed Share anyway. */
  requesterId: string
  /** The agent that acted in the withheld turn, recorded independently of the human. */
  agentId: string
  roomId: string
  /** The requester's message whose turn was rerun. */
  turnId: string
  /**
   * The withheld card's own message id: the disclosure's identity, and the
   * idempotency key. One user message can fire SEVERAL agents, so the turn id
   * is shared by every card it produced and identifies none of them.
   */
  withheldMessageId?: string
  /** What scope was disclosed: the rerun's `ceiling ∩ requester`. */
  effectiveScope: string[]
  /** To whom: the room's human members at the moment of disclosure. */
  disclosedTo: string[]
  /** The disclosed messages this call wrote. */
  messageIds: string[]
}

export type ShareAnywayAuditWrite = (db: RlsClient, row: ShareAnywayAuditRow) => Promise<void>

/**
 * Writes the disclosure's audit row on the caller's own client, so it commits
 * with the disclosed message or not at all.
 *
 * It goes through the central `writeAuditLog` stamp with `required: true`: the
 * default best-effort behaviour swallows a failed insert so the original
 * operation still succeeds, which is exactly backwards here (a disclosure whose
 * audit row was dropped is an unrecorded disclosure), but everything else the
 * stamp does -- run linkage, the uuid-shape guard -- belongs on this row too.
 *
 * The agent id is resolved against the org FIRST. `audit_log.agent_id` carries
 * a composite `(agent_id, org_id)` foreign key, so naming an agent that has
 * since been DELETED aborted the insert and took the disclosure and its message
 * down with it; and because this runs inside the caller's open transaction,
 * nothing downstream can retry it. A deleted agent therefore costs the row its
 * agent NAME and nothing more, which is what every other audit path settled on.
 * A genuine write failure still propagates and rolls the disclosure back.
 */
export const writeShareAnywayAudit: ShareAnywayAuditWrite = async (db, row) => {
  await writeAuditLog(
    db,
    {
      orgId: row.orgId,
      actorId: row.requesterId,
      actorType: "user",
      app: "kernel",
      entityType: "thread",
      entityId: row.roomId,
      action: "share_anyway",
      agentId: await resolveAuditAgentId(db, row.orgId, row.agentId),
      requesterUserId: row.requesterId,
      roomMemberSnapshot: row.disclosedTo,
      effectiveScope: row.effectiveScope,
      disclosureList: row.disclosedTo,
      metadata: {
        turnId: row.turnId,
        messageIds: row.messageIds,
        // The acting agent, as the caller named it: `agent_id` above is
        // NULLED for an agent that has since been deleted, so it cannot carry
        // the idempotency key's secondary guard.
        agentId: row.agentId,
        ...(row.withheldMessageId ? { withheldMessageId: row.withheldMessageId } : {}),
      },
    },
    { required: true },
  )
}

/**
 * The Share anyway scope: the agent ceiling intersected with the requester's
 * own grants, unless an admin has closed the door on what it would disclose.
 *
 * The non-disclosable gate (S7) is checked against the WITHHELD set only, the
 * ceiling entries the intersection does not cover, because those are the
 * capabilities this action would newly disclose. A scope the requester already
 * holds is not disclosed by sharing, so marking it non-disclosable does not
 * block the turn.
 *
 * ONE non-disclosable withheld scope refuses the WHOLE action, per the task
 * text's "if any such withheld scope has `disclosable = false`". The card's
 * offer is the turn, not a per-scope menu: a partial share would silently hand
 * back a narrower answer than the requester asked for, and the requester is
 * offered "Continue in a DM" instead.
 *
 * The match is scope-aware in both directions, not string equality: a withheld
 * entry is a raw ceiling string, so it is routinely a glob (`finance:*`) while
 * the admin closed a concrete capability (`finance:payouts:read`). A withheld
 * glob that COVERS a closed scope is refused, and so is a withheld scope COVERED
 * by a closed glob (`listBlockingNonDisclosableScopes`, on the same wildcard
 * `hasScope` rules the visibility predicate uses).
 *
 * The read fails closed (P2b-T09): an unreadable policy reports every withheld
 * scope as non-disclosable, so losing the table refuses rather than discloses.
 */
export async function computeShareAnywayScope(
  db: RlsClient,
  orgId: string,
  agentCeiling: string[],
  requesterGrants: string[],
): Promise<ShareAnywayScope> {
  const scope = effectiveScopeDm(agentCeiling, requesterGrants)
  const nonDisclosable = await listBlockingNonDisclosableScopes(
    db,
    orgId,
    withheldCapabilities(agentCeiling, scope),
  )
  if (nonDisclosable.length > 0) return { ok: false, nonDisclosable }
  return { ok: true, scope }
}

/**
 * The agent that authored the withheld card, with its live ceiling. Null when
 * the card is not in this room, names no agent, or names one this org has
 * since archived: all three are "no agent to rerun as", and the caller's own
 * mismatch check turns a card authored by a DIFFERENT agent into the same
 * refusal a hand-picked agent id gets.
 */
async function resolveCardAgent(
  tx: PrivilegedDb,
  orgId: string,
  roomId: string,
  withheldMessageId: string,
  agentId: string,
): Promise<{ id: string; scopeCeiling: string[] } | null> {
  const [card] = await tx
    .select({ authorAgentId: messages.authorAgentId })
    .from(messages)
    .where(
      and(
        eq(messages.id, withheldMessageId),
        eq(messages.threadId, roomId),
        eq(messages.orgId, orgId),
      ),
    )
    .limit(1)
  if (!card?.authorAgentId) return null
  if (card.authorAgentId !== agentId) return { id: card.authorAgentId, scopeCeiling: [] }
  const [agent] = await tx
    .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  return agent ?? null
}

/**
 * Reruns a withheld turn at `ceiling ∩ requester` and persists its result with
 * the room's current human members as the disclosure list.
 *
 * `requester` is the requester's own context: every read and write runs under
 * it. `turnId` is the requester's message that triggered the withheld turn: a
 * turn someone else started cannot be shared by a different member. Nothing is
 * persisted when the rerun reports requiredScopes outside the computed scope
 * (fail closed).
 */
export async function shareAnyway(
  requester: UserContext,
  params: {
    turnId: string
    requesterId: string
    roomId: string
    agentId: string
    /**
     * The withheld card this share belongs to. The route always has it; it is
     * what binds the disclosure to ONE card when a turn produced several.
     */
    withheldMessageId?: string
  },
  deps: { rerun: ShareAnywayRerun; writeAudit?: ShareAnywayAuditWrite } = {
    rerun: agentTurnRerun,
  },
): Promise<{ messageIds: string[] }> {
  const writeAudit = deps.writeAudit ?? writeShareAnywayAudit
  const { turnId, requesterId, roomId, agentId, withheldMessageId } = params
  const orgId = requester.orgId
  if (!orgId || requester.actorType !== "user" || requester.userId !== requesterId) {
    throw new ShareAnywayError(
      "E_SHARE_ANYWAY_NOT_REQUESTER",
      "Share anyway must run in the requester's own session",
    )
  }

  const disclosureList = await withRlsContext(requester, async (db) => {
    const [turn] = await db
      .select({ authorId: messages.authorId, authorType: messages.authorType })
      .from(messages)
      .where(and(eq(messages.id, turnId), eq(messages.threadId, roomId), eq(messages.orgId, orgId)))
      .limit(1)
    if (!turn) {
      throw new ShareAnywayError("E_SHARE_ANYWAY_TURN_NOT_FOUND", `turn ${turnId} not in room`)
    }
    if (turn.authorId !== requesterId || turn.authorType !== "user") {
      throw new ShareAnywayError(
        "E_SHARE_ANYWAY_NOT_REQUESTER",
        "only the member who started the turn can share it",
      )
    }
    // The snapshot is taken before the rerun, so a member who joins while it
    // runs is not disclosed to.
    const members = await db
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, roomId),
          eq(threadParticipants.orgId, orgId),
          // Human members only: an agent participant row (user_id NULL since
          // 0075) is not a disclosure recipient, and a NULL in the list would
          // be a hole in the audience the audit row records.
          isNotNull(threadParticipants.userId),
        ),
      )
      .orderBy(asc(threadParticipants.createdAt), asc(threadParticipants.userId))
    return members.flatMap((m) => (m.userId === null ? [] : [m.userId]))
  })
  assertDisclosureUserIds(disclosureList)

  // ALREADY SHARED. Share anyway is one button on one card, and a second press
  // used to rerun the model and post a SECOND disclosed answer into the room:
  // the same question answered twice, billed twice, and read by everyone as
  // two separate disclosures. The disclosure's own audit row is the record of
  // what was shared, so it is also the idempotency key: the same requester
  // pressing the same CARD gets back the ids it already wrote. A rerun of a
  // read-only turn can answer differently anyway, so "share it again" is not
  // even a well-formed request.
  //
  // The key is the CARD, never the turn. One channel message fires every agent
  // it mentions, each with the same `turnId`, so a turn-keyed row matched the
  // first agent's disclosure when the requester shared the second agent's card:
  // agent A's message ids came back, agent B was never rerun, and the requester
  // was told its answer had been disclosed. The acting agent is a secondary
  // guard on the same row, so neither half of the pair can match alone.
  const alreadyShared = await withPrivilegedDb(orgId, "share-anyway-idempotency", async (tx) => {
    const [row] = await tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.action, "share_anyway"),
          eq(auditLog.entityId, roomId),
          eq(auditLog.requesterUserId, requesterId),
          withheldMessageId
            ? sql`${auditLog.metadata} ->> 'withheldMessageId' = ${withheldMessageId}`
            : sql`${auditLog.metadata} ->> 'turnId' = ${turnId}`,
          sql`${auditLog.metadata} ->> 'agentId' = ${agentId}`,
        ),
      )
      .orderBy(asc(auditLog.timestamp))
      .limit(1)
    const ids = (row?.metadata as { messageIds?: unknown } | null)?.messageIds
    return Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? (ids as string[])
      : null
  })
  if (alreadyShared) return { messageIds: alreadyShared }

  const { agentCeiling, requesterGrants } = await withPrivilegedDb(
    orgId,
    "share-anyway-scope",
    async (tx) => {
      // The rerun acts as the agent that acted in the withheld turn, never one
      // the caller picks. When the card is named, the card's own row is the
      // record of who acted (`author_agent_id`, which 0080 refuses to leave
      // empty) -- and it is the only authority that survives a turn several
      // agents answered, where "the requester's personal agent" names at most
      // one of them. Without a card, the turn is the requester's own message,
      // so its acting agent is the one a requester's turn resolves to (routine
      // ticks have no room floor, so they never withhold and never reach here).
      const agent = withheldMessageId
        ? await resolveCardAgent(tx, orgId, roomId, withheldMessageId, agentId)
        : await resolveActingAgent(tx, orgId, requesterId, undefined)
      if (!agent) {
        throw new ShareAnywayError(
          "E_SHARE_ANYWAY_AGENT_NOT_FOUND",
          "the requester has no live acting agent in this org",
        )
      }
      if (agent.id !== agentId) {
        throw new ShareAnywayError(
          "E_SHARE_ANYWAY_AGENT_MISMATCH",
          `agent ${agentId} did not act in turn ${turnId}`,
        )
      }
      // The requester's grants are the NARROWER of what the database says they
      // hold right now and what their own session carries, never either side
      // on its own.
      //
      // The two disagree in both directions, because `middleware/auth.ts`
      // builds a session's scopes from the JWT CLAIM while these rows are read
      // live:
      //
      //   - a scope REVOKED since the token was minted is still in the token,
      //     so the token alone would disclose a capability the admin has taken
      //     away.
      //   - a scope GRANTED since the token was minted is not in the token yet.
      //     Every other route in the product refuses it until the requester
      //     re-authenticates, so the live rows alone would let this one action
      //     disclose at a scope no other surface in the system honours, which
      //     is an elevation relative to the rest of the product.
      //
      // `intersectScopes` is the glob-aware intersection the turn path uses, so
      // `finance:*` on one side and `finance:read` on the other resolve to the
      // narrower of the two rather than to nothing.
      const live = (await loadEffectivePermissions(tx, requesterId, orgId)).scopes
      const grants = intersectScopes(live, requester.scopes)
      return { agentCeiling: agent.scopeCeiling, requesterGrants: grants }
    },
  )

  // A short read on the requester's own client: 0068's SELECT policy is open to
  // every member of the org precisely so this check can run for any requester.
  // It runs before the rerun, so a refused share never reaches the model.
  const computed = await withRlsContext(requester, (db) =>
    computeShareAnywayScope(db, orgId, agentCeiling, requesterGrants),
  )
  if (!computed.ok) {
    // The scope NAMES stay server-side. The route hands a ShareAnywayError's
    // message back to whoever asked, and a closed scope's name is exactly the
    // kind of thing A14 keeps off the requester's screen: it says which app an
    // admin locked down and what it is called. The code is the whole answer
    // the requester needs, and the log is where an admin reads the rest.
    log.info(
      { requesterId, roomId, turnId, nonDisclosable: computed.nonDisclosable },
      "share anyway refused: the withheld scope is not disclosable",
    )
    throw new ShareAnywayError(
      "E_SCOPE_NOT_DISCLOSABLE",
      "the withheld capability is not disclosable here",
    )
  }
  const scope = computed.scope

  // No transaction is open here: the rerun may hold a model call for minutes.
  //
  // The rerun READS ONLY. D4 says it "re-runs the turn", but replaying the
  // turn's tool calls would repeat their side effects: a withheld turn that
  // sent mail or opened a ticket would do it a second time because the
  // requester asked to see the answer. `rerunAgentTurn` therefore runs with a
  // read-only catalog (modules/agent/runtime/read-only-run.ts); a write the model
  // attempts comes back refused and the rerun answers with what it could read.
  const results = await deps.rerun({
    orgId,
    threadId: roomId,
    turnId,
    requesterId,
    agentId,
    effectiveScope: scope,
  })
  for (const result of results) {
    const outside = result.requiredScopes.filter((s) => !isScopeSubset([s], scope))
    if (outside.length > 0) {
      throw new ShareAnywayError(
        "E_SHARE_ANYWAY_SCOPE_WIDENED",
        "the rerun reported scopes outside ceiling and requester",
      )
    }
  }

  const messageIds = await withRlsContext(requester, async (db) => {
    const ids: string[] = []
    for (const result of results) {
      // The disclosure list is written with the row and carried on its create
      // event, so the message never exists without it.
      const sent = await sendMessage(db, {
        orgId,
        userId: requesterId,
        threadId: roomId,
        content: result.content,
        authorType: "agent",
        // The rerun ran no ALS frame around this persist, so the acting agent
        // is handed over explicitly, exactly as the audit row below records it
        // (A11). Without it the disclosed message audits as an agent action
        // naming no agent, and the two halves of one disclosure disagree.
        agentId,
        agentAuthorLabel: result.agentAuthorLabel,
        metadata: result.metadata,
        requiredScopes: result.requiredScopes,
        disclosureList,
      })
      if (!sent) {
        throw new ShareAnywayError("E_SHARE_ANYWAY_NOT_PERSISTED", "requester is not in the room")
      }
      ids.push(sent.id)
    }
    // Same transaction as the messages above: the disclosure and its audit row
    // commit together, so a failed audit write rolls the disclosure back and
    // the disclosed-to members never see it.
    await writeAudit(db, {
      orgId,
      requesterId,
      agentId,
      roomId,
      turnId,
      withheldMessageId,
      effectiveScope: scope,
      disclosedTo: disclosureList,
      messageIds: ids,
    })
    return ids
  })
  return { messageIds }
}
