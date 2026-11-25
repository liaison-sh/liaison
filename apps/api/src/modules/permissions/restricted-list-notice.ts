// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person added to a restricted record's list who cannot open its app. The list decides who may
// read the record, but reading it still takes the app's own read scope: someone on the list
// without it never sees the record, and nothing told the person who shared it. After a write
// that changes the list, the kernel compares the list before and after and names the people
// added who lack the access; the share stands, the result says so.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { restrictedListsFor } from "~/modules/agent/scopes/taint-approval-audience"
import { isAppUnavailableFor } from "~/modules/apps/org-apps"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  RESTRICTED_KIND_READ_SCOPE,
  RESTRICTED_SCOPE_PREFIX,
} from "~/modules/permissions/restricted-scope"

/** The lists of the restricted records named by `scopes`, as id sets (null: not restricted). */
export type RestrictedListSnapshot = ReadonlyMap<string, ReadonlySet<string> | null>

/** The lists before a write, for the restricted scopes the call names. Empty when none. */
export async function restrictedListsBefore(
  orgId: string,
  scopes: readonly string[],
): Promise<RestrictedListSnapshot> {
  return scopes.length === 0 ? new Map() : restrictedListsFor(orgId, scopes)
}

/**
 * The notice for the people a write added to a restricted record's list who cannot open its app,
 * or null when there are none. `after` is the record's restricted scopes once the write is done;
 * `before` the lists as they stood. The person who made the change is never named.
 */
export async function restrictedListNotice(
  orgId: string,
  actorUserId: string | null,
  after: readonly string[],
  before: RestrictedListSnapshot,
): Promise<string | null> {
  if (after.length === 0) return null
  const lists = await restrictedListsFor(orgId, after)
  const added = new Map<string, string>()
  for (const scope of after) {
    const now = lists.get(scope)
    if (!now) continue
    const had = before.get(scope) ?? new Set<string>()
    const kind = scope.slice(RESTRICTED_SCOPE_PREFIX.length).split(":")[0] ?? ""
    for (const id of now) if (id !== actorUserId && !had.has(id)) added.set(id, kind)
  }
  if (added.size === 0) return null
  const lacking: Array<{ id: string; app: string }> = []
  for (const [id, kind] of added) {
    const app = kind.split(".")[0] ?? ""
    const readScope = RESTRICTED_KIND_READ_SCOPE[kind]
    if (!app || !readScope) continue
    const perms = await withPrivilegedDb(orgId, "restricted-list-notice-perms", (tx) =>
      loadEffectivePermissions(tx, id, orgId),
    )
    if (isAppUnavailableFor(orgId, app, id) || !hasScope(readScope, perms.scopes)) {
      lacking.push({ id, app })
    }
  }
  if (lacking.length === 0) return null
  const names = await withPrivilegedDb(orgId, "restricted-list-notice-names", async (db) =>
    extractRows<{ id: string; name: string }>(
      await db.execute(
        sql`SELECT id::text AS id, name FROM ${sql.raw(quoteIdent(schemaRef("kernel")))}.users
             WHERE id = ANY(${`{${lacking.map((l) => l.id).join(",")}}`}::uuid[])`,
      ),
    ),
  )
  const nameOf = new Map(names.map((r) => [r.id, r.name]))
  const apps = [...new Set(lacking.map((l) => l.app))]
  const who = lacking.map((l) => nameOf.get(l.id) ?? "someone").join(", ")
  const one = lacking.length === 1
  return `${who} ${one ? "is" : "are"} on the list but cannot open it yet: no access to ${apps.join(", ")}. The share is saved; until an admin gives ${one ? "them" : "each of them"} that access (Settings, roles), they do not see it.`
}
