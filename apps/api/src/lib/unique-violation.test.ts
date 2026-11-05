// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The index names a constraint-scoped catch must match are NOT one name per
// index: the parallel test substrate clones each base schema with
// `CREATE TABLE ... (LIKE <src> INCLUDING ALL)`, and postgres regenerates the
// copied index's name from its columns instead of keeping the migrated one.
// These tests discover BOTH real names from a real clone (no hardcoded
// expectation) and assert the matcher accepts each of them, so a future
// rename on either side fails here rather than in production as a raw 500.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  AGENT_HANDLE_UNIQUE_INDEX,
  isUniqueViolationOn,
  ROUTINE_NAME_UNIQUE_INDEX,
  SKILL_NAME_UNIQUE_INDEX,
} from "~/lib/unique-violation"

const PROBE_SCHEMA = "uniqueviolationprobe"

/** A postgres.js PostgresError as the driver hands it to a catch block. */
function pgUniqueViolation(constraintName: string): Error {
  const err = new Error(
    `duplicate key value violates unique constraint "${constraintName}"`,
  ) as Error & { code: string; constraint_name: string }
  err.code = "23505"
  err.constraint_name = constraintName
  return err
}

/** Unique index names on `schema.table` covering exactly `columns`, in order. */
async function uniqueIndexNamesOn(
  schema: string,
  table: string,
  columns: string[],
): Promise<string[]> {
  const rows = await sql`
    SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = ${table} AND ix.indisunique
  `
  const wanted = `(${columns.join(", ")})`
  return rows.filter((r) => (r.def as string).endsWith(wanted)).map((r) => r.name as string)
}

describe("unique-violation: matching an index under every name it really carries", () => {
  beforeAll(async () => {
    // A LIKE clone the substrate's way, in a schema this test owns, so the
    // regenerated names come from postgres itself rather than from a comment.
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${PROBE_SCHEMA}`)
    await sql.unsafe(
      `CREATE TABLE ${PROBE_SCHEMA}.agents (LIKE kernel.agents INCLUDING ALL EXCLUDING CONSTRAINTS)`,
    )
    await sql.unsafe(
      `CREATE TABLE ${PROBE_SCHEMA}.skills (LIKE kernel.skills INCLUDING ALL EXCLUDING CONSTRAINTS)`,
    )
    await sql.unsafe(
      `CREATE TABLE ${PROBE_SCHEMA}.routines (LIKE kernel.routines INCLUDING ALL EXCLUDING CONSTRAINTS)`,
    )
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`)
  })

  it("kernel.agents (org_id, handle): both the migrated and the cloned name retry as a handle collision", async () => {
    const migrated = await uniqueIndexNamesOn("kernel", "agents", ["org_id", "handle"])
    const cloned = await uniqueIndexNamesOn(PROBE_SCHEMA, "agents", ["org_id", "handle"])
    expect(migrated.length).toBe(1)
    expect(cloned.length).toBe(1)
    // The names genuinely differ — that difference is the bug class.
    expect(cloned[0]).not.toBe(migrated[0])
    for (const name of [...migrated, ...cloned]) {
      expect(isUniqueViolationOn(pgUniqueViolation(name), AGENT_HANDLE_UNIQUE_INDEX)).toBe(true)
    }
  })

  it("kernel.skills (owner_agent_id, name): both names report a skill name_conflict", async () => {
    const migrated = await uniqueIndexNamesOn("kernel", "skills", ["owner_agent_id", "name"])
    const cloned = await uniqueIndexNamesOn(PROBE_SCHEMA, "skills", ["owner_agent_id", "name"])
    expect(migrated.length).toBe(1)
    expect(cloned.length).toBe(1)
    expect(cloned[0]).not.toBe(migrated[0])
    for (const name of [...migrated, ...cloned]) {
      expect(isUniqueViolationOn(pgUniqueViolation(name), SKILL_NAME_UNIQUE_INDEX)).toBe(true)
    }
  })

  it("kernel.routines (org_id, owner_user_id, name): both names report a routine name_conflict", async () => {
    const migrated = await uniqueIndexNamesOn("kernel", "routines", ["org_id", "owner_user_id", "name"])
    const cloned = await uniqueIndexNamesOn(PROBE_SCHEMA, "routines", ["org_id", "owner_user_id", "name"])
    expect(migrated.length).toBe(1)
    expect(cloned.length).toBe(1)
    for (const name of [...migrated, ...cloned]) {
      expect(isUniqueViolationOn(pgUniqueViolation(name), ROUTINE_NAME_UNIQUE_INDEX)).toBe(true)
    }
  })

  it("an unrelated unique violation is not claimed by either matcher", () => {
    const other = pgUniqueViolation("users_org_email_idx")
    expect(isUniqueViolationOn(other, AGENT_HANDLE_UNIQUE_INDEX)).toBe(false)
    expect(isUniqueViolationOn(other, SKILL_NAME_UNIQUE_INDEX)).toBe(false)
  })

  it("falls back to the message when the driver carried no structured constraint name", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "agents_org_id_handle_idx"',
    ) as Error & { code: string }
    err.code = "23505"
    expect(isUniqueViolationOn(err, AGENT_HANDLE_UNIQUE_INDEX)).toBe(true)
  })

  it("a non-unique-violation error is never a match", () => {
    const err = new Error("some other failure") as Error & { code: string }
    err.code = "23503"
    expect(isUniqueViolationOn(err, AGENT_HANDLE_UNIQUE_INDEX)).toBe(false)
  })
})
