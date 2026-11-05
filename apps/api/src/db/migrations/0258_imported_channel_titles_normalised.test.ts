// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0258 applies 0257's channel-name rule to imported channels (created_from entityType
// 'channel'), which 0257 skipped. The live table is already migrated when this
// runs, so the file is replayed against SCRATCH copies in their own schema (0113's
// recipe): the statements are the file's own, only the schema name is swapped.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { normalizeChannelTitle } from "@liaison/shared"
import postgres from "postgres"

const FILE = new URL("./0258_imported_channel_titles_normalised.sql", import.meta.url).pathname
const SCRATCH = "mig0258_imported_titles"

const id = (n: number) => `00000000-0000-0000-0000-0000000000${n.toString(16).padStart(2, "0")}`

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

async function applyMigration(): Promise<void> {
  const text = readFileSync(FILE, "utf8").replaceAll("kernel.", `${SCRATCH}.`)
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

async function titles(): Promise<Record<string, string | null>> {
  const rows = await sql.unsafe<{ id: string; title: string | null }[]>(
    `SELECT id::text, title FROM ${SCRATCH}.threads`,
  )
  return Object.fromEntries(rows.map((r) => [r.id, r.title]))
}

// [id, type, createdFrom entityType | null, title]
const ROWS: [number, string, string | null, string | null][] = [
  [1, "thread", "channel", "#general"],
  [2, "thread", "channel", "  ## ops "],
  [3, "thread", "channel", "#"],
  [4, "agent_chat", "channel", "#1 priority"],
  [5, "thread", "ticket", "#anchored"],
  [6, "thread", "channel", "already-clean"],
  [7, "thread", "channel", null],
  [8, "thread", null, "#plain-channel-left-to-0257"],
  [9, "thread", "channel", "#referenced"],
  [10, "dm", "channel", "#dm"],
]

describe("0258 imported channel titles normalised", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.threads (
      id uuid PRIMARY KEY, title text, type text NOT NULL, created_from jsonb)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.thread_references (thread_id uuid NOT NULL)`)
    for (const [n, type, entityType, title] of ROWS) {
      await sql.unsafe(
        `INSERT INTO mig0258_imported_titles.threads (id, title, type, created_from)
         VALUES ($1, $2, $3, CASE WHEN $4::text IS NULL THEN NULL
           ELSE jsonb_build_object('app', 'x', 'entityType', $4::text, 'entityId', 'e') END)`,
        [id(n), title, type, entityType],
      )
    }
    await sql.unsafe(`INSERT INTO mig0258_imported_titles.thread_references VALUES ('${id(9)}')`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  const expected = {
    [id(1)]: "general",
    [id(2)]: "ops",
    [id(3)]: "#",
    [id(4)]: "#1 priority",
    [id(5)]: "#anchored",
    [id(6)]: "already-clean",
    [id(7)]: null,
    [id(8)]: "#plain-channel-left-to-0257",
    [id(9)]: "#referenced",
    [id(10)]: "#dm",
  }

  it("rewrites imported channel titles, leaves empty results, DMs, anchored and referenced rooms alone", async () => {
    await applyMigration()
    expect(await titles()).toEqual(expected)
  })

  it("agrees with the server's normalizeChannelTitle", () => {
    expect(normalizeChannelTitle("#general")).toBe("general")
    expect(normalizeChannelTitle("  ## ops ")).toBe("ops")
  })

  it("is idempotent", async () => {
    await applyMigration()
    expect(await titles()).toEqual(expected)
  })
})
