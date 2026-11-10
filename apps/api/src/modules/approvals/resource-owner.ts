// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import {
  approvalResourceOwnerRegistry,
  type ResourceOwnerDecl,
} from "~/modules/apps/app-registries"

/**
 * Effective visibility of an owning account row: the explicit `visibility`
 * column when set ('personal' | 'shared'), else derived from `owner_type`
 * ('user' -> personal, anything else -> shared). Exported for unit tests.
 */
export function effectiveVisibility(row: {
  visibility?: string | null
  owner_type?: string | null
}): "personal" | "shared" {
  if (row.visibility === "personal" || row.visibility === "shared") return row.visibility
  return row.owner_type === "user" ? "personal" : "shared"
}

interface OwnerRow {
  owner_type: string | null
  owner_id: string | null
  visibility: string | null
}

/**
 * Resolve the personal-resource owner a gated tool call targets, per the
 * tool's declarative `resourceOwner` manifest entry (registered in
 * `approvalResourceOwnerRegistry`).
 *
 * Returns the owner's user id when the effective visibility of the owning
 * account is 'personal' and it is owned by a user; null in every other case
 * (no declaration, missing/invalid param, row not found, org/shared-owned, or
 * explicit visibility='shared' override on a user-owned account).
 *
 * Fail-open to NULL only in the "cannot resolve" sense: an unresolvable
 * target keeps today's org-visible routing rather than mis-assigning an
 * owner. Resolution runs under the privileged pool (routing metadata, not a
 * data read on behalf of the caller).
 */
export async function resolveApprovalResourceOwner(
  orgId: string,
  appName: string,
  toolShortName: string,
  toolParams: unknown,
  /** The user raising the approval: the owner under a `requester` declaration. */
  requestedBy?: string,
  /** The agent acting in the proposing turn (null: none), read by `actingAgentTree`. */
  actingAgentId?: string | null,
): Promise<string | null> {
  const decl = approvalResourceOwnerRegistry.get([orgId, appName, toolShortName])
  if (!decl) return null
  if ("actingAgentTree" in decl) return actingAgentTreeOwner(orgId, actingAgentId, requestedBy)
  const params =
    toolParams && typeof toolParams === "object" && !Array.isArray(toolParams)
      ? (toolParams as Record<string, unknown>)
      : {}
  if ("requesterAlways" in decl) return requestedBy ?? null
  if ("resolveOwner" in decl) {
    if (!requestedBy) return null
    try {
      return await decl.resolveOwner(params, { orgId, requestedBy })
    } catch (err) {
      log.error(
        { err, app: appName, tool: toolShortName },
        "resource-owner resolution failed; keeping org-visible approval routing",
      )
      return null
    }
  }
  if ("requester" in decl) {
    // The call creates a personal resource for the requester (no row exists
    // yet), so the requester IS its owner when the declared param says so.
    return params[decl.requester.param] === decl.requester.equals && requestedBy
      ? requestedBy
      : null
  }
  const rawId = params[decl.param]
  if (typeof rawId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(rawId)) return null

  try {
    return await withPrivilegedDb(orgId, "approval-resource-owner-resolve", async (tx) => {
      const schema = drizzleSql.raw(quoteIdent(schemaRef(`app_${appName}`)))
      const row = await loadOwnerRow(tx, schema, decl, rawId, orgId)
      if (!row) return null
      if (effectiveVisibility(row) !== "personal") return null
      if (row.owner_type !== "user" || !row.owner_id) return null
      return row.owner_id
    })
  } catch (err) {
    // Routing metadata must never make the gate itself fail — log and fall
    // back to the org-visible routing (the pre-existing behavior).
    log.error(
      { err, app: appName, tool: toolShortName },
      "resource-owner resolution failed; keeping org-visible approval routing",
    )
    return null
  }
}

/**
 * Who owns the acting agent's own resource (its memory tree, `memoryCtxForActingAgent`): a
 * personal agent's owner; the requester when no agent acts, whose own memory it then is; null
 * for a role or system agent, whose memory every user of that agent reads. An agent id that
 * names no agent of the org resolves like a role agent's (null): the org's deciders, narrowed
 * to holders of the turn's taint, never nobody.
 */
async function actingAgentTreeOwner(
  orgId: string,
  actingAgentId: string | null | undefined,
  requestedBy: string | undefined,
): Promise<string | null> {
  if (!actingAgentId) return requestedBy ?? null
  try {
    return await withPrivilegedDb(orgId, "approval-acting-agent-owner", async (tx) => {
      const rows = extractRows<{ owner_user_id: string | null }>(
        (await tx.execute(drizzleSql`
          SELECT owner_user_id FROM ${drizzleSql.raw(schemaRef("kernel"))}.agents
          WHERE id = ${actingAgentId}::uuid AND org_id = ${orgId}::uuid AND kind = 'personal'
          LIMIT 1`)) as never,
      )
      return rows[0]?.owner_user_id ?? null
    })
  } catch (err) {
    log.error(
      { err, actingAgentId },
      "acting-agent owner resolution failed; keeping org-visible approval routing",
    )
    return null
  }
}

async function loadOwnerRow(
  tx: PrivilegedDb,
  schema: ReturnType<typeof drizzleSql.raw>,
  decl: Extract<ResourceOwnerDecl, { table: string }>,
  rowId: string,
  orgId: string,
): Promise<OwnerRow | null> {
  const table = drizzleSql.raw(quoteIdent(decl.table))
  if (!decl.account) {
    // The target row IS the account-like owner carrier. Read via to_jsonb so a
    // manifest without an explicit `visibility` column still resolves.
    const rows = extractRows<{ data: Record<string, unknown> }>(
      (await tx.execute(drizzleSql`
        SELECT to_jsonb(t) AS data FROM ${schema}.${table} t
        WHERE t.id = ${rowId}::uuid AND t.org_id = ${orgId}::uuid
        LIMIT 1`)) as never,
    )
    return jsonbToOwnerRow(rows[0]?.data)
  }
  const accountTable = drizzleSql.raw(quoteIdent(decl.account.table))
  const joinCol = drizzleSql.raw(quoteIdent(decl.account.column))
  const rows = extractRows<{ data: Record<string, unknown> }>(
    (await tx.execute(drizzleSql`
      SELECT to_jsonb(a) AS data
      FROM ${schema}.${table} t
      JOIN ${schema}.${accountTable} a ON a.id = t.${joinCol} AND a.org_id = t.org_id
      WHERE t.id = ${rowId}::uuid AND t.org_id = ${orgId}::uuid
      LIMIT 1`)) as never,
  )
  return jsonbToOwnerRow(rows[0]?.data)
}

function jsonbToOwnerRow(data: Record<string, unknown> | undefined): OwnerRow | null {
  if (!data) return null
  const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
  return {
    owner_type: s(data.owner_type),
    owner_id: s(data.owner_id),
    visibility: s(data.visibility),
  }
}

// ── Routine owner as approver (S29, A33, A52) ───────────────────────────────

/** A routine's approver setting: the default deciding-scope audience, or its owner. */
export type RoutineApprover = "default" | "owner"

export interface RoutineApproverSetting {
  ownerUserId: string
  approver: RoutineApprover
}

/**
 * Read a routine's owner and approver setting (routines.approver, 0131; saved
 * through create/update_routine only when the owner may decide, P5-T4). Read
 * through `to_jsonb` so a database behind 0131 still answers "default".
 */
export async function loadRoutineApproverSetting(
  orgId: string,
  routineId: string,
): Promise<RoutineApproverSetting | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(routineId)) return null
  return withPrivilegedDb(orgId, "routine-approver-setting", async (tx) => {
    const k = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
    const [row] = extractRows<{ owner_user_id: string; approver: string | null }>(
      await tx.execute(drizzleSql`
        SELECT r.owner_user_id, to_jsonb(r)->>'approver' AS approver
        FROM ${k}.routines r
        WHERE r.id = ${routineId}::uuid AND r.org_id = ${orgId}::uuid
        LIMIT 1`),
    )
    if (!row) return null
    return {
      ownerUserId: row.owner_user_id,
      approver: row.approver === "owner" ? "owner" : "default",
    }
  })
}

/**
 * Where the approval-row path reads the setting from. An object so the
 * persistence task (and tests) can point it elsewhere without a module mock.
 */
export const routineApproverSource = {
  load: loadRoutineApproverSetting,
}

/**
 * May this user be the sole approver of a draft whose deciding scope is
 * `approveScope`? Only when they hold that scope (and cover its dimension
 * constraint, or bypass it as a super-admin), plus every scope in `mustHold`
 * (the proposing turn's taint: an owner-routed draft is read by the owner
 * alone, so the owner must hold what the turn read). Owner routing lets the
 * owner decide WITHOUT any scope check, so it is granted only to an owner who
 * could already decide the default-routed row. Call it when the setting is
 * saved and again when the approval row is created.
 */
export async function routineOwnerMayApprove(args: {
  orgId: string
  ownerUserId: string
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
  mustHold?: readonly string[]
}): Promise<boolean> {
  const { loadEffectivePermissions, hasScope } = await import("~/modules/permissions/permissions")
  const { bypassesDimensionConstraint, dimensionGrantCovers } = await import(
    "~/modules/permissions/eligible-approvers"
  )
  const perms = await withPrivilegedDb(args.orgId, "routine-owner-approver-perms", (tx) =>
    loadEffectivePermissions(tx, args.ownerUserId, args.orgId),
  )
  if (!hasScope(args.approveScope, perms.scopes)) return false
  if (
    args.dimensionConstraint &&
    !bypassesDimensionConstraint(perms.scopes) &&
    !dimensionGrantCovers(
      perms.dimensionGrants,
      args.dimensionConstraint.key,
      args.dimensionConstraint.values,
    )
  ) {
    return false
  }
  return (args.mustHold ?? []).every((scope) => hasScope(scope, perms.scopes))
}

/**
 * The owner a routine-raised approval routes to, or null for the default
 * audience: the routine's setting is `approver: "owner"` AND the owner may
 * approve (see `routineOwnerMayApprove`). Any failure keeps the default
 * routing, which is never less private than today's.
 */
export async function resolveRoutineOwnerApprover(args: {
  orgId: string
  routineId: string
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
  mustHold?: readonly string[]
}): Promise<string | null> {
  try {
    const setting = await routineApproverSource.load(args.orgId, args.routineId)
    if (setting?.approver !== "owner") return null
    const may = await routineOwnerMayApprove({ ...args, ownerUserId: setting.ownerUserId })
    return may ? setting.ownerUserId : null
  } catch (err) {
    log.error(
      { err, routineId: args.routineId },
      "routine owner approver resolution failed; keeping the default approval audience",
    )
    return null
  }
}
