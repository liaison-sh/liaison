// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"

const log = rootLogger.child({ service: "agents" })
const K = sql.raw(schemaRef("kernel"))

/** One statement, bounded: a boot step must never sit on a lock. */
const STATEMENT_TIMEOUT_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000

export interface BaseCeilingReconcileResult {
  /** How many agents gained at least one scope. */
  updated: number
  /** The agents that did, for the log and the tests. */
  agentIds: string[]
}

/**
 * Bring every stored copy of the common agent base up to the constant.
 *
 * `COMMON_AGENT_BASE_SCOPES` is code, but each non personal agent stores a copy
 * in `kernel.agents.scope_ceiling` when it is created (`@base`, base-agent.ts)
 * or provisioned (`composeRoleAgentCeiling`, cli/provisioners/agents.ts). This
 * adds whatever the constant has gained since to every LIVE agent of kind
 * `role` or `system`, in every org, in ONE set based UPDATE:
 *
 * - additive only: missing base scopes are appended after the row's own
 *   entries, in the constant's order; nothing is removed or reordered, so a
 *   ceiling an administrator widened keeps every extra scope;
 * - `personal` agents are never touched: their ceiling is re-derived from the
 *   owner's grants (∩ `ceiling_restriction`, 0218), and the base is not theirs
 *   to receive unless the owner holds it. `ceiling_restriction` is written for
 *   personal agents only, so no row this touches carries one;
 * - sub-agent definitions (`kernel.sub_agent_definitions`) are not agents: their
 *   ceiling is bounded by the owning app's grants, and an empty one is a
 *   documented "no scope" role, so the base has no business there;
 * - archived agents are left as they are: they run no turn;
 * - idempotent: only rows missing a base scope match, so a second run writes
 *   nothing. The base holds no admin scope (`assertNoAdminScopesInRoleCeiling`
 *   passes on it), so adding it cannot make a role ceiling invalid.
 *
 * Runs as liaison_admin (`withSystemDb`, BYPASSRLS): `kernel.agents` forces row
 * level security, and a role without it would see no row and update none. The
 * personal-agent trigger (0210, 0218) returns early for these kinds anyway.
 *
 * Nothing caches a stored ceiling across turns: each turn reads the acting
 * agent's row (agent-service.ts), so the next turn sees the new ceiling. A turn
 * already running keeps the snapshot it started with.
 */
export async function reconcileAgentBaseCeilings(): Promise<BaseCeilingReconcileResult> {
  const base = JSON.stringify(COMMON_AGENT_BASE_SCOPES)
  const rows = await withSystemDb("reconcile-agent-base-ceilings", async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`))
    return tx.execute<{ id: string }>(sql`
      UPDATE ${K}.agents a
         SET scope_ceiling = a.scope_ceiling || (
               SELECT jsonb_agg(b.s ORDER BY b.ord)
                 FROM jsonb_array_elements_text(${base}::jsonb) WITH ORDINALITY AS b(s, ord)
                WHERE NOT a.scope_ceiling @> jsonb_build_array(b.s)
             ),
             updated_at = now()
       WHERE a.kind IN ('role', 'system')
         AND a.archived_at IS NULL
         AND jsonb_typeof(a.scope_ceiling) = 'array'
         AND NOT a.scope_ceiling @> ${base}::jsonb
      RETURNING a.id::text AS id`)
  })
  const agentIds = [...rows].map((r) => r.id)
  return { updated: agentIds.length, agentIds }
}

/**
 * The setup step's wrapper (db/reconcile-catalog-boot.ts): logs what changed,
 * and on failure logs loudly and returns false instead of throwing, so a
 * server start is never blocked by it. The next start tries again.
 */
export async function runAgentBaseCeilingReconcile(): Promise<boolean> {
  try {
    const { updated, agentIds } = await reconcileAgentBaseCeilings()
    if (updated > 0) {
      log.warn({ updated, agentIds }, "Boot: agents gained the scopes the common base added")
    } else {
      log.info("Boot: every agent ceiling carries the common base")
    }
    return true
  } catch (err) {
    log.error(
      { err, alert: "agent_base_ceiling_reconcile_failed" },
      "Boot: reconciling agent ceilings with the common base failed, continuing without it",
    )
    return false
  }
}
