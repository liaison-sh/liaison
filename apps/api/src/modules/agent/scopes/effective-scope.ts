// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Effective scope of a turn: pure computation, one function per room kind.
//
//   channel / group thread -> ceiling ∩ (∩ grants of every human member)
//   DM with one human      -> ceiling ∩ requester's grants
//   routine tick           -> ceiling (no requester, no floor)
//   delegation             -> requester's grants ∩ callee's ceiling (then the
//                             room floor); a routine tick's delegation uses the
//                             calling turn's effective scope as the bound
//
// Every intersection goes through `intersectScopes` from spawn-agent so the
// turn path agrees with the spawn path on `*`, `:*` globs and bare-prefix
// grants. The result is always an intersection, never a union: an agent can
// never lower the floor of the room it is speaking in.
//
// `withheldCapabilities` is the set of ceiling entries the room narrowed away.
// Those names are private to the requester; callers must never place them in
// a message shared into the room.

import { and, eq, isNull } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { agents } from "~/db/schema/kernel/agents"
import { resolveRoomFloor } from "~/modules/agent/scopes/room-floor"
import { intersectScopes, isScopeSubset } from "~/modules/agent/subruns/spawn-agent"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * The scopes a tool is judged against INSIDE a turn: the turn's effective
 * scope (ceiling ∩ grants, room floored) narrowed to the actor, exactly as
 * `buildToolSet` narrows the catalog. Outside an agent turn (no effective
 * scope on the frame: the MCP gateway, a direct API call) it is the actor's
 * own scopes. `buildToolSet`, `tool_search` and `list_locked_capabilities`
 * read this, so a tool outside the acting agent's ceiling is reported locked,
 * never loaded.
 *
 * One widening, and only up to the actor: a scope every member holds as
 * themself (`KERNEL_EVERY_MEMBER_SCOPES`, reporting a bug about Liaison) stays
 * when the actor holds it, whatever the agent's ceiling or the room. The
 * person could do the same thing in the app's own form, and every member of
 * any room holds it, so the room floor loses nothing to it either. The turn's
 * `effectiveScope` itself is left as computed.
 */
export function turnToolScopes(
  actorScopes: string[],
  frame: { effectiveScope?: string[] } | undefined,
): string[] {
  if (!frame?.effectiveScope) return actorScopes
  const narrowed = intersectScopes(frame.effectiveScope, actorScopes)
  const ownActs = KERNEL_EVERY_MEMBER_SCOPES.filter(
    (scope) => hasScope(scope, actorScopes) && !hasScope(scope, narrowed),
  )
  return ownActs.length > 0 ? [...narrowed, ...ownActs] : narrowed
}

/**
 * Channel or group thread: the agent ceiling intersected with the grants of
 * every human member currently in the room.
 *
 * An empty `memberGrants` (no human in the room) is not a channel turn: the
 * routine-tick and delegation cases have their own functions. It fails closed
 * to an empty scope rather than falling back to the ceiling.
 */
export function effectiveScopeChannel(ceiling: string[], memberGrants: string[][]): string[] {
  const [first, ...rest] = memberGrants
  if (first === undefined) return []
  const floor = rest.reduce((acc, grants) => intersectScopes(acc, grants), first)
  return intersectScopes(ceiling, floor)
}

/** DM with one human: the agent ceiling intersected with the requester alone. */
export function effectiveScopeDm(ceiling: string[], requesterGrants: string[]): string[] {
  return intersectScopes(ceiling, requesterGrants)
}

/**
 * Routine tick: the ceiling, unchanged. Intentional, not a placeholder: a
 * routine tick has no requester and therefore no floor. Returns a copy so
 * callers cannot mutate the stored ceiling through the result.
 */
export function effectiveScopeRoutineTick(ceiling: string[]): string[] {
  return [...ceiling]
}

/**
 * Agent-to-agent delegation: the delegation BOUND intersected with the callee's
 * ceiling. The bound is the grants of the person the request originates from
 * (what they would get addressing the callee directly); for a routine tick,
 * which has no person, it is the calling turn's effective scope. A delegation
 * never exceeds the person and never exceeds the callee's admin-set ceiling.
 */
export function effectiveScopeDelegation(
  callerEffectiveScope: string[],
  calleeCeiling: string[],
): string[] {
  return intersectScopes(callerEffectiveScope, calleeCeiling)
}

/**
 * Hand-off from one `kernel.agents` agent to another: loads the callee's
 * ceiling and bounds the delegated turn on both sides (the delegation bound,
 * see `effectiveScopeDelegation`, ∩ callee's ceiling). `withheld` is relative to the callee's ceiling,
 * the capability set the delegation could otherwise have used.
 *
 * The callee must be a live agent of `orgId`. An unknown, archived or
 * foreign-org callee throws rather than yielding a scope: an archived agent
 * no longer responds, and a delegation never crosses an org boundary. The
 * explicit org filter holds even if the RLS org GUC were misconfigured.
 *
 * Not the `sub_agent_definitions` spawn path: `spawnAgent()` keeps its own
 * parent ∩ role ∩ requested intersection.
 */
export async function delegateToAgent(
  db: RlsClient,
  orgId: string,
  callerEffectiveScope: string[],
  calleeAgentId: string,
): Promise<{ effectiveScope: string[]; withheld: string[] }> {
  const [callee] = await db
    .select({ scopeCeiling: agents.scopeCeiling })
    .from(agents)
    .where(and(eq(agents.id, calleeAgentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  if (!callee) {
    throw new Error(`delegation target ${calleeAgentId} is not a live agent of this org`)
  }
  const calleeCeiling = callee.scopeCeiling
  const effectiveScope = effectiveScopeDelegation(callerEffectiveScope, calleeCeiling)
  return { effectiveScope, withheld: withheldCapabilities(calleeCeiling, effectiveScope) }
}

/**
 * Ceiling entries absent from the effective scope, compared on exact string
 * form. Both inputs are already-resolved scope arrays, so no wildcard
 * expansion happens here. Names only, private to the requester.
 *
 * Deliberately exact for the Share anyway non-disclosure gate (S7): a ceiling
 * glob the requester holds only part of still counts, so a closed scope under
 * it refuses the share. The card's "withheld by the room" set is
 * `withheldByRoom`, which is scope aware.
 */
export function withheldCapabilities(ceiling: string[], effectiveScope: string[]): string[] {
  const kept = new Set(effectiveScope)
  return ceiling.filter((scope) => !kept.has(scope))
}

/**
 * What the OTHER members of the room took away: the capabilities this agent
 * would use in a DM with the requester (ceiling ∩ requester's grants) that the
 * room's effective scope does not cover. That is exactly what the card says
 * ("not everyone in this room has access") and what "Continue in a DM" gives
 * back. The requester's own missing grants are not withheld by the room, and a
 * DM withholds nothing.
 *
 * Scope aware, not string equality: a ceiling glob (`ads:*`) against a member's
 * concrete grants (`ads:campaigns:read`) resolves to the concrete scopes on
 * both sides, so a glob the room fully honours is never reported.
 */
export function withheldByRoom(
  ceiling: string[],
  requesterGrants: string[],
  effectiveScope: string[],
): string[] {
  return intersectScopes(ceiling, requesterGrants).filter(
    (scope) => !isScopeSubset([scope], effectiveScope),
  )
}

/**
 * Effective scope of one turn in `threadId`, whichever room case applies.
 * The room kind comes from `resolveRoomFloor`, which throws on a missing or
 * unsupported thread; that error propagates, it never degrades to the
 * unfloored routine-tick case. Delegation is not resolved here: a hand-off
 * has no thread of its own and goes through `delegateToAgent`.
 */
export async function computeEffectiveScopeForTurn(
  db: PrivilegedDb,
  orgId: string,
  threadId: string,
  requesterUserId: string,
  agentCeiling: string[],
): Promise<{ effectiveScope: string[]; withheld: string[]; roomPeople: string[] | null }> {
  const floor = await resolveRoomFloor(db, orgId, threadId, requesterUserId)
  let effectiveScope: string[]
  switch (floor.kind) {
    case "routine_tick":
      // No room and no requester: nothing is withheld from anyone.
      return {
        effectiveScope: effectiveScopeRoutineTick(agentCeiling),
        withheld: [],
        roomPeople: null,
      }
    case "dm":
      // A DM floor without the requester's grants fails closed to nothing.
      effectiveScope = effectiveScopeDm(agentCeiling, floor.memberGrants[0] ?? [])
      break
    case "channel":
      effectiveScope = effectiveScopeChannel(agentCeiling, floor.memberGrants)
      break
    default: {
      const unknownKind: never = floor
      throw new Error(`no effective scope case for room floor ${JSON.stringify(unknownKind)}`)
    }
  }
  return {
    effectiveScope,
    withheld: withheldByRoom(agentCeiling, floor.requesterGrants, effectiveScope),
    // The same people floor a shared resource's read (scope-taint.ts, rule 15e).
    roomPeople: floor.memberIds,
  }
}
