// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 1 Task 1.2. The manifest DDL generator emits ADD COLUMN and no storage
// clause, so the ciphertext columns get STORAGE EXTERNAL from a one-shot kernel
// migration. EXTERNAL keeps the incompressible payloads out of the compressor
// and makes range and substring fetches on wide values cheap.
//
// The migration runs before app registration on a cold boot, so it must be
// idempotent and must skip a table or column that does not exist yet. Both
// halves are asserted here: the static shape of the file, and the real effect
// against the test database, applied inside a transaction that is rolled back.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"

const MIGRATIONS = path.resolve(import.meta.dir, "../../db/migrations")
const MIGRATION_FILE = path.join(MIGRATIONS, "0032_mailbox_ciphertext_storage_external.sql")
const TAG = "0032_mailbox_ciphertext_storage_external"

/**
 * Every column the design seals into. Spec sections 4.3 and 7.1.
 * Kept as literals rather than derived from the manifest, so a manifest change
 * that drops a column has to be reconciled here deliberately.
 */
const CIPHERTEXT_COLUMNS: { schema: string; table: string; columns: string[] }[] = [
  {
    schema: "app_mail",
    table: "messages",
    columns: [
      "text_body_ciphertext",
      "html_body_ciphertext",
      "subject_ciphertext",
      "snippet_ciphertext",
      "raw_headers_ciphertext",
      "content_key_wrapped",
      "content_key_epk",
    ],
  },
  {
    schema: "app_mail",
    table: "conversations",
    columns: ["subject_ciphertext", "snippet_ciphertext", "content_key_wrapped", "content_key_epk"],
  },
  {
    schema: "app_mail",
    table: "drafts",
    columns: ["body_ciphertext", "subject_ciphertext", "content_key_wrapped", "content_key_epk"],
  },
  {
    schema: "kernel",
    table: "files",
    columns: ["content_key_wrapped", "content_key_epk", "nonce_prefix"],
  },
]

const TOTAL_COLUMNS = CIPHERTEXT_COLUMNS.reduce((n, t) => n + t.columns.length, 0)

class Rollback extends Error {}

describe("mailbox ciphertext storage migration, static shape", () => {
  const sqlText = readFileSync(MIGRATION_FILE, "utf8")

  it("covers every ciphertext column with a SET STORAGE EXTERNAL statement", () => {
    expect(TOTAL_COLUMNS).toBeGreaterThanOrEqual(18)
    const missing: string[] = []
    for (const target of CIPHERTEXT_COLUMNS) {
      for (const column of target.columns) {
        const re = new RegExp(
          `ALTER TABLE ${target.schema}\\.${target.table} ALTER COLUMN ${column} SET STORAGE EXTERNAL`,
        )
        if (!re.test(sqlText)) missing.push(`${target.schema}.${target.table}.${column}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("guards every statement on the table and the column existing", () => {
    expect(sqlText).toContain("to_regclass")
    expect(sqlText).toContain("information_schema.columns")
    // One guarded DO block per table, so a cold boot with no app schema is a
    // no-op rather than an error.
    const blocks = sqlText.match(/DO \$\$/g) ?? []
    expect(blocks.length).toBe(CIPHERTEXT_COLUMNS.length)
  })

  it("is registered in the drizzle journal above the previous high-water mark", () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] }
    const entry = journal.entries.find((e) => e.tag === TAG)
    expect(entry).toBeDefined()
    expect((entry as { breakpoints: boolean }).breakpoints).toBe(true)
    // Every EARLIER entry, not every other entry. The ladder must be strictly
    // increasing, which is what the drizzle ledger-highwater trap punishes: a
    // migration whose `when` is at or below the last applied one is skipped
    // silently. Comparing against every other entry instead would forbid ever
    // adding a later migration, which is not the invariant.
    const earlier = journal.entries.filter((e) => e.idx < (entry as { idx: number }).idx)
    expect(earlier.length).toBeGreaterThan(0)
    const highest = Math.max(...earlier.map((e) => e.when))
    expect((entry as { when: number }).when).toBeGreaterThan(highest)
    const later = journal.entries.filter((e) => e.idx > (entry as { idx: number }).idx)
    for (const e of later) {
      expect(e.when).toBeGreaterThan((entry as { when: number }).when)
    }
  })
})

describe("mailbox ciphertext storage migration, applied", () => {
  const sqlText = readFileSync(MIGRATION_FILE, "utf8")

  it("is a no-op when the ciphertext columns do not exist yet", async () => {
    await withSystemDb("storage-external-cold-boot", async (tx) => {
      await tx.execute(drizzleSql.raw(sqlText))
    })
  })

  it("sets attstorage to EXTERNAL on every ciphertext column that exists", async () => {
    let checked = 0
    try {
      await withSystemDb("storage-external-apply", async (tx) => {
        for (const target of CIPHERTEXT_COLUMNS) {
          const present = await tx.execute(
            drizzleSql.raw(`SELECT to_regclass('${target.schema}.${target.table}') AS reg`),
          )
          const rows =
            (Array.isArray(present) ? present : (present as { rows?: unknown[] }).rows) ?? []
          expect(
            (rows[0] as { reg: string | null }).reg,
            `${target.schema}.${target.table} is missing from the test database`,
          ).not.toBeNull()
          for (const column of target.columns) {
            await tx.execute(
              drizzleSql.raw(
                `ALTER TABLE ${target.schema}.${target.table} ADD COLUMN IF NOT EXISTS ${column} BYTEA`,
              ),
            )
          }
        }

        await tx.execute(drizzleSql.raw(sqlText))

        for (const target of CIPHERTEXT_COLUMNS) {
          for (const column of target.columns) {
            const res = await tx.execute(
              drizzleSql.raw(
                `SELECT a.attstorage AS storage FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = '${target.schema}' AND c.relname = '${target.table}'
                   AND a.attname = '${column}'`,
              ),
            )
            const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? []
            expect(rows.length, `${target.table}.${column} not found`).toBe(1)
            expect(
              (rows[0] as { storage: string }).storage,
              `${target.schema}.${target.table}.${column} is not STORAGE EXTERNAL`,
            ).toBe("e")
            checked++
          }
        }
        // Leave no residue: the columns themselves are Phase 4 and Phase 7 work.
        throw new Rollback()
      })
    } catch (err) {
      if (!(err instanceof Rollback)) throw err
    }
    expect(checked).toBe(TOTAL_COLUMNS)
  })
})
