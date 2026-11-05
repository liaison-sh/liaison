// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0118 merges the duplicate mail rows 0116 left behind and builds the two
// uniques the mail writes' ON CONFLICT clauses need. Replayed against SCRATCH
// copies in their own schema (0116's recipe): the statements are the file's
// own, only the schema names are swapped.

import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0118_mail_unique_external_ids.sql", import.meta.url).pathname
const FALLBACK = new URL("./0116_mail_external_id_indexes.sql", import.meta.url).pathname
const SCRATCH = "mig0118_mail_unique"
const ORG = "00000000-0000-0000-0000-0000000000aa"
const ACCOUNT = "00000000-0000-0000-0000-0000000000bb"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

async function apply(file: string): Promise<void> {
  const text = readFileSync(file, "utf8")
    .replaceAll("app_mail.", `${SCRATCH}.`)
    .replaceAll("kernel.files", `${SCRATCH}.files`)
  await sql.unsafe(text)
}

async function indexes(): Promise<Record<string, boolean>> {
  const rows = await sql.unsafe<{ name: string; unique: boolean }[]>(
    `SELECT c.relname AS name, i.indisunique AS unique
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${SCRATCH}' AND NOT i.indisprimary
        AND c.relname ~ 'external_(message|thread)_id'`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.unique]))
}

async function conversation(id: string, threadId: string, createdAt: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${SCRATCH}.conversations (id, org_id, account_id, external_thread_id, created_at)
     VALUES ('${id}', '${ORG}', '${ACCOUNT}', '${threadId}', '${createdAt}')`,
  )
}

async function message(id: string, conversationId: string, externalId: string, createdAt: string) {
  await sql.unsafe(
    `INSERT INTO ${SCRATCH}.messages (id, org_id, account_id, conversation_id, external_message_id, created_at)
     VALUES ('${id}', '${ORG}', '${ACCOUNT}', '${conversationId}', '${externalId}', '${createdAt}')`,
  )
}

const C1 = "00000000-0000-0000-0000-00000000c001"
const C2 = "00000000-0000-0000-0000-00000000c002"
const M1 = "00000000-0000-0000-0000-00000000d001"
const M2 = "00000000-0000-0000-0000-00000000d002"
const M3 = "00000000-0000-0000-0000-00000000d003"

describe("0118 mail unique external ids", () => {
  beforeEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.conversations (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, account_id uuid NOT NULL,
      external_thread_id text NOT NULL, message_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.messages (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, account_id uuid NOT NULL,
      conversation_id uuid NOT NULL, external_message_id text, external_provider_id text,
      created_at timestamptz NOT NULL)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id text)`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  // Fabrikam's shape: one racing import stored the same message twice, each in
  // its own copy of the conversation, and 0116 fell back to plain indexes.
  it("merges duplicates into the oldest row and replaces 0116's fallbacks with uniques", async () => {
    await conversation(C1, "t1", "2026-09-14T13:24:45.528Z")
    await conversation(C2, "t1", "2026-09-14T13:24:45.532Z")
    await message(M1, C1, "<dup@x>", "2026-09-14T13:24:45.556Z")
    await message(M2, C2, "<dup@x>", "2026-09-14T13:24:45.558Z")
    await message(M3, C2, "<other@x>", "2026-09-14T13:25:00.000Z")
    await sql.unsafe(`INSERT INTO ${SCRATCH}.drafts (conversation_id) VALUES ('${C2}')`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.files (entity_id) VALUES ('${M2}'), ('${C2}')`)
    await apply(FALLBACK)
    expect(Object.values(await indexes())).toEqual([false, false])

    await apply(FILE)

    expect(await indexes()).toEqual({
      messages_org_id_account_id_external_message_id_key: true,
      conversations_org_id_account_id_external_thread_id_key: true,
    })
    const messages = await sql.unsafe(
      `SELECT id, conversation_id FROM ${SCRATCH}.messages ORDER BY id`,
    )
    expect(messages.map((m) => [m.id, m.conversation_id])).toEqual([
      [M1, C1],
      [M3, C1],
    ])
    const convs = await sql.unsafe(`SELECT id, message_count FROM ${SCRATCH}.conversations`)
    expect(convs.map((c) => [c.id, c.message_count])).toEqual([[C1, 2]])
    const drafts = await sql.unsafe(`SELECT conversation_id FROM ${SCRATCH}.drafts`)
    expect(drafts.map((d) => d.conversation_id)).toEqual([C1])
    const files = await sql.unsafe(`SELECT entity_id FROM ${SCRATCH}.files ORDER BY entity_id`)
    expect(files.map((f) => f.entity_id).sort()).toEqual([M1, C1].sort())

    // The mail writes' ON CONFLICT targets now resolve (42P10 before).
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.conversations (id, org_id, account_id, external_thread_id, created_at)
       VALUES (gen_random_uuid(), '${ORG}', '${ACCOUNT}', 't1', now())
       ON CONFLICT (org_id, account_id, external_thread_id) DO NOTHING`,
    )
    expect((await sql.unsafe(`SELECT count(*)::int AS n FROM ${SCRATCH}.conversations`))[0].n).toBe(
      1,
    )
  })

  it("is a no-op on clean data that 0116 already made unique, and replays", async () => {
    await conversation(C1, "t1", "2026-09-14T13:24:45.528Z")
    await message(M1, C1, "<a@x>", "2026-09-14T13:24:45.556Z")
    await apply(FALLBACK)
    await apply(FILE)
    await apply(FILE)
    expect(Object.values(await indexes())).toEqual([true, true])
    expect((await sql.unsafe(`SELECT count(*)::int AS n FROM ${SCRATCH}.messages`))[0].n).toBe(1)
  })
})
