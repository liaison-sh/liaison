// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0116 indexes the mail sync's dedupe keys: unique (account, external message
// id) and (account, external thread id) when the data allows it, a plain index
// under an `_idx` name (and a WARNING, never a failed deploy) when it holds
// duplicates, and a plain (account, external provider id) index either way.
// The live tables are already migrated when this runs, so the file is replayed
// against SCRATCH copies in their own schema: the statements are the file's
// own, only the schema name is swapped (0113's recipe).

import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0116_mail_external_id_indexes.sql", import.meta.url).pathname
const SCRATCH = "mig0116_mail_indexes"
const ORG = "00000000-0000-0000-0000-0000000000aa"
const ACCOUNT = "00000000-0000-0000-0000-0000000000bb"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
const warnings: string[] = []
const noticing = postgres(privilegedUrl(), {
  max: 1,
  onnotice: (notice) => {
    if (notice.severity === "WARNING") warnings.push(String(notice.message))
  },
})

async function applyMigration(): Promise<void> {
  const text = readFileSync(FILE, "utf8").replaceAll("app_mail.", `${SCRATCH}.`)
  await noticing.unsafe(text)
}

async function indexes(): Promise<Record<string, boolean>> {
  const rows = await sql.unsafe<{ name: string; unique: boolean }[]>(
    `SELECT c.relname AS name, i.indisunique AS unique
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${SCRATCH}' AND NOT i.indisprimary`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.unique]))
}

async function insertMessage(externalMessageId: string, providerId: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${SCRATCH}.messages (org_id, account_id, external_message_id, external_provider_id)
     VALUES ('${ORG}', '${ACCOUNT}', '${externalMessageId}', '${providerId}')`,
  )
}

describe("0116 mail external id indexes", () => {
  beforeEach(async () => {
    warnings.length = 0
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL, account_id uuid NOT NULL,
      external_message_id text, external_provider_id text)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL, account_id uuid NOT NULL, external_thread_id text NOT NULL)`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
    await noticing.end()
  })

  it("builds the two uniques and the provider index on clean data, idempotently", async () => {
    await insertMessage("<a@x>", "p1")
    await insertMessage("<b@x>", "p2")
    await applyMigration()
    await applyMigration()
    expect(await indexes()).toEqual({
      messages_org_id_account_id_external_message_id_key: true,
      conversations_org_id_account_id_external_thread_id_key: true,
      idx_app_mail_messages_account_id_external_provider_id: false,
    })
    expect(warnings).toEqual([])
    // The unique is what turns a racing duplicate into a conflict.
    await expect(insertMessage("<a@x>", "p3")).rejects.toThrow(/duplicate key/)
    // Messages without an external id are not constrained (NULLs are distinct).
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.messages (org_id, account_id) VALUES ('${ORG}', '${ACCOUNT}'), ('${ORG}', '${ACCOUNT}')`,
    )
  })

  it("never fails the deploy on existing duplicates: indexes them non-unique and warns", async () => {
    await insertMessage("<dup@x>", "p1")
    await insertMessage("<dup@x>", "p2")
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.conversations (org_id, account_id, external_thread_id)
       VALUES ('${ORG}', '${ACCOUNT}', 't1'), ('${ORG}', '${ACCOUNT}', 't1')`,
    )
    await applyMigration()
    expect(await indexes()).toEqual({
      messages_org_id_account_id_external_message_id_idx: false,
      conversations_org_id_account_id_external_thread_id_idx: false,
      idx_app_mail_messages_account_id_external_provider_id: false,
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("1 duplicate")
  })

  it("serves the sync's page lookup from the index", async () => {
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.messages (org_id, account_id, external_message_id, external_provider_id)
       SELECT '${ORG}', '${ACCOUNT}', '<m' || g || '@x>', 'p' || g FROM generate_series(1, 5000) g`,
    )
    await applyMigration()
    await sql.unsafe(`ANALYZE ${SCRATCH}.messages`)
    const plan = await sql.unsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN SELECT external_provider_id FROM ${SCRATCH}.messages
        WHERE org_id = '${ORG}' AND account_id = '${ACCOUNT}' AND external_provider_id IN ('p1', 'p2', 'p3')`,
    )
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
      "idx_app_mail_messages_account_id_external_provider_id",
    )
  })
})
