// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0113 repairs app_projects.projects.next_task_number after cross-project moves
// that kept their source numbers: a counter at or below a number already held in
// its project is raised to max(number) + 1; a counter already ahead is left
// alone. The live tables are already migrated when this runs, so the file is
// replayed against SCRATCH copies in their own schema: the statements are the
// file's own, only the schema name is swapped (0111's recipe).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0113_task_number_counter_repair.sql", import.meta.url).pathname
const SCRATCH = "mig0113_task_counter"

const LAGGING = "00000000-0000-0000-0000-00000000000a"
const AHEAD = "00000000-0000-0000-0000-00000000000b"
const EXACT = "00000000-0000-0000-0000-00000000000c"
const EMPTY = "00000000-0000-0000-0000-00000000000d"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

function migrationText(): string {
  return readFileSync(FILE, "utf8").replaceAll("app_projects.", `${SCRATCH}.`)
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationText().split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

async function counters(): Promise<Record<string, number>> {
  const rows = await sql.unsafe<{ id: string; n: number }[]>(
    `SELECT id::text, next_task_number AS n FROM ${SCRATCH}.projects`,
  )
  return Object.fromEntries(rows.map((r) => [r.id, r.n]))
}

describe("0113 task number counter repair", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.projects (
      id uuid PRIMARY KEY,
      next_task_number integer NOT NULL DEFAULT 1)`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES ${SCRATCH}.projects(id),
      number integer NOT NULL,
      UNIQUE (project_id, number))`)
    // LAGGING: tasks 5..53 moved in while the counter stayed at 5 (the prod shape).
    // AHEAD: counter past max (numbers were freed by deletes/moves out): keep it.
    // EXACT: counter already max+1. EMPTY: no tasks, counter 1.
    await sql.unsafe(`INSERT INTO ${SCRATCH}.projects (id, next_task_number) VALUES
      ('${LAGGING}', 5), ('${AHEAD}', 40), ('${EXACT}', 4), ('${EMPTY}', 1)`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.tasks (project_id, number)
      SELECT '${LAGGING}'::uuid, n FROM generate_series(1, 53) n`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.tasks (project_id, number) VALUES
      ('${AHEAD}', 1), ('${AHEAD}', 7), ('${EXACT}', 1), ('${EXACT}', 2), ('${EXACT}', 3)`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("raises a lagging counter to max(number) + 1 and leaves correct ones unchanged", async () => {
    expect(await counters()).toEqual({ [LAGGING]: 5, [AHEAD]: 40, [EXACT]: 4, [EMPTY]: 1 })
    await applyMigration()
    expect(await counters()).toEqual({ [LAGGING]: 54, [AHEAD]: 40, [EXACT]: 4, [EMPTY]: 1 })
  })

  it("is idempotent", async () => {
    await applyMigration()
    expect(await counters()).toEqual({ [LAGGING]: 54, [AHEAD]: 40, [EXACT]: 4, [EMPTY]: 1 })
  })
})
