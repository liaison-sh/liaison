// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO A TAINTED GATED WRITE'S APPROVAL WOULD BE SHOWN TO (scope-taint.ts, consequence 2).
//
// A gated call on a tainted turn does not execute: it parks an approval whose payload carries
// what the turn read. That approval is itself a place the data lands, so it may be staged only
// when everyone it surfaces to holds every scope the turn read:
//
//   - the REQUESTER, who watches and may withdraw it (and whose DM is the common case);
//   - every HUMAN MEMBER of the conversation it surfaces in, where its card is posted;
//   - the APPROVERS it is routed to. That third set is not judged here: it is NARROWED at
//     creation (`createApprovalRequest`) to the approvers holding every scope, so it never
//     widens the audience.
//
// The room members come from the same resolver the room floor uses (`resolveRoomFloor`), so
// "who is in this conversation" has one answer. A thread the resolver cannot place (missing,
// a hidden sub-run thread) fails CLOSED: the write is refused as before.

import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { threadParticipants, users } from "~/db/schema/kernel"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { resolveRoomFloor } from "~/modules/agent/scopes/room-floor"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { readerScopesOf } from "~/modules/agent/scopes/taint-read-scopes"
import { appScopeAliasProviders } from "~/modules/apps/runtime-helpers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

/** True when `grants` cover every scope in `taintScopes` (hierarchical `hasScope` matching). */
export function holdsEveryScope(
  grants: readonly string[],
  taintScopes: readonly string[],
): boolean {
  const granted = [...grants]
  return taintScopes.every((scope) => hasScope(scope, granted))
}

/**
 * Who a refused write would have disclosed to, for the refusal the model reads: the taint
 * scopes they lack and how many of them lack them (never who). `lacking` is null when it could
 * not be counted (an unknown taint, a failed lookup), which the message says as such.
 */
export type TaintAudienceGap = { missingScopes: string[]; lacking: number | null }

const UNCOUNTED_GAP: TaintAudienceGap = { missingScopes: [], lacking: null }

/** The taint scopes `grants` do not cover. */
function missingFrom(grants: readonly string[], taintScopes: readonly string[]): string[] {
  const granted = [...grants]
  return taintScopes.filter((scope) => !hasScope(scope, granted))
}

/** Accumulates the people lacking scopes into one gap (null while nobody lacks any). */
function gapCollector() {
  const missing = new Set<string>()
  let lacking = 0
  return {
    add(grants: readonly string[], taintScopes: readonly string[]): void {
      const lacks = missingFrom(grants, taintScopes)
      if (lacks.length === 0) return
      lacking += 1
      for (const scope of lacks) missing.add(scope)
    },
    gap(): TaintAudienceGap | null {
      return lacking === 0 ? null : { missingScopes: [...missing].sort(), lacking }
    },
  }
}

/** What is missing and how many members lack it, or null when the approval may be staged. */
export async function taintApprovalAudienceGapDetail(opts: {
  orgId: string
  threadId?: string
  requesterUserId: string
  requesterScopes: readonly string[]
  taintScopes: readonly string[]
}): Promise<({ audience: "requester" | "member" } & TaintAudienceGap) | null> {
  if (opts.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) {
    return { audience: "requester", ...UNCOUNTED_GAP }
  }
  // Inside a routine tick the turn's scopes are the ROUTINE's ceiling, while the card goes to
  // the owner, a person: judge that person by their own grants (as rule 6d does), or a routine
  // holding only a write scope could never stage a draft (its taint is the read sibling).
  let requesterScopes: readonly string[] = opts.requesterScopes
  if (currentRunContext()?.routineId && opts.requesterUserId) {
    try {
      const [member] = await loadOrgMemberGrants(opts.orgId, { userIds: [opts.requesterUserId] })
      if (member) requesterScopes = member.scopes
    } catch {
      // Keep the turn's scopes: the stricter answer.
    }
  }
  const requesterMissing = missingFrom(requesterScopes, opts.taintScopes)
  if (requesterMissing.length > 0) {
    return { audience: "requester", missingScopes: requesterMissing, lacking: 1 }
  }
  if (!opts.threadId) return null
  const threadId = opts.threadId
  try {
    const floor = await withPrivilegedDb(opts.orgId, "scope-taint-approval-audience", (db) =>
      resolveRoomFloor(db, opts.orgId, threadId, opts.requesterUserId),
    )
    if (floor.kind === "routine_tick") return null
    const collector = gapCollector()
    for (const grants of floor.memberGrants) collector.add(grants, opts.taintScopes)
    const gap = collector.gap()
    return gap ? { audience: "member", ...gap } : null
  } catch {
    return { audience: "member", ...UNCOUNTED_GAP }
  }
}

/**
 * The grants under which a declared sink's rows can be READ: `readerScopesOf`, the one
 * statement of the read/write sibling rule (taint-read-scopes.ts). Kept under this name for
 * the sink-readers judgement.
 */
export function sinkReaderScopes(sinkReadScope: string): string[] {
  return readerScopesOf(sinkReadScope)
}

/**
 * THE ONE AUDIENCE RULE FOR A TAINTED WRITE (scope-taint.ts, rule 6). Null when every user of
 * the org who can read what the write lands in (holds any of `readerScopes`) also holds every
 * scope the turn read, else the scopes they lack and how many of them lack them.
 *
 * A reader is judged on the grants the app really runs with: each user's effective grants
 * (`loadEffectivePermissions`: role and direct grants, the resolution the room floor and the
 * token issuer use), widened by the app's own scope aliases (`appScopeAliasProviders`, the
 * aliases the runtime applies before any of the app's handlers runs, so a granular holder of
 * that app who reads an `internal` table through its tools counts as its reader). `app` is the
 * namespace of the first reader scope. Every user of the org counts, whatever their status: a
 * suspended or deactivated account that is reactivated reads the sink as it then stands.
 *
 * What this cannot see, by construction:
 *   - It is POINT IN TIME. A read-scope grant made later (a new role, a new member, an
 *     accepted invitation) exposes rows written before it to someone who did not hold the
 *     turn's scopes; granting a read scope is an admin's disclosure decision.
 *   - It ignores DIMENSION grants and per-row ownership. A sink whose RLS also filters rows by
 *     a dimension or an owner makes some readers see fewer rows than counted here, which only
 *     over-counts readers (refuses more).
 *
 * An unknown taint is held by nobody, and a lookup that fails answers an uncounted gap: the
 * write is refused as before. Cost: one permission load per org user, on a tainted write only.
 */
export async function readersTaintGap(opts: {
  orgId: string
  readerScopes: readonly string[]
  taintScopes: readonly string[]
}): Promise<TaintAudienceGap | null> {
  if (opts.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) return UNCOUNTED_GAP
  const app = opts.readerScopes[0]?.split(":")[0] ?? ""
  const alias = appScopeAliasProviders.get(app)
  try {
    return await withPrivilegedDb(opts.orgId, "scope-taint-sink-readers", async (db) => {
      const members = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.orgId, opts.orgId))
      const collector = gapCollector()
      for (const member of members) {
        const { scopes } = await loadEffectivePermissions(db, member.id, opts.orgId)
        const asTheAppSeesThem = alias ? alias([...scopes]) : scopes
        const reads = opts.readerScopes.some((scope) => hasScope(scope, asTheAppSeesThem))
        if (reads) collector.add(scopes, opts.taintScopes)
      }
      return collector.gap()
    })
  } catch {
    return UNCOUNTED_GAP
  }
}

/**
 * The gap when the ONLY reader of a write is one person (scope-taint.ts, rule 6d): null when
 * that user's own effective grants hold every taint scope. An unknown taint, an unknown user
 * or a failed lookup is held by nobody.
 */
export async function selfReaderTaintGap(opts: {
  orgId: string
  userId: string
  taintScopes: readonly string[]
}): Promise<TaintAudienceGap | null> {
  if (opts.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) return UNCOUNTED_GAP
  try {
    const [member] = await loadOrgMemberGrants(opts.orgId, { userIds: [opts.userId] })
    if (!member) return UNCOUNTED_GAP
    const collector = gapCollector()
    collector.add(member.scopes, opts.taintScopes)
    return collector.gap()
  } catch {
    return UNCOUNTED_GAP
  }
}

/**
 * The gap when a write's ONLY readers are the requester and the human participants of the
 * conversation (scope-taint.ts, rule 6e: request_secret, whose row the secret_requests RLS
 * policy shows to exactly them). Read from `thread_participants` whatever the thread's type,
 * like the policy: a personal agent chat a person was added to counts that person too. Null
 * when they all hold every taint scope; an unknown taint, a user who is not found or a failed
 * lookup is held by nobody.
 */
export async function conversationReadersTaintGap(opts: {
  orgId: string
  threadId: string
  requesterUserId: string
  taintScopes: readonly string[]
  /** False: judge the participants other than the requester only (rule 11's post audience). */
  includeRequester?: boolean
}): Promise<TaintAudienceGap | null> {
  if (opts.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) return UNCOUNTED_GAP
  try {
    const participants = await withPrivilegedDb(
      opts.orgId,
      "scope-taint-conversation-readers",
      (db) =>
        db
          .select({ userId: threadParticipants.userId })
          .from(threadParticipants)
          .where(
            and(
              eq(threadParticipants.threadId, opts.threadId),
              eq(threadParticipants.orgId, opts.orgId),
              isNotNull(threadParticipants.userId),
            ),
          ),
    )
    const readerIds = [
      ...new Set([
        opts.requesterUserId,
        ...participants.flatMap((p) => (p.userId === null ? [] : [p.userId])),
      ]),
    ].filter((u) => opts.includeRequester !== false || u !== opts.requesterUserId)
    if (readerIds.length === 0) return null
    const members = await loadOrgMemberGrants(opts.orgId, { userIds: readerIds })
    if (members.length !== readerIds.length) return UNCOUNTED_GAP
    const collector = gapCollector()
    for (const member of members) collector.add(member.scopes, opts.taintScopes)
    return collector.gap()
  } catch {
    return UNCOUNTED_GAP
  }
}

/** The people (user participants) of `threadId`, deduplicated: a parked post's audience. */
export async function threadPeopleIds(orgId: string, threadId: string): Promise<string[]> {
  const rows = await withPrivilegedDb(orgId, "scope-taint-thread-people", (db) =>
    db
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.orgId, orgId),
          isNotNull(threadParticipants.userId),
        ),
      ),
  )
  return [...new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])))]
}

/**
 * Who among `userIds` (the people of a thread an agent post is about to create, rule 11) lacks
 * what the turn read, counted, never named. An id that resolves to no account of the org, an
 * unknown taint or a failed lookup is an uncounted gap (fail closed).
 */
export async function peopleTaintGap(opts: {
  orgId: string
  userIds: readonly string[]
  taintScopes: readonly string[]
}): Promise<TaintAudienceGap | null> {
  if (opts.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) return UNCOUNTED_GAP
  const ids = [...new Set(opts.userIds)]
  if (ids.length === 0) return null
  try {
    const members = await loadOrgMemberGrants(opts.orgId, { userIds: ids })
    if (members.length !== ids.length) return UNCOUNTED_GAP
    const collector = gapCollector()
    for (const member of members) collector.add(member.scopes, opts.taintScopes)
    return collector.gap()
  } catch {
    return UNCOUNTED_GAP
  }
}

/**
 * Accounts of the org with their effective grants (`loadEffectivePermissions`: role and direct
 * grants), whatever their status, narrowed to `userIds` when given (an id outside the org simply
 * does not come back). `threads_create` judges its title and references with it.
 */
export async function loadOrgMemberGrants(
  orgId: string,
  opts: { userIds?: readonly string[] } = {},
): Promise<{ id: string; scopes: string[] }[]> {
  return withPrivilegedDb(orgId, "scope-taint-org-member-grants", async (db) => {
    const conditions = [eq(users.orgId, orgId)]
    if (opts.userIds) {
      if (opts.userIds.length === 0) return []
      conditions.push(inArray(users.id, [...opts.userIds]))
    }
    const members = await db
      .select({ id: users.id })
      .from(users)
      .where(and(...conditions))
    const out: { id: string; scopes: string[] }[] = []
    for (const member of members) {
      const { scopes } = await loadEffectivePermissions(db, member.id, orgId)
      out.push({ id: member.id, scopes })
    }
    return out
  })
}
