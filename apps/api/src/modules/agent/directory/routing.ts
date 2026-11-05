// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routing lookup, steps 1-3 (P1a-T20): resolve a capability name to the one
 * agent that owns it, with no model call, for the deterministic case of
 * exactly one match.
 *
 * Call-order assumption (documented here since the dispatch call site does
 * not exist yet): spec-agents.md step 1 has a request arrive at a personal
 * agent first. `resolveRoute` is not that first stop — if the routing
 * target's own capability set (its personal skill/routine rows, plus every-
 * thing `@base` exposes to it via `agent_skill_index`) already covers the
 * request, this function is never called at all. `resolveRoute` only runs
 * once that personal surface comes up short, to decide whether some OTHER
 * named agent should take the request instead. The actual chat/mention
 * dispatch call site that invokes this function is built in slice 4b; this
 * task (T20) only builds the resolution function itself, a stub for 4b to
 * call.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"

export type RouteResult =
  | { kind: "single"; agentId: string }
  | { kind: "tie"; candidateAgentIds: string[] }
  | { kind: "none" }

/**
 * Resolve `requestedCapabilityName` to the agent(s), within `orgId`, whose
 * declared skill (`agent_skill_index`, T11/T13) or routine
 * (`routines.ownerAgentId`, T07) name matches it exactly.
 *
 * Runs on the privileged (BYPASSRLS) connection, like `agent_skill_index`'s
 * other write-adjacent readers (`skill-index.ts`): routing must see every
 * agent's capabilities org-wide, not just the rows RLS would let the calling
 * user see directly (routines RLS in particular only exposes a caller's own
 * or explicitly-shared routines, not a role agent's personal ones).
 *
 * `userId` is accepted for parity with the eventual call site's signature
 * and for future scope-aware narrowing; this deterministic single-match step
 * does not filter by it.
 */
export async function resolveRoute(
  orgId: string,
  userId: string,
  requestedCapabilityName: string,
): Promise<RouteResult> {
  void userId

  const agentIds = await withPrivilegedDb(orgId, "routing-resolve", async (tx) => {
    // D16: an archived agent vanishes from routing too — join `agents` and
    // require `archivedAt IS NULL` on both branches.
    const skillMatches = await tx
      .select({ agentId: agentSkillIndex.agentId })
      .from(agentSkillIndex)
      .innerJoin(agents, eq(agents.id, agentSkillIndex.agentId))
      .where(
        and(
          eq(agentSkillIndex.orgId, orgId),
          eq(agentSkillIndex.skillName, requestedCapabilityName),
          isNull(agents.archivedAt),
        ),
      )

    // routines.ownerAgentId is nullable during the migration-sequencing transition
    // (0048/T07) until 1b's backfill — exclude NULL-owned rows rather than let them
    // flow into the candidate set as a bogus `agentId: null`.
    const routineMatches = await tx
      .select({ agentId: routines.ownerAgentId })
      .from(routines)
      .innerJoin(agents, eq(agents.id, routines.ownerAgentId))
      .where(
        and(
          eq(routines.orgId, orgId),
          eq(routines.name, requestedCapabilityName),
          isNotNull(routines.ownerAgentId),
          isNull(agents.archivedAt),
        ),
      )

    return [...skillMatches, ...routineMatches].map((row) => row.agentId as string)
  })

  const distinctAgentIds = Array.from(new Set(agentIds))

  if (distinctAgentIds.length === 0) return { kind: "none" }
  if (distinctAgentIds.length === 1) return { kind: "single", agentId: distinctAgentIds[0] }

  // P1a-T21: more than one agent's capability set matches. Return the SHORT
  // candidate list (exactly these N agent ids), never the full org roster.
  // The model call that actually breaks this tie is NOT built here and does
  // not exist yet anywhere in the codebase: it belongs to whichever slice
  // wires routing into an actual chat turn (out of 1a's scope). A later
  // slice must not assume a tie-break model call already consumes this
  // `{ kind: "tie", ... }` result; it still needs to be built.
  return { kind: "tie", candidateAgentIds: distinctAgentIds }
}
