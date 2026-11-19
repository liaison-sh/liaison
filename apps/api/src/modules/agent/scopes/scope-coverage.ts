// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Canonical scope-coverage predicate shared by every agent-side caller that
// asks "is this required scope set satisfied by this granted scope set?".
//
// Historically three near-identical implementations diverged:
//   - the skills/routines authoring path handled exact + bare-prefix grants
//     (`kernel:agent:memory` covers `kernel:agent:memory:read`) but NOT `:*`
//     globs, so a holder of `mcp:jira:*` could not author a routine requiring
//     `mcp:jira:read`.
//   - the sub-agent spawn path handled `*` and `:*` globs but NOT bare-prefix
//     grants, so spawning under a bare-prefix grant (e.g. the `member` role's
//     `kernel:agent:memory`) under-granted the child.
//
// `isScopeCovered` is the single source of truth: a granted scope covers a
// required scope when it is the full wildcard `*`, an exact match, a `:*`
// glob whose prefix matches, OR a bare ancestor prefix on a `:` boundary.

/** True when `granted` (one scope) covers `required` (one scope). */
function scopeCovers(granted: string, required: string): boolean {
  // Full wildcard.
  if (granted === "*") return true
  // Exact match.
  if (granted === required) return true
  // Trailing `:*` glob — `mcp:jira:*` covers `mcp:jira:read` (and deeper).
  if (granted.endsWith(":*")) {
    const prefix = granted.slice(0, -1) // keep the trailing colon
    return required.startsWith(prefix)
  }
  // Bare ancestor prefix on a `:` boundary — `kernel:agent:memory` covers
  // `kernel:agent:memory:read`. The boundary check prevents `a:bc` from being
  // treated as covered by `a:b`.
  return required.startsWith(`${granted}:`)
}

/**
 * True when every scope in `required` is covered by at least one scope in
 * `granted`. An empty `required` set is trivially covered.
 */
export function isScopeCovered(required: string[], granted: string[]): boolean {
  if (required.length === 0) return true
  return required.every((req) => granted.some((g) => scopeCovers(g, req)))
}

/**
 * Scopes only an EXACT grant holds: no wildcard, glob or parent covers them, in row security
 * (`app_projects.app_has_exact_scope`) or in the services. `scope-coverage.test.ts` keeps this
 * list equal to the scopes the migrations check that way.
 */
export const EXACT_ONLY_SCOPES: ReadonlySet<string> = new Set([
  "projects:cost_rates:write",
  "projects:margin:read",
  "projects:timesheet:read",
])

/**
 * True for a scope that only its exact grant holds: one of `EXACT_ONLY_SCOPES`, or a bare
 * marker scope with no `app:` part (a document's edit scope such as `clevel`), which no app
 * wildcard names.
 */
export function isExactOnlyScope(scope: string): boolean {
  return EXACT_ONLY_SCOPES.has(scope) || (scope !== "*" && !scope.includes(":"))
}
