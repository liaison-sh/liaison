// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * API-side adapter over the shared approval-authority core
 * (`@liaison/shared` → `packages/shared/src/approvals/authority.ts`).
 *
 * The shared core is pure and operates on camelCase FACTS; this adapter owns
 * the impedance match to the API's world: the canonical SELECT column set,
 * snake_case row → facts conversion, and the scopes-array viewer. Every
 * approval read surface (list / feed / decide / edit) builds its predicate
 * from here — never from a locally recomputed `<app>:approve`.
 */
import type { ApprovalAuthorityFacts, AuthorityViewer } from "@liaison/shared"
import { decidingScopeForToolDef } from "@liaison/shared"
import { appsLogger as log } from "~/lib/logger"
import { toolRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"

export type { ApprovalAuthorityFacts, AuthorityViewer } from "@liaison/shared"
export { canSeeInFeed, canSeeInList, decidingScope, decidingScopeForToolDef } from "@liaison/shared"

/** Snake_case row shape — satisfiable by
 *  every caller's `extractRows<T>` row type. */
export interface ApprovalAuthorityRow {
  tool_name: string
  approve_scope: string | null
  resource_owner_id: string | null
  requested_by: string
  notify_user_ids: string[] | null
}

/** Convert a DB row to authority facts. SQL NULL maps to explicit `null`; a
 *  missing column stays `undefined` and trips the shared shape guard. */
export function authorityFacts(row: ApprovalAuthorityRow): ApprovalAuthorityFacts {
  return {
    toolName: row.tool_name,
    approveScope: row.approve_scope,
    resourceOwnerId: row.resource_owner_id,
    requestedById: row.requested_by,
    notifyUserIds: row.notify_user_ids,
  }
}

/** Viewer over the API's scopes-array + hierarchical `hasScope`. */
export function apiViewer(userId: string, scopes: string[]): AuthorityViewer {
  return { userId, hasScope: (scope) => hasScope(scope, scopes) }
}

/**
 * Resolve, at PROPOSE time, the authority a new approval row must be created
 * with: the deciding scope (the tool's registry `approveScope` override or the
 * derived `<app>:approve`) and the optional dimension constraint. This is the
 * ONE resolver both gate paths use — the main dispatch and the
 * handler-conditional `ctx.requestApproval` path. The handler path previously
 * skipped it entirely, so rows it created lost their custom scope and fanned
 * out to the wrong approvers.
 *
 * Fail-closed on a throwing dimension resolver: the `__unresolved__` sentinel
 * matches no real dimension grant, so the audience collapses to super-admin
 * bypass holders (`*` / `kernel` / `kernel:approvals:admin`) rather than
 * silently widening to every approve-scope holder.
 */
export async function resolveToolApprovalAuthority(args: {
  orgId: string
  appName: string
  toolShortName: string
  params: unknown
}): Promise<{
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
}> {
  const tool = toolRegistry.get([args.orgId, args.appName, args.toolShortName])
  const approveScope = decidingScopeForToolDef(tool ?? {}, args.appName)
  let dimensionConstraint: { key: string; values: string[] } | null = null
  if (tool?.approvalDimension) {
    try {
      dimensionConstraint = await tool.approvalDimension(args.params, { orgId: args.orgId })
    } catch (err) {
      log.error(
        { err, appName: args.appName, toolShortName: args.toolShortName, orgId: args.orgId },
        "approvalDimension resolver failed — constraining approval to super-admins only (fail-closed)",
      )
      dimensionConstraint = { key: "__unresolved__", values: ["__unresolved__"] }
    }
  }
  return { approveScope, dimensionConstraint }
}

/**
 * The authority of an approval raised ONLY because the turn read scoped data (scope-taint.ts,
 * rule 8h): an ungated write that would have run inline on a clean turn. Its decision is a
 * disclosure, so it is decided by holding every scope the turn read, and by nothing more: no
 * `<app>:approve` (for kernel tools the admin-grade scope of role edits) and no dimension.
 *
 * `approve_scope` is one column. It persists the first taint scope (sorted, so the answer is
 * stable), and the row's `metadata.taintAudienceMustHold`, which every taint-parked row carries,
 * names all of them: the notified audience is narrowed to holders of all of them at creation
 * (createApprovalRequest), re-narrowed on an edit or restage (taint-narrow.ts), and decide and
 * edit re-check them on the decider's fresh grants. Every read surface then answers through
 * `decidingScope` as for any other row: a requester holding the taint may decide their own
 * request, so it folds out of other approvers' default feed as peer noise.
 *
 * Null for an empty taint: there is then nothing to decide by, and the caller keeps the tool's
 * own authority.
 */
export function taintDisclosureAuthority(taintScopes: readonly string[]): {
  approveScope: string
  dimensionConstraint: null
} | null {
  const first = [...new Set(taintScopes)].sort()[0]
  return first === undefined ? null : { approveScope: first, dimensionConstraint: null }
}
