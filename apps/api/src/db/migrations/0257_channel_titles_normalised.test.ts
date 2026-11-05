// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0257 rewrites channel titles to the server's channel-name rule (leading '#' and
// surrounding whitespace stripped). The live table is already migrated when this
// runs, so the file is replayed against SCRATCH copies in their own schema (0113's
// recipe): the statements are the file's own, only the schema name is swapped.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { normalizeChannelTitle } from "@liaison/shared"
import postgres from "postgres"

const FILE = new URL("./0257_channel_titles_normalised.sql", import.meta.url).pathname
const SCRATCH = "mig0257_channel_titles"

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

// [id, type, createdFrom, title]
const ROWS: [number, string, boolean, string | null][] = [
  [1, "thread", false, "#general"],
  [2, "thread", false, "  ## ops "],
  [3, "thread", false, "#"],
  [4, "agent_chat", false, "#1 priority"],
  [5, "thread", true, "#anchored"],
  [6, "thread", false, "already-clean"],
  [7, "thread", false, null],
  [8, "thread", false, " ​# ​sales "],
  [9, "thread", false, "a#b"],
  [10, "thread", false, "#referenced"],
]

describe("0257 channel titles normalised", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.threads (
      id uuid PRIMARY KEY, title text, type text NOT NULL, created_from jsonb)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.thread_references (thread_id uuid NOT NULL)`)
    for (const [n, type, anchored, title] of ROWS) {
      await sql.unsafe(
        `INSERT INTO mig0257_channel_titles.threads (id, title, type, created_from)
         VALUES ($1, $2, $3, ${anchored ? `'{"app":"x"}'::jsonb` : "NULL"})`,
        [id(n), title, type],
      )
    }
    await sql.unsafe(`INSERT INTO mig0257_channel_titles.thread_references VALUES ('${id(10)}')`)
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
    [id(8)]: "sales",
    [id(9)]: "a#b",
    [id(10)]: "#referenced",
  }

  it("rewrites channel titles, leaves empty results, DMs and anchored rooms alone", async () => {
    await applyMigration()
    expect(await titles()).toEqual(expected)
  })

  it("agrees with the server's normalizeChannelTitle", () => {
    for (const [, type, anchored, title] of ROWS) {
      if (type !== "thread" || anchored || title === null) continue
      const n = normalizeChannelTitle(title)
      if (n === "" || title === "#referenced") continue
      expect(expected[id(ROWS.findIndex((r) => r[3] === title) + 1)]).toBe(n)
    }
  })

  it("is idempotent", async () => {
    await applyMigration()
    expect(await titles()).toEqual(expected)
  })
})
