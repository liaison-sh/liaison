// SPDX-License-Identifier: FSL-1.1-ALv2
import { hasScope } from "~/modules/permissions/permissions"
import { actorSearchKeys } from "~/modules/sharing/service"

/**
 * Inputs for {@link buildPermissionFilter}. All values must come from the
 * authenticated actor context; callers should not let unauthenticated input
 * flow into `orgId`, `userId`, or `scopes`.
 *
 * `dimensionGrants` must already be expanded to the explicit allowed values
 * the caller wants to authorize. The kernel filter is agnostic to any
 * app-specific dimension semantics (e.g., Knowledge's sensitivity ladder);
 * apps that use level/ordered dimensions must pre-expand grants at the
 * service-layer boundary before invoking this builder.
 */
export interface AclFieldDeclaration {
  orgWideField: string
  userIdsField: string
  roleIdsField: string
}

export interface PermissionFilterInput {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  /** Every concrete read scope across all searchable entities for this org. */
  registeredReadScopes: string[]
  /** Every dimension column indexed across manifests for this org. */
  dimensionFields: string[]
  /**
   * Role ids the caller holds (JWT `roles` claim). Used only by the
   * `aclFieldDeclarations` role-share disjunct below — entities with no
   * `aclFields` declaration are unaffected. Empty/absent ⇒ no role disjunct
   * is emitted (a caller with no roles cannot match any role-share clause
   * anyway, but omitting the clause entirely keeps the filter string small).
   */
  roleIds?: string[]
  /**
   * Every distinct `aclFields` declaration across searchable entities (in
   * practice one, shared by every manifest that opts into the generic ACL
   * search primitive). Mirrors the `participant_ids` shape but for a
   * Drive-style org-wide + per-user + per-role ACL instead of a flat
   * participant list. Field names come entirely from the registrations —
   * this builder has no app-specific literals.
   */
  aclFieldDeclarations?: AclFieldDeclaration[]
}

function meiliEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function quoteList(values: string[]): string {
  return `[${values.map((v) => `"${meiliEscape(v)}"`).join(",")}]`
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

/**
 * Normalize raw grant values. The kernel filter only removes duplicates; it
 * does NOT interpret app-specific dimension namespaces or level orderings.
 * Callers from a specific app must perform per-app expansion (e.g., Knowledge
 * sensitivity-ladder expansion) before calling {@link buildPermissionFilter}.
 */
export function normalizeSearchDimensionGrants(
  grants: Record<string, string[]> = {},
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(grants)) normalized[key] = unique(values)
  return normalized
}

/**
 * Build a MeiliSearch `filter` expression that enforces:
 *   1. The actor's org isolates results,
 *   2. Only registered read scopes the actor is granted are visible,
 *   3. Threads and other participant-narrowed docs include only the actor's,
 *   4. Each declared dimension column is gated by the actor's grants.
 *
 * Returns `null` when no read scope is authorized — callers must short-circuit
 * to an empty result rather than issuing an unfiltered search.
 */
export function buildPermissionFilter(i: PermissionFilterInput): string | null {
  const authorized = i.registeredReadScopes.filter((rs) => hasScope(rs, i.scopes))
  if (authorized.length === 0) return null
  const dimensionGrants = normalizeSearchDimensionGrants(i.dimensionGrants)

  const clauses: string[] = []
  clauses.push(`org_id = "${meiliEscape(i.orgId)}"`)
  clauses.push(`read_scope IN ${quoteList(authorized)}`)
  clauses.push(`(NOT participant_ids EXISTS OR participant_ids = "${meiliEscape(i.userId)}")`)

  // Wildcard semantics: a global `dimensionGrants["*"] = ["*"]` (carried by
  // admin JWTs) authorises every dimension value across every app — emit no
  // per-dimension clause at all. Per-dimension wildcards `[dim]: ["*"]` skip
  // just that one dimension. Without this, an admin's filter degenerates to
  // `(NOT <dim> EXISTS)` for each dim and silently excludes any indexed doc
  // carrying a dimension value (e.g. Knowledge personal docs with
  // `sensitivity="internal"`).
  const hasGlobalWildcard = (dimensionGrants["*"] ?? []).includes("*")
  if (!hasGlobalWildcard) {
    for (const dim of i.dimensionFields) {
      const grants = dimensionGrants[dim] ?? []
      if (grants.includes("*")) continue
      if (grants.length > 0) {
        clauses.push(`(${dim} IN ${quoteList(grants)} OR NOT ${dim} EXISTS)`)
      } else {
        clauses.push(`(NOT ${dim} EXISTS)`)
      }
    }
  }

  // Generic ACL search primitive: mirrors participant_ids' "NOT EXISTS OR"
  // shape. A doc/entity is visible when either (a) it declares no aclFields
  // at all (NOT org_wide EXISTS — entities without the primitive are
  // unaffected, same as dimensionFields), (b) it is org-wide readable, (c)
  // the caller is on its per-user ACL, or (d) the caller holds a role on its
  // per-role ACL. roleIds is only appended when the caller actually has
  // roles — a roleless caller can never match a role-share clause, but
  // appending an empty `IN []` would still be syntactically fine; we omit it
  // purely to keep the filter string minimal and the intent explicit.
  // The role ACL also carries dimension-grant keys (modules/sharing: a share
  // to "whoever can access mailbox X" is projected as `dim:mail:inbox=X` and
  // its wildcard forms); the caller holds the matching keys through their own
  // dimension grants.
  const grantKeys = unique([...(i.roleIds ?? []), ...actorSearchKeys(i.dimensionGrants)])
  for (const decl of i.aclFieldDeclarations ?? []) {
    const roleIds = grantKeys
    const roleClause = roleIds.length > 0 ? ` OR ${decl.roleIdsField} IN ${quoteList(roleIds)}` : ""
    clauses.push(
      `(NOT ${decl.orgWideField} EXISTS OR ${decl.orgWideField} = true OR ` +
        `${decl.userIdsField} = "${meiliEscape(i.userId)}"${roleClause})`,
    )
  }

  return clauses.join(" AND ")
}
