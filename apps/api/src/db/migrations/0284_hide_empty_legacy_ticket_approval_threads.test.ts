// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0284 hides the empty "Ticket approval: <handle>" threads an earlier approval
// path left in thread lists. The live table is already migrated when this runs,
// so the file is replayed against SCRATCH copies in their own schema (0257's
// recipe): the statements are the file's own, only the schema name is swapped.
// Outside a transaction its SET LOCAL lines are no-ops, so the replay runs as
// the privileged test login, which owns the scratch tables.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0284_hide_empty_legacy_ticket_approval_threads.sql", import.meta.url)
  .pathname
const SCRATCH = "mig0284_ticket_approval_threads"

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

async function hidden(): Promise<Record<string, boolean>> {
  const rows = await sql.unsafe<{ id: string; hidden_from_list: boolean }[]>(
    `SELECT id::text, hidden_from_list FROM ${SCRATCH}.threads`,
  )
  return Object.fromEntries(rows.map((r) => [r.id, r.hidden_from_list]))
}

const TICKET = `{"app":"tickets","entityType":"ticket","entityId":"t-1"}`
const TASK = `{"app":"projects","entityType":"task","entityId":"k-1"}`

// [id, type, createdFrom, title, has a message, should end hidden]
const ROWS: [number, string, string | null, string | null, boolean, boolean][] = [
  [1, "thread", TICKET, "Ticket approval: ticket-0001", false, true],
  [2, "thread", TICKET, "Validation du ticket : ticket-0002", false, true],
  // Someone wrote in it: a real conversation, it stays.
  [3, "thread", TICKET, "Ticket approval: ticket-0003", true, false],
  // Another title on a ticket thread: not this path's row.
  [4, "thread", TICKET, "Refund for ticket-0004", false, false],
  // Same title, another anchor.
  [5, "thread", TASK, "Ticket approval: ticket-0005", false, false],
  // Not anchored at all.
  [6, "thread", null, "Ticket approval: ticket-0006", false, false],
  // Already an approval anchor: not of type thread.
  [7, "approval", TICKET, "Ticket approval: ticket-0007", false, false],
  [8, "thread", TICKET, null, false, false],
]

describe("0284 empty legacy ticket approval threads hidden", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.threads (
      id uuid PRIMARY KEY, title text, type text NOT NULL, created_from jsonb,
      hidden_from_list boolean NOT NULL DEFAULT false)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL)`)
    for (const [n, type, createdFrom, title, hasMessage] of ROWS) {
      await sql.unsafe(
        `INSERT INTO ${SCRATCH}.threads (id, title, type, created_from) VALUES ($1, $2, $3, $4::text::jsonb)`,
        [id(n), title, type, createdFrom],
      )
      if (hasMessage) {
        await sql.unsafe(`INSERT INTO ${SCRATCH}.messages (thread_id) VALUES ($1)`, [id(n)])
      }
    }
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  const expected = Object.fromEntries(ROWS.map((r) => [id(r[0]), r[5]]))

  it("hides only empty ticket-anchored approval threads, deletes nothing", async () => {
    await applyMigration()
    expect(await hidden()).toEqual(expected)
  })

  it("is idempotent", async () => {
    await applyMigration()
    expect(await hidden()).toEqual(expected)
  })

  it("runs its update as the BYPASSRLS admin role and resets the role after", () => {
    const text = readFileSync(FILE, "utf8")
    const role = text.search(/^SET LOCAL ROLE liaison_admin;/m)
    const update = text.search(/^UPDATE kernel\.threads/m)
    const reset = text.search(/^RESET ROLE;/m)
    expect(text.search(/^SET LOCAL lock_timeout = '5s';/m)).toBeGreaterThanOrEqual(0)
    expect(role).toBeGreaterThanOrEqual(0)
    expect(role).toBeLessThan(update)
    expect(update).toBeLessThan(reset)
  })
})
