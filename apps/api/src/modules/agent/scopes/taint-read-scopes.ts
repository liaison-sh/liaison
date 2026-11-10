// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TAINT IS A DATA CLASSIFICATION (scope-taint.ts, rule 5).
//
// A scope entering a turn's taint or a record's requiredScopes stamp says "this data may be
// read only by people allowed to read it". A write or action scope (`:write`, `:close`,
// `:reply`, `:create`, a memory or skills write, an approve scope) classifies no data: a
// teammate who may read a ticket but not close it is exactly who should still see a reply
// derived from it. Left in, they made a taint that could only grow: one abnormal turn stamped
// its reply with the requester's whole effective scope, every later turn re-read that stamp as
// history, and every write of the conversation was refused for readers lacking `:close`.
//
// The rule is by the scope's ACTION (its last segment), and fails closed:
//   1. a `:read` scope is kept;
//   2. a scope whose action is a write or action verb (WRITE_ACTION_VERBS) is projected onto
//      its read sibling `<app>:<resource>:read` when that scope exists in the registered scope
//      catalog, and dropped otherwise. It is the inverse of `readerScopesOf`, the one sibling
//      rule the sink-readers judgement uses (a `:read` scope is readable under its `:write`
//      sibling, as the generated RLS lets the write scope SELECT);
//   3. a GRANT WILDCARD (`*`, `<app>:*`, any scope with a `*` segment) is never kept: it is a
//      pattern over grants, not a class of data, and a required `*` is covered only by the
//      grant `*` (migration 0249), so a stamp holding it hid a reply from the very teammate it
//      was addressed to. It is expanded onto the catalogued read scopes it covers, by hasScope's
//      own rule (`*` every one, `p:*` those under `p:`, a `*` anywhere but last none), which keeps
//      an over-approximation (the abnormal-end widening of a `*` ceiling) exactly as wide in what
//      it classifies and never fails open (2026-11-03);
//   4. a scope every member holds (every-member-scopes.ts) classifies nothing: it is what a
//      person may do as themself with nothing read, so it is dropped. Kept, it stamped a
//      fallback taint with a scope no approver's grants carry, and the turn could never park;
//   5. every other scope is KEPT: an app tool's `:run` execution scope (its code reads app
//      data), an `:admin` or `:spawn` scope gating a read-only tool (users_list, export,
//      subagent_list), an unknown action. Not knowing a scope is not knowing that it classifies
//      nothing.
// The catalog is the registered scope universe: the kernel catalog, every first-party app
// manifest of the build, and, when the org is known, that org's runtime catalog. The
// unknown-taint sentinel is not a scope and is always kept: unknown stays held by nobody.

import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { rlsScopeEntityForTable } from "~/modules/permissions/rls-generator"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"
import { knownScopeUniverse } from "~/modules/permissions/scope-registry"

const READ_SUFFIX = ":read"
const WRITE_SUFFIX = ":write"

/**
 * The grants under which data classified `readScope` (or a table whose readers are declared
 * `readScope`) can be read: the scope itself and, for an `<app>:<entity>:read` scope, its
 * `:write` sibling. Wider grants (`*`, `kpi`, `kpi:*`, `kpi:comments:*`) are covered by
 * `hasScope` itself. The one statement of the sibling rule; `readScopesImpliedBy` inverts it.
 */
export function readerScopesOf(readScope: string): string[] {
  return readScope.endsWith(READ_SUFFIX)
    ? [readScope, `${readScope.slice(0, -READ_SUFFIX.length)}${WRITE_SUFFIX}`]
    : [readScope]
}

/** True when `scope` is a read classification (`...:read`). */
export function isReadScope(scope: string): boolean {
  return scope.endsWith(READ_SUFFIX)
}

/**
 * The actions (a scope's last segment) that classify no data: a scope ending in one is
 * projected onto its read sibling, or dropped when the catalog has none (rule 5.2).
 */
export const WRITE_ACTION_VERBS: ReadonlySet<string> = new Set([
  "write",
  "create",
  "update",
  "delete",
  "close",
  "reply",
  "forward",
  "send",
  "nudge",
  "merge",
  "set",
  "assign",
  "archive",
  "approve",
  "decide",
])

/** The `:read` scopes of the registered catalog: the build's universe plus the org's. */
export function taintReadCatalog(orgId?: string): string[] {
  const out = new Set<string>()
  for (const scope of knownScopeUniverse()) if (isReadScope(scope)) out.add(scope)
  if (orgId) {
    try {
      for (const entry of getScopeCatalog(orgId)) if (isReadScope(entry.scope)) out.add(entry.scope)
    } catch {
      // The org catalog is a widening of the build's universe, never required.
    }
  }
  // A scope every member holds classifies no data (`readScopesImpliedBy`): never a reader's bar.
  for (const scope of KERNEL_EVERY_MEMBER_SCOPES) out.delete(scope)
  return [...out]
}

/**
 * What `scope` classifies as, against `readCatalog` (catalogued `:read` scopes): itself for a
 * `:read` scope or any scope whose action is not a write or action verb, its catalogued read
 * sibling for a write or action scope, nothing when that sibling is not catalogued.
 */
/** True when `scope` is a grant pattern (`*`, `p:*`, `*:read`): any of its segments is `*`. */
export function isWildcardScope(scope: string): boolean {
  return scope.split(":").includes("*")
}

/**
 * The catalogued read scopes a grant wildcard covers, by hasScope's rule (permissions.ts,
 * mirrored by migration 0249): `*` covers every one, `p:*` every one under `p:`, and a pattern
 * with a `*` segment anywhere but last covers nothing.
 */
export function readScopesCoveredByWildcard(
  pattern: string,
  readCatalog: readonly string[],
): string[] {
  if (pattern === "*") return [...readCatalog]
  const parts = pattern.split(":")
  if (parts.indexOf("*") !== parts.length - 1) return []
  const prefix = pattern.slice(0, -1)
  return readCatalog.filter((s) => s.startsWith(prefix))
}

export function readScopesImpliedBy(scope: string, readCatalog: readonly string[]): string[] {
  if (isWildcardScope(scope)) return readScopesCoveredByWildcard(scope, readCatalog)
  if (KERNEL_EVERY_MEMBER_SCOPES.includes(scope)) return []
  if (isReadScope(scope)) return [scope]
  const parts = scope.split(":")
  const action = parts[parts.length - 1] ?? ""
  if (parts.length < 2 || !WRITE_ACTION_VERBS.has(action)) return [scope]
  const sibling = `${parts.slice(0, -1).join(":")}${READ_SUFFIX}`
  return readCatalog.includes(sibling) ? [sibling] : []
}

/**
 * Project a scope set onto what it classifies (sorted, deduplicated): rule 5 of scope-taint.ts,
 * per scope (`readScopesImpliedBy`). The unknown-taint sentinel is kept.
 */
export function projectTaintScopes(
  scopes: readonly string[],
  readCatalog: readonly string[] = taintReadCatalog(),
): string[] {
  const out = new Set<string>()
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope === "") continue
    if (UNKNOWN_TURN_TAINT.includes(scope)) {
      out.add(scope)
      continue
    }
    for (const read of readScopesImpliedBy(scope, readCatalog)) out.add(read)
  }
  return [...out].sort()
}

/** `projectTaintScopes` against the org's catalog (the build's universe when no org is known). */
export function projectTaintScopesForOrg(scopes: readonly string[], orgId?: string): string[] {
  return projectTaintScopes(scopes, taintReadCatalog(orgId))
}

/**
 * THE DEFAULT READERS OF AN APP TABLE (scope-taint.ts, rule 6a). A write tool that declares
 * its `writesToTable` in its own app's schema but no `sinkReadScope` is judged by the table's
 * real readers: the scope its generated RLS read policy admits, `<app>:<rlsScope entity>:read`
 * (and, through `readerScopesOf`, its `:write` sibling), exactly the accepted-grant set
 * `generateScopeCheck` encodes. Undefined, so the write keeps failing closed, wherever those
 * readers cannot be derived: a table outside the app's own schema, a table the manifest's
 * schema does not declare, or a table whose RLS a migration owns instead of the generator.
 */
export function derivedSinkReadScope(opts: {
  appName: string
  writesToTable: string
  schema?: Record<string, unknown> | null
  rlsManagedByMigration?: boolean
}): string | undefined {
  if (opts.rlsManagedByMigration === true) return undefined
  const prefix = `app_${opts.appName.replace(/-/g, "_")}.`
  if (!opts.writesToTable.startsWith(prefix)) return undefined
  const table = opts.writesToTable.slice(prefix.length)
  const def = opts.schema?.[table]
  if (def === null || typeof def !== "object") return undefined
  return `${opts.appName}:${rlsScopeEntityForTable(table, def as { rlsScope?: unknown })}:read`
}

/**
 * A record's requiredScopes stamp with every grant wildcard replaced by the catalogued read
 * scopes it covers (rule 3 above), every other entry as given, deduplicated in order. Applied
 * where a stamp is written (sendMessage), so no path stamps `*` whatever it was handed.
 */
export function expandWildcardStamp(scopes: readonly string[], orgId?: string): string[] {
  if (!scopes.some((s) => typeof s === "string" && isWildcardScope(s))) return [...new Set(scopes)]
  const catalog = taintReadCatalog(orgId)
  const out = new Set<string>()
  for (const scope of scopes) {
    if (isWildcardScope(scope)) {
      for (const read of readScopesCoveredByWildcard(scope, catalog)) out.add(read)
    } else out.add(scope)
  }
  return [...out]
}
