// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Refuse to start an image older than the database's schema.
//
// Drizzle's migrator applies a journal entry only when its `when` is above the
// highest `created_at` in drizzle.__drizzle_migrations, so an older image finds
// "nothing to do" and carries on: it would reinstall its older catalog apps and
// serve on a schema it was never built for. Migrations only go forward, so this
// fails the start instead, with a message that says what to do.
//
// It runs in the migration step (`runMigrations`, under the lease) and, for a
// process started with LIAISON_MIGRATE_ON_START=false, from the image
// entrypoint: `bun src/db/schema-guard.ts`. Processes that are already running
// are not touched: during a rolling deploy the old ones keep serving on the new
// schema until they drain. Only a start is refused.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"

/** Where the channel docs explain this refusal. Named in the message. */
export const OLDER_IMAGE_DOCS = "docs/admin/upgrades.md#migrations-only-go-forward"

export type OlderImagePolicy = "refuse" | "warn"

/**
 * Production refuses unless the operator set LIAISON_ALLOW_OLDER_IMAGE=true.
 * Development only warns: a checkout on an older branch against a shared
 * development database is normal there.
 */
export function olderImagePolicy(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allow: string | undefined = process.env.LIAISON_ALLOW_OLDER_IMAGE,
): OlderImagePolicy {
  return nodeEnv === "production" && allow !== "true" ? "refuse" : "warn"
}

/** The newest migration this image carries, from the journal drizzle applies from. */
export function imageMigrationHead(migrationsFolder: string): { tag: string; when: number } | null {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"))
  const entries = journal.entries as { tag: string; when: number }[]
  return entries.reduce<{ tag: string; when: number } | null>(
    (head, e) => (!head || e.when > head.when ? { tag: e.tag, when: e.when } : head),
    null,
  )
}

/** The ledger's highwater, or null on a database that has no migrations yet. */
export async function appliedHighwater(sql: postgres.Sql): Promise<number | null> {
  try {
    const [row] = await sql.unsafe<{ highwater: string | null }[]>(
      "SELECT max(created_at)::text AS highwater FROM drizzle.__drizzle_migrations",
    )
    return row?.highwater ? Number(row.highwater) : null
  } catch (err) {
    // 3F000: no drizzle schema. 42P01: no ledger table. Both mean a new database.
    const code = (err as { code?: string }).code
    if (code === "3F000" || code === "42P01") return null
    throw err
  }
}

export function olderImageMessage(
  appliedWhen: number,
  head: { tag: string; when: number },
): string {
  const version = process.env.LIAISON_VERSION || "unknown"
  return (
    `this image (Liaison ${version}) is older than the database schema: the newest migration ` +
    `applied to the database (${appliedWhen}) is newer than the image's newest one, ` +
    `${head.tag} (${head.when}). Migrations only go forward, so an older image cannot start on a ` +
    "newer schema. Point LIAISON_IMAGE at the version that migrated this database or a later one, " +
    `or restore a backup taken before the upgrade. See ${OLDER_IMAGE_DOCS}. ` +
    "In an emergency, LIAISON_ALLOW_OLDER_IMAGE=true starts it anyway; that is not supported."
  )
}

/** Throws (refuse) or warns (warn) when the database is ahead of this image. */
export async function assertImageNotOlderThanSchema(
  sql: postgres.Sql,
  migrationsFolder: string,
  policy: OlderImagePolicy = olderImagePolicy(),
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<void> {
  const head = imageMigrationHead(migrationsFolder)
  if (!head) return
  const applied = await appliedHighwater(sql)
  if (applied === null || applied <= head.when) return
  const message = olderImageMessage(applied, head)
  if (policy === "refuse") throw new Error(message)
  warn(`WARNING: ${message}`)
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL
  const folder = new URL("./migrations", import.meta.url).pathname
  if (url) {
    const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} })
    try {
      await assertImageNotOlderThanSchema(sql, folder)
    } catch (err) {
      const message = (err as Error).message
      if (message.includes(OLDER_IMAGE_DOCS)) {
        console.error(`FATAL: ${message}`)
        process.exit(1)
      }
      // A database that does not answer is not this check's verdict to give:
      // the next steps need it too, and they fail loudly on their own.
      console.warn(`Could not compare the image with the database schema: ${message}`)
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
}
