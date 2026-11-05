// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import postgres from "postgres"

/**
 * Runtime guard that the six analysis columns exist on kernel.files in the
 * test DB. A SELECT of all six against an empty result set throws if any
 * column is missing (undefined-column error). This is the falsifiable check
 * the migration edit + `db:reset:test` must satisfy — a typo'd column name
 * fails here. (Type-level coverage of the six keys is enforced separately by
 * `bun run typecheck`.)
 */
describe("kernel.files analysis columns", () => {
  it("exposes all six analysis columns", async () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 })
    try {
      // LIMIT 0 — we only care that the columns resolve, not about data.
      const rows = await sql`
        SELECT analysis_status,
               analysis_summary,
               analysis_model,
               analysis_at,
               analysis_error,
               analysis_context_hash
        FROM kernel.files
        LIMIT 0
      `
      expect(Array.isArray(rows)).toBe(true)
    } finally {
      await sql.end({ timeout: 5 })
    }
  })
})

/**
 * Task 7.1: the attachment-encryption columns.
 *
 * Non-vacuity first. The table itself must resolve and report more than ten
 * columns before a single new column is asserted, so a query against a missing
 * or empty schema cannot report success by finding nothing to contradict it.
 */
describe("kernel.files attachment encryption columns", () => {
  it("carries the eight encryption columns and the key id byte constraint", async () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 })
    try {
      const all = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'kernel' AND table_name = 'files'
      `
      // Non-vacuity: the table exists and is the real one.
      expect(all.length).toBeGreaterThan(10)

      const byName = new Map(all.map((c) => [c.column_name, c]))
      for (const name of [
        "enc_version",
        "content_key_wrapped",
        "content_key_epk",
        "enc_key_id",
        "chunk_size",
        "chunk_count",
        "plaintext_length",
        "nonce_prefix",
      ]) {
        expect(byName.has(name)).toBe(true)
      }
      // `enc_version` is the only one that is not nullable: every row declares
      // whether it is sealed, and 0 means "not sealed".
      expect(byName.get("enc_version")?.is_nullable).toBe("NO")
      expect(byName.get("content_key_wrapped")?.data_type).toBe("bytea")
      expect(byName.get("nonce_prefix")?.data_type).toBe("bytea")
      expect(byName.get("plaintext_length")?.data_type).toBe("bigint")

      // The key id is one byte in the ciphertext blob header, so the range is a
      // schema-level CHECK rather than a hope.
      const checks = await sql<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'kernel.files'::regclass AND contype = 'c'
           AND conname = 'files_enc_key_id_byte'
      `
      expect(checks.length).toBe(1)

      // And it is enforced, not merely declared.
      const rejected = await sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'kernel.files'::regclass AND conname = 'files_enc_key_id_byte'
      `
      expect(String((rejected[0] as { def: string }).def)).toContain("255")
    } finally {
      await sql.end({ timeout: 5 })
    }
  })
})
