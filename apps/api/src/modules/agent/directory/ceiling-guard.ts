// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AgentKind } from "~/db/schema/kernel/agents"
import { hasScope } from "~/modules/permissions/permissions"
import { isDeclaredScope, unknownScopes } from "~/modules/permissions/scope-registry"

/**
 * Thrown by assertNoAdminScopesInRoleCeiling when a `kind='role'` agent's
 * `scopeCeiling` contains an organization-administration scope. roster.md's
 * "no role agent gets admin scopes" rule: org administration (roles, scopes,
 * policies, invites) is reached only through personal agents, whose ceiling
 * equals the user's own grants.
 */
export class RoleAgentAdminScopeError extends Error {
  code = "role_agent_admin_scope"
  constructor(public readonly adminScopes: string[]) {
    super(`role agent scope ceiling contains admin scope(s): ${adminScopes.join(", ")}`)
    this.name = "RoleAgentAdminScopeError"
  }
}

/**
 * Thrown by assertNoAdminScopesInRoleCeiling when a `kind='role'` agent's
 * `scopeCeiling` holds an entry that is not a single scope (see
 * SCOPE_GRAMMAR), such as `tickets:*,kernel:*`, which the database would
 * split on the comma into two grants.
 */
export class RoleAgentInvalidScopeError extends Error {
  code = "role_agent_invalid_scope"
  constructor(public readonly invalidScopes: string[]) {
    super(
      `role agent scope ceiling contains entries that are not a single scope: ${invalidScopes.map((s) => JSON.stringify(s)).join(", ")}`,
    )
    this.name = "RoleAgentInvalidScopeError"
  }
}

/**
 * One scope, as hasScope and the database's scope parser read it: lowercase
 * segments of [a-z0-9_-] joined by ':', optionally ending in ':*', or '*'
 * alone. Anything else (a ',' the database splits into two grants,
 * whitespace, capitals, an empty segment, a wildcard that is not the last
 * segment) is not a scope and has no place in a ceiling.
 *
 * The HYPHEN is not cosmetic: the shopify app ships `shopify:draft-orders:read`
 * and `:write`, which the role editor's own validator (`roles-routes.ts`,
 * `/^[a-z0-9_:*-]+$/i`) accepts and this one used to refuse, so a ceiling
 * naming a real, grantable scope was rejected as malformed.
 */
const SCOPE_GRAMMAR = /^(?:\*|[a-z0-9_-]+(?::[a-z0-9_-]+)*(?::\*)?)$/

/**
 * The organization-administration scopes, per
 * apps/api/src/modules/permissions/scope-catalog.ts (the authoritative kernel
 * scope catalog) and roster.md's "roles, scopes, policies, invites" admin-only
 * list:
 *  - kernel:roles:admin          role CRUD (create_role/edit_role/delete_role)
 *  - kernel:scope_requests:admin deciding scope-access requests
 *  - kernel:policies:admin       approval-tightening policy config
 *  - kernel:users:admin          users/invites/role-assignment/per-user scope
 *                                grants (invite_user, assign_role,
 *                                remove_user_from_role, grant_user_scope,
 *                                grant_dimension_value; its catalog description
 *                                is literally "Manage users, roles, and
 *                                invitations")
 * Plain reads in the same families (`kernel:users:read`,
 * `kernel:policies:read`) are not org-administration authority.
 */
const ADMIN_SCOPES = [
  "kernel:roles:admin",
  "kernel:scope_requests:admin",
  "kernel:policies:admin",
  "kernel:users:admin",
] as const

/**
 * A ceiling entry is an admin entry when it grants any admin scope, directly
 * or through a wildcard (`*`, `kernel:*`, `kernel:users:*`), judged by the same
 * wildcard-aware `hasScope` that resolves grants everywhere else.
 */
function isAdminScope(entry: string): boolean {
  return ADMIN_SCOPES.some((adminScope) => hasScope(adminScope, [entry]))
}

/**
 * Refuse to save a `scopeCeiling` on a `kind='role'` agent that holds an
 * entry that is not a single scope (RoleAgentInvalidScopeError) or any
 * organization-administration scope (RoleAgentAdminScopeError). A no-op
 * (never throws) for `personal` and `system` agents: a personal agent's
 * ceiling legitimately equals its owner's own grants, which may include admin
 * scopes for an admin user.
 *
 * Application-layer check, to be called before any write of a role agent's
 * ceiling; RLS cannot express "no admin scope in this jsonb array" cheaply as
 * a policy predicate. Today the only such write is the one-off agent-roster
 * migration tooling: the API has no route that creates a
 * role agent or edits a ceiling, and the agents_update trigger (0053) pins
 * scope_ceiling for any actor without kernel:agents:admin. A route that adds
 * such a write must call this first.
 */
export function assertNoAdminScopesInRoleCeiling(
  kind: AgentKind,
  scopeCeiling: string[],
  alsoKnown: Iterable<string> = [],
): void {
  if (kind !== "role") return

  const invalidScopes = scopeCeiling.filter((entry) => !SCOPE_GRAMMAR.test(entry))
  if (invalidScopes.length > 0) {
    throw new RoleAgentInvalidScopeError(invalidScopes)
  }

  const adminScopes = scopeCeiling.filter(isAdminScope)
  if (adminScopes.length > 0) {
    throw new RoleAgentAdminScopeError(adminScopes)
  }

  assertCeilingScopesKnown(scopeCeiling, alsoKnown)
}

/**
 * Thrown when a ceiling holds an entry that is a well formed scope but names
 * nothing: no scope of the build's registry matches it, directly or through
 * its wildcard. `mail:reply`, `mail:compose` and `shopify:draft_orders:read`
 * were three such strings in a shipped ceiling (T26 F1); each read as a
 * generous grant and granted nothing, because a tool the actor lacks a scope
 * for is not in its catalog at all.
 */
export class CeilingUnknownScopeError extends Error {
  code = "ceiling_unknown_scope"
  constructor(public readonly unknown: string[]) {
    super(
      `scope ceiling names ${unknown.length} scope(s) no app or kernel tool declares, so they grant nothing: ${unknown.join(", ")}`,
    )
    this.name = "CeilingUnknownScopeError"
  }
}

/**
 * Thrown when a ceiling entry is a BARE PREFIX: a string that grants nothing on
 * its own but, through `hasScope`'s prefix matching, reaches every scope under
 * it. `tickets` is the example that matters (P8-FX2, SK-5): it grants
 * `tickets:settings:admin`, `tickets:inboxes:admin` and
 * `tickets:categories:admin`, the three app level admin surfaces F5 narrowed
 * `tickets:*` away from, and it does it with no wildcard for a reader to
 * notice. The grammar accepted it, `unknownScopes` accepted it (it matches real
 * scopes) and `ADMIN_SCOPES` never saw it (those are the four kernel admin
 * scopes only), so the narrowing was data held by no guard.
 *
 * The rule: an entry is either a scope something DECLARES, exactly, or an
 * explicit family wildcard (`tickets:*`, or `*` which the admin check refuses
 * for a role agent anyway). Widening is then always written down.
 */
export class CeilingPrefixScopeError extends Error {
  code = "ceiling_prefix_scope"
  constructor(public readonly prefixes: string[]) {
    super(
      `scope ceiling holds ${prefixes.length} bare prefix entr(y/ies) that would widen past the leaves they name: ${prefixes.join(", ")}. Name the exact scopes, or write the family wildcard (for example "tickets:*") when the whole family is meant`,
    )
    this.name = "CeilingPrefixScopeError"
  }
}

/**
 * Refuse a ceiling holding a scope the build does not know (see
 * `scope-registry.ts` for what "know" means and why it is read off the shipped
 * bundles). `alsoKnown` is what the INSTANCE has installed, which a caller
 * holding a database connection can say and this tree cannot: without it a
 * ceiling naming a runtime-installed app's scope is refused, and that refusal
 * is a hard stop for the whole roster migration (P8-FX2, SK-4).
 * Separate from the role-only admin guard because it is true of any ceiling a
 * human writes by hand; a personal agent's ceiling is not hand written (it is
 * the owner's resolved grants) and never reaches here.
 */
export function assertCeilingScopesKnown(
  scopeCeiling: readonly string[],
  alsoKnown: Iterable<string> = [],
): void {
  const unknown = unknownScopes(scopeCeiling, alsoKnown)
  if (unknown.length > 0) throw new CeilingUnknownScopeError(unknown)

  const prefixes = scopeCeiling.filter(
    (entry) => entry !== "*" && !entry.endsWith(":*") && !isDeclaredScope(entry, alsoKnown),
  )
  if (prefixes.length > 0) throw new CeilingPrefixScopeError(prefixes)
}

/**
 * The scopes of `required` that `ceiling` does not cover, judged by the same
 * wildcard-aware `hasScope` that resolves grants everywhere else. Empty means
 * the ceiling covers the lot. Shared by the routine and skill ownership checks
 * so "does this owner cover what it owns" has one answer.
 */
export function scopesMissingFromCeiling(
  required: readonly string[],
  ceiling: readonly string[],
): string[] {
  return required.filter((scope) => !hasScope(scope, ceiling as string[]))
}
