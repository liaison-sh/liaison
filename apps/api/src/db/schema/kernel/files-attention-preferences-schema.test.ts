// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"

describe("kernel.files schema", () => {
  it("has expected columns", async () => {
    const rows = extractRows<{ column_name: string }>(
      await withSystemDb("phase10-files-columns", (db) =>
        db.execute(drizzleSql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = 'files'
          ORDER BY ordinal_position
        `),
      ),
    )
    const cols = rows.map((r) => r.column_name)
    expect(cols).toEqual([
      "id",
      "org_id",
      "app",
      "entity_type",
      "entity_id",
      "filename",
      "mime_type",
      "size_bytes",
      "storage_key",
      "thumbnail_key",
      "uploaded_by",
      "disposition",
      "content_id",
      "original_content_id",
      "ordinal",
      "copied_from_id",
      // Media-analysis columns (commit 7f1d7451, feat(media-analysis)) — six
      // nullable analysis_* columns sit between copied_from_id and created_at
      // in 0000_initial.sql's kernel.files definition, async-populated by the
      // analyze_media kernel tool / slow-path job.
      "analysis_status",
      "analysis_summary",
      "analysis_model",
      "analysis_at",
      "analysis_error",
      "analysis_context_hash",
      "created_at",
      // Encryption-at-rest columns added by 0039_files_encryption_columns.sql,
      // appended after created_at because ALTER TABLE ADD COLUMN always
      // appends.
      "enc_version",
      "content_key_wrapped",
      "content_key_epk",
      "enc_key_id",
      "chunk_size",
      "chunk_count",
      "plaintext_length",
      "nonce_prefix",
    ])
  })

  it("has unique index on storage_key", async () => {
    const rows = extractRows<{ indexdef: string }>(
      await withSystemDb("phase10-files-storage-key-unique", (db) =>
        db.execute(drizzleSql`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname='kernel' AND tablename='files'
        `),
      ),
    )
    expect(
      rows.some((r) => r.indexdef.includes("UNIQUE") && r.indexdef.includes("storage_key")),
    ).toBe(true)
  })
})

describe("kernel.files attachment metadata", () => {
  it("supports message attachments, inline metadata, and upload sessions", async () => {
    await withSystemDb("phase10-attachments-schema", async (db) => {
      const fileColumns = extractRows<{ column_name: string }>(
        await db.execute(drizzleSql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = 'files'
        `),
      )
      const names = fileColumns.map((r) => r.column_name)
      for (const c of ["disposition", "content_id", "ordinal", "original_content_id"]) {
        expect(names).toContain(c)
      }

      const sessions = extractRows<{ column_name: string }>(
        await db.execute(drizzleSql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = 'file_upload_sessions'
        `),
      )
      const sessionCols = sessions.map((r) => r.column_name)
      for (const c of [
        "id",
        "org_id",
        "created_by",
        "target_app",
        "target_entity_type",
        "target_entity_id",
        "created_at",
        "expires_at",
      ]) {
        expect(sessionCols).toContain(c)
      }

      const indexes = extractRows<{ indexname: string }>(
        await db.execute(drizzleSql`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'kernel' AND tablename = 'files'
        `),
      )
      expect(indexes.map((r) => r.indexname)).toContain("idx_files_parent_ordinal")
    })
  })
})

describe("kernel.attention_events schema", () => {
  it("has digest fields and email_only flag", async () => {
    const rows = extractRows<{ column_name: string }>(
      await withSystemDb("phase10-attention-cols", (db) =>
        db.execute(drizzleSql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='kernel' AND table_name='attention_events'
        `),
      ),
    )
    const cols = rows.map((r) => r.column_name)
    for (const c of [
      "digest_state",
      "digest_eligible_at",
      "email_only",
      "source_key",
      "read_at",
      "is_urgent",
    ]) {
      expect(cols).toContain(c)
    }
  })

  it("has partial unique index on unread (user_id, app, entity_type, entity_id, kind)", async () => {
    const rows = extractRows<{ indexdef: string }>(
      await withSystemDb("phase10-attention-unique", (db) =>
        db.execute(drizzleSql`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname='kernel' AND tablename='attention_events'
        `),
      ),
    )
    expect(
      rows.some(
        (r) =>
          r.indexdef.includes("UNIQUE") &&
          r.indexdef.toLowerCase().includes("read_at is null") &&
          r.indexdef.includes("kind"),
      ),
    ).toBe(true)
  })
})

describe("kernel.user_preferences schema", () => {
  it("has digest_cadence, work_hours fields, work_days, last_daily_sent_at", async () => {
    const rows = extractRows<{ column_name: string }>(
      await withSystemDb("phase10-user-prefs-cols", (db) =>
        db.execute(drizzleSql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='kernel' AND table_name='user_preferences'
        `),
      ),
    )
    const cols = rows.map((r) => r.column_name)
    for (const c of [
      "user_id",
      "digest_cadence",
      "work_hours_start",
      "work_hours_end",
      "work_days",
      "timezone",
      "theme",
      "last_daily_sent_at",
      "updated_at",
    ]) {
      expect(cols).toContain(c)
    }
  })
})

describe("kernel.user_preferences digest_cadence default (liaison-messaging-visibility)", () => {
  it("defaults digest_cadence to 'daily'", async () => {
    const rows = extractRows<{ column_name: string; column_default: string | null }>(
      await withSystemDb("phase10-user-prefs-digest-cadence-default", (db) =>
        db.execute(drizzleSql`
          SELECT column_name, column_default FROM information_schema.columns
          WHERE table_schema='kernel' AND table_name='user_preferences'
            AND column_name='digest_cadence'
        `),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].column_default).toContain("daily")
  })

  it("has a nullable home_card_layout jsonb column with no default", async () => {
    const rows = extractRows<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>(
      await withSystemDb("phase10-user-prefs-home-card-layout", (db) =>
        db.execute(drizzleSql`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema='kernel' AND table_name='user_preferences'
            AND column_name='home_card_layout'
        `),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].data_type).toBe("jsonb")
    expect(rows[0].is_nullable).toBe("YES")
    expect(rows[0].column_default).toBeNull()
  })
})

describe("kernel.user_preferences theme column", () => {
  it("has a theme column defaulting to 'system'", async () => {
    const rows = extractRows<{ column_name: string; column_default: string | null }>(
      await withSystemDb("phase10-user-prefs-theme", (db) =>
        db.execute(drizzleSql`
          SELECT column_name, column_default FROM information_schema.columns
          WHERE table_schema='kernel' AND table_name='user_preferences'
            AND column_name='theme'
        `),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].column_default).toContain("system")
  })

  it("enforces a CHECK constraint restricting theme to system/light/dark", async () => {
    const rows = extractRows<{ check_clause: string }>(
      await withSystemDb("phase10-user-prefs-theme-check", (db) =>
        db.execute(drizzleSql`
          SELECT cc.check_clause
          FROM information_schema.table_constraints tc
          JOIN information_schema.check_constraints cc USING (constraint_name)
          WHERE tc.table_schema='kernel' AND tc.table_name='user_preferences'
        `),
      ),
    )
    // Postgres reports NOT NULL as a CHECK clause too — match only the enum check.
    const themeCheck = rows.find(
      (r) => r.check_clause.toLowerCase().includes("theme") && /system/i.test(r.check_clause),
    )
    expect(themeCheck).toBeTruthy()
    expect(themeCheck!.check_clause).toMatch(/system/)
    expect(themeCheck!.check_clause).toMatch(/light/)
    expect(themeCheck!.check_clause).toMatch(/dark/)
  })
})
