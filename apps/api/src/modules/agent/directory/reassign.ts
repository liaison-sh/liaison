// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handing one agent's skill or routine to another agent.
//
// This is the other half of archiving (`archive.ts`): an agent that still owns
// a shared routine, or a skill another agent's index references, cannot be
// archived, and until now nothing in the product could move that ownership, so
// the archive was simply unreachable for exactly the agents worth archiving.
//
// Only `owner_agent_id` moves. `author_user_id` / `owner_user_id` are
// PROVENANCE and stay where they are: who wrote a skill does not change
// because the work changed hands.

import { and, eq, isNull } from "drizzle-orm"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { writeAuditLog } from "~/modules/audit/service"

export type ReassignableAsset = "routines" | "skills"

export class ReassignTargetNotFoundError extends Error {
  readonly code = "reassign_target_not_found"
  constructor() {
    super("the new owner must be a live agent of this org")
    this.name = "ReassignTargetNotFoundError"
  }
}

export class ReassignAssetNotFoundError extends Error {
  readonly code = "reassign_asset_not_found"
  constructor() {
    super("no such skill or routine in this org")
    this.name = "ReassignAssetNotFoundError"
  }
}

/**
 * The row policies refused the move: either the caller does not own the asset
 * they are moving (0048's personal-owner rule) or they may not hand it to the
 * agent they named (a role agent needs `kernel:agents:admin`, and the caller's
 * own scopes must cover that agent's ceiling).
 *
 * The message names neither side: which agent an asset belongs to, and which
 * agents a caller may target, are both answers this route does not owe an
 * unauthorised caller.
 */
export class ReassignForbiddenError extends Error {
  readonly code = "reassign_forbidden"
  constructor() {
    super("you may not move that asset to that agent")
    this.name = "ReassignForbiddenError"
  }
}

/**
 * Postgres `insufficient_privilege`: a WITH CHECK clause refused the new row.
 *
 * The driver error arrives wrapped by the query builder, so the cause chain is
 * walked rather than the top-level object: matching only the outer error let
 * a refused transfer surface as a 500.
 */
function isRowPolicyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause) {
    if (typeof e === "object" && (e as { code?: unknown }).code === "42501") return true
    depth += 1
  }
  return false
}

/**
 * Moves `assetId`'s owner agent to `ownerAgentId`.
 *
 * The whole read-and-write runs on the CALLER'S OWN RLS client, so the row
 * policies decide. A privileged handle here made this route a hole straight
 * through 0048: anybody holding `kernel:routines:write` could retarget any
 * routine in the org, including another member's personal one, onto a role
 * agent with a far wider ceiling, which is a scope escalation dressed as
 * housekeeping.
 *
 * The target is resolved FIRST, against live agents of the caller's own org:
 * an archived agent is no owner to hand work to, and a foreign one is refused
 * by the composite (owner_agent_id, org_id) foreign key anyway, which would
 * surface as a 500 rather than the 404 a client can act on.
 *
 * Every transfer is audited: an asset changing hands is exactly the kind of
 * thing a later review asks about, and the row names both ends.
 */
export type ReassignAuditWrite = (
  db: RlsClient,
  row: {
    orgId: string
    actorId: string
    entityType: "routine" | "skill"
    entityId: string
    from: string | null
    to: string
  },
) => Promise<void>

/** The production audit write: the transfer's own row, on the transfer's own
 *  client, so it commits with the transfer or not at all. */
export const writeReassignAudit: ReassignAuditWrite = async (db, row) => {
  await writeAuditLog(
    db,
    {
      orgId: row.orgId,
      actorId: row.actorId,
      actorType: "user",
      app: "kernel",
      entityType: row.entityType,
      entityId: row.entityId,
      action: "asset_owner_agent_changed",
      changes: { ownerAgentId: { from: row.from, to: row.to } },
    },
    { required: true },
  )
}

export async function reassignAssetOwner(
  actor: UserContext,
  params: {
    asset: ReassignableAsset
    assetId: string
    ownerAgentId: string
  },
  deps: { writeAudit?: ReassignAuditWrite } = {},
): Promise<{ id: string; ownerAgentId: string }> {
  const writeAudit = deps.writeAudit ?? writeReassignAudit
  const { asset, assetId, ownerAgentId } = params
  const orgId = actor.orgId
  await withRlsContext(actor, async (tx) => {
    const [target] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, ownerAgentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .limit(1)
    if (!target) throw new ReassignTargetNotFoundError()

    const table = asset === "routines" ? routines : skills
    const [row] = await tx
      .select({ id: table.id, ownerAgentId: table.ownerAgentId })
      .from(table)
      .where(and(eq(table.id, assetId), eq(table.orgId, orgId)))
      .limit(1)
    if (!row) throw new ReassignAssetNotFoundError()

    // The UPDATE is where authorisation actually happens. `routines_update` /
    // `skills_update` (0048) already encode every rule this transfer has to
    // respect: only the owner of a personal agent may move its work, a role or
    // system agent may only be named by a caller holding `kernel:agents:admin`,
    // and the WITH CHECK half additionally requires the caller's own scopes to
    // cover the new owner's ceiling. Restating any of that here would be a
    // second, weaker copy of the policy.
    //
    // USING refuses the SOURCE by matching no row; WITH CHECK refuses the
    // TARGET by raising 42501. Both are the same answer to the caller.
    let updated: Array<{ id: string }>
    try {
      updated = await tx
        .update(table)
        .set({ ownerAgentId, updatedAt: new Date() })
        .where(and(eq(table.id, assetId), eq(table.orgId, orgId)))
        .returning({ id: table.id })
    } catch (err) {
      if (isRowPolicyViolation(err)) throw new ReassignForbiddenError()
      throw err
    }
    if (updated.length === 0) throw new ReassignForbiddenError()

    // SAME TRANSACTION as the UPDATE. `audit_log_insert_rls` takes a member's
    // own insert as long as the org matches, so the transfer's record does not
    // need a second, privileged transaction -- and it must not have one: a row
    // written after the commit leaves a window (and, on a failed insert, a
    // permanent state) where an asset has changed hands with nothing saying so,
    // behind a 500 that tells the caller it did not happen. Written here, a
    // failed audit insert aborts the transfer with it.
    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      entityType: asset === "routines" ? "routine" : "skill",
      entityId: assetId,
      from: row.ownerAgentId,
      to: ownerAgentId,
    })
  })
  return { id: assetId, ownerAgentId }
}
