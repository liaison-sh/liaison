// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every immutability trigger must be the one this release generates (ddl.ts,
// `generateImmutableTriggerDdl`): it carries the exception for an org being
// deleted, and its demo exception reads the org's class, not the jsonb marker.
// App registration re-applies the trigger when the generator changes (its DDL
// stamp hashes ddl.ts), but only for an app registered since the deploy. So
// each trigger body Postgres holds is checked, and a stale one regenerated from
// the spec read back out of it: once at boot (index.ts), and by a purge before
// it deletes legal records.
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import {
  generateImmutableTriggerDdl,
  IMMUTABLE_TRIGGER_CLASS_BRANCH,
  IMMUTABLE_TRIGGER_NAME,
  immutableSpecFromTriggerBody,
} from "~/modules/apps/ddl"
import { resultRows } from "~/modules/org/purge/rows"

const log = rootLogger.child({ module: "org-purge" })

/** Thrown when an immutability trigger is stale and its spec cannot be read back. */
export class StaleImmutableTriggerError extends Error {
  constructor(readonly tables: string[]) {
    super(
      `org purge: the immutability trigger of ${tables.join(", ")} is not the one this release writes and could not be regenerated; re-register the app (restart the server) and retry`,
    )
    this.name = "StaleImmutableTriggerError"
  }
}

/**
 * Check the immutability trigger of every `app_*` table and regenerate the ones
 * whose body is not current (no class branch). Idempotent; returns how many were checked and
 * regenerated. Throws `StaleImmutableTriggerError` for a body it cannot read.
 */
export async function ensureImmutableTriggersCurrent(): Promise<{
  checked: number
  regenerated: string[]
}> {
  const triggers = await withSystemDb("org-purge-immutable-triggers", async (tx) =>
    resultRows<{ schema: string; table: string; body: string }>(
      await tx.execute(drizzleSql`
        SELECT n.nspname AS schema, c.relname AS table, p.prosrc AS body
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgname = ${IMMUTABLE_TRIGGER_NAME}
          AND NOT t.tgisinternal
          AND n.nspname LIKE 'app\\_%'
        ORDER BY n.nspname, c.relname
      `),
    ),
  )
  const regenerated: string[] = []
  const unreadable: string[] = []
  for (const t of triggers) {
    if (t.body.includes(IMMUTABLE_TRIGGER_CLASS_BRANCH)) continue
    const label = `${t.schema}.${t.table}`
    const spec = immutableSpecFromTriggerBody(t.body)
    if (!spec) {
      unreadable.push(label)
      continue
    }
    const ddl = generateImmutableTriggerDdl(t.schema, t.table, spec)
    const done = await withSystemDb("org-purge-immutable-trigger-regenerate", async (tx) => {
      // Two purges regenerating the same function at once would collide
      // ("tuple concurrently updated"): one at a time, and the second finds
      // the body current and skips.
      // A table busy behind a long transaction fails this one, not the boot.
      await tx.execute(drizzleSql`SET LOCAL lock_timeout = '5s'`)
      await tx.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(hashtext('org-purge-immutable-triggers'))`,
      )
      const now = resultRows<{ body: string }>(
        await tx.execute(drizzleSql`
          SELECT p.prosrc AS body FROM pg_trigger tr
          JOIN pg_class c ON c.oid = tr.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = tr.tgfoid
          WHERE tr.tgname = ${IMMUTABLE_TRIGGER_NAME} AND n.nspname = ${t.schema} AND c.relname = ${t.table}
        `),
      )[0]
      if (now?.body.includes(IMMUTABLE_TRIGGER_CLASS_BRANCH)) return false
      for (const stmt of ddl.split(";\n").filter((s) => s.trim())) {
        await tx.execute(drizzleSql.raw(stmt))
      }
      return true
    })
    if (done) regenerated.push(label)
  }
  if (regenerated.length > 0) {
    log.info({ regenerated }, "org purge: regenerated stale immutability triggers")
  }
  if (unreadable.length > 0) throw new StaleImmutableTriggerError(unreadable)
  return { checked: triggers.length, regenerated }
}
