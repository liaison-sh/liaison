// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { privilegedFrom, withPrivilegedDb } from "~/db/privileged"
import { type Agent, agents } from "~/db/schema/kernel/agents"
import { pickAgentAvatarColor } from "~/modules/agent/directory/avatar-color"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"

const BASE_AGENT_HANDLE = "@base"

/**
 * The full archive flow (T25: blocking checks, cascading skill disable,
 * the `@base` short-circuit) now lives in `archive.ts`, the single archive
 * entry point. Re-exported here so existing imports of `archiveAgent` /
 * `BaseAgentNotArchivableError` from this module keep working.
 */
export { archiveAgent, BaseAgentNotArchivableError } from "./archive"

/**
 * Core of `ensureBaseAgent`, taking an already-open privileged transaction —
 * so bootstrapRegister's own `withSystemDb` transaction can call this
 * directly instead of nesting a second pool-acquiring `withPrivilegedDb`
 * transaction inside the one it already holds.
 */
async function ensureBaseAgentTx(tx: PrivilegedDb, orgId: string): Promise<Agent> {
  const byHandle = and(eq(agents.orgId, orgId), eq(agents.handle, BASE_AGENT_HANDLE))
  // Read first: this runs on every message write, and an existing @base needs
  // neither the colour pick nor the insert.
  const [existing] = await tx.select().from(agents).where(byHandle).limit(1)
  if (existing) return existing

  await tx
    .insert(agents)
    .values({
      orgId,
      kind: "system",
      handle: BASE_AGENT_HANDLE,
      displayName: "Base",
      // The common base, never the column default `[]`: an empty ceiling left
      // @base unable to search tools, ask or hand off to another agent, or
      // read the knowledge it owns, while its prompt told it to hand off.
      scopeCeiling: [...COMMON_AGENT_BASE_SCOPES],
      avatarColor: await pickAgentAvatarColor(tx, orgId),
    })
    .onConflictDoNothing({ target: [agents.orgId, agents.handle] })

  const [row] = await tx.select().from(agents).where(byHandle)

  if (!row) {
    throw new Error(`ensureBaseAgent: no @base agent found for org ${orgId} after insert`)
  }
  return row
}

/**
 * Ensure the org has exactly one `kind='system'` agent, handle `@base`.
 * Idempotent: relies on the `(orgId, handle)` unique index (agents-org-handle-idx,
 * agents.ts) via `onConflictDoNothing`, mirroring the insert-with-
 * `onConflictDoNothing` seed pattern at seed-model-pricing.ts:26-41 (not
 * ensure-user.ts, which select-then-branches instead of relying on the
 * conflict target). Safe to call on every org bootstrap / request path;
 * a second call for the same org is a no-op and returns the existing row.
 *
 * Pass an already-open privileged transaction via `ensureBaseAgentTx`
 * directly (bootstrapRegister does this); this wrapper is for every other
 * caller that needs its own transaction.
 */
export async function ensureBaseAgent(orgId: string): Promise<Agent> {
  return withPrivilegedDb(orgId, "ensure-base-agent", (tx) => ensureBaseAgentTx(tx, orgId))
}

/**
 * `ensureBaseAgent` from a caller already holding a transaction.
 *
 * Through `privilegedFrom`: on the caller's own connection when its login can
 * step into liaison_admin (no second pool connection, which is what
 * `ensureBaseAgentTx` was factored out for: on the message write path the
 * caller already occupies a connection, and under pool pressure an inner
 * acquire on the SAME pool waits behind the transaction it is nested in).
 * From a request transaction on the request login, which cannot elevate, it
 * runs in its own transaction on the privileged pool, a different pool from
 * the caller's, so the nested acquire cannot wait on its own caller. The base
 * agent is an idempotent "ensure it exists", so committing on its own is
 * correct.
 */
export async function ensureBaseAgentOnTx(
  tx: Pick<RlsClient, "execute"> & Pick<PrivilegedDb, "select" | "insert">,
  orgId: string,
): Promise<Agent> {
  return privilegedFrom(tx, orgId, "ensure-base-agent", (ptx) => ensureBaseAgentTx(ptx, orgId))
}

export { ensureBaseAgentTx }
