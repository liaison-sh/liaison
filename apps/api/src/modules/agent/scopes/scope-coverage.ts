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
//
// An exact-only scope (`isExactOnlyScope`) is the one exception: only its exact
// grant covers it, as row security checks it. Every caller inherits that: the
// intersection of two scope sets (`intersectScopes`) keeps an exact-only scope
// only when both sides name it, and a person holding `*` cannot author a
// routine, an agent ceiling or a token that names one.

/** True when `granted` (one scope) covers `required` (one scope). */
function scopeCovers(granted: string, required: string): boolean {
  // Exact match.
  if (granted === required) return true
  // No wildcard, glob or parent stands for an exact-only scope.
  if (isExactOnlyScope(required)) return false
  return encloses(granted, required)
}

/** `granted` is a wildcard, glob or parent that encloses `required`, exact-only or not. */
function encloses(granted: string, required: string): boolean {
  // Full wildcard.
  if (granted === "*") return true
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
 * True when some entry of `bounds` names `scope` or encloses it (`*`, a `:*` glob, a parent),
 * exact-only scopes included. NOT a coverage check: it grants nothing and no caller may use it to
 * decide whether someone holds a scope. It answers one question only, for a filter over scopes
 * already held exactly: does a narrowing that keeps `bounds` leave `scope`'s area in place
 * (`personalCeiling`)? Holding is always `isScopeCovered`.
 */
export function withinBounds(scope: string, bounds: readonly string[]): boolean {
  return bounds.some((b) => b === scope || encloses(b, scope))
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
 * marker scope with no `app:` part, which no app wildcard names. A knowledge document's edit
 * scope (checked exactly by row security) is always such a marker: the document schemas refuse
 * any other text (`knowledgeEditScopeSchema`).
 */
export function isExactOnlyScope(scope: string): boolean {
  return EXACT_ONLY_SCOPES.has(scope) || (scope !== "*" && !scope.includes(":"))
}

/**
 * The scopes of a ceiling write (`written`) that a granter holding `granted` may not put on an
 * agent whose stored ceiling is `stored` (`[]` for an agent being created or imported). A write is
 * judged on what it ADDS: a scope the stored ceiling already covers is kept, whoever writes it, so
 * resending a ceiling unchanged (as a settings form does) or narrowing it is always allowed. Every
 * other scope must be covered by the granter, an exact-only one by its exact grant, so `*` never
 * newly hands out a scope row security checks exactly.
 */
export function ungrantableCeilingScopes(
  written: readonly string[],
  stored: readonly string[],
  granted: readonly string[],
): string[] {
  const storedList = [...stored]
  const grantedList = [...granted]
  return [...new Set(written)].filter(
    (s) => !isScopeCovered([s], storedList) && !isScopeCovered([s], grantedList),
  )
}

/**
 * For a refusal naming `scopes` a writer may not grant: which of them only an exact grant holds
 * (a `*`, a glob or a parent scope does not), as a clause to append, or nothing.
 */
export function exactGrantNote(scopes: readonly string[]): string {
  const exact = scopes.filter(isExactOnlyScope)
  return exact.length > 0
    ? `; ${exact.join(", ")} must be granted to you exactly (a wildcard, a glob or a parent scope does not hold it)`
    : ""
}

/** Why a ceiling write was refused, from `ungrantableCeilingScopes`' answer. */
export function ceilingRefusalMessage(ungrantable: readonly string[]): string {
  return `that ceiling is wider than what you may grant: ${ungrantable.join(", ")}${exactGrantNote(ungrantable)}`
}
