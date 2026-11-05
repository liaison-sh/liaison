// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What marks an ERASED user, in one place.
//
// Erasure (erase-user.ts) tombstones the `kernel.users` row rather than
// deleting it, and RETAINS the messages the person wrote in shared threads
// (their authorship is re-pointed nowhere, the display is anonymised). The
// tombstone is the email set to `deleted-user-<id>`, which erase-user already
// reads as "already erased". Anything that republishes message TEXT outside
// the database (the search index, its rebuild) must treat a message authored
// by such a user as gone, or a rebuild re-indexes erased text.

import { sql } from "drizzle-orm"
import { schemaRef } from "~/db/schema-ref"

/** The email an erased user's row is tombstoned with. */
export function erasedUserEmail(userId: string): string {
  return `deleted-user-${userId}`
}

/**
 * SQL predicate, true when the message aliased `alias` was written by an
 * erased user. Index-backed: one primary-key probe of `kernel.users` per row.
 */
export function authorErasedSql(alias: string) {
  const m = sql.raw(alias)
  const users = sql.raw(`"${schemaRef("kernel")}".users`)
  return sql`EXISTS (SELECT 1 FROM ${users} eu
    WHERE eu.id = ${m}.author_id AND eu.email = 'deleted-user-' || eu.id::text)`
}
