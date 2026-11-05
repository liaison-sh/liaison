// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T24: this slice's migrations must be safe to run twice, in the two
// ways that can go wrong (the shape 0073's own idempotency test established):
//   1. The LEDGER half: `bun src/db/migrate.ts` run twice must apply NOTHING
//      the second time, leaving drizzle.__drizzle_migrations untouched.
//   2. The SQL half: each file's own statements, replayed against a database
//      that already has them, must succeed and leave exactly one column, one
//      constraint, one index, one trigger and one policy behind. This is what
//      the ledger skip hides, and what a hand-applied hotfix hits for real.
//
// The privileged DSN follows scripts/db-reset.ts's convention: migrations run
// as an owner role and DATABASE_URL is the unprivileged app role.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const API_DIR = new URL("../../..", import.meta.url).pathname
const FILES = {
  "0075": new URL("./0075_thread_participants_agent_membership.sql", import.meta.url).pathname,
  "0076": new URL("./0076_threads_discoverable_messages_author_agent.sql", import.meta.url)
    .pathname,
  "0077": new URL("./0077_threads_select_discoverable.sql", import.meta.url).pathname,
  "0078": new URL("./0078_thread_participants_type_matches_ids.sql", import.meta.url).pathname,
  "0079": new URL("./0079_thread_participants_type_vocabulary.sql", import.meta.url).pathname,
}

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const url = privilegedUrl()
const sql = postgres(url, { max: 1, onnotice: () => {} })

// The replays below recreate policies in their pre-0184 form (reading the
// context variables directly). Replaying the context migrations afterwards
// puts them back, so the database this file leaves behind is the migrated one.
const CONTEXT_MIGRATIONS = [
  "./0184_rls_org_context.sql",
  "./0185_rls_user_context.sql",
  "./0186_rls_context_once.sql",
].map((f) => new URL(f, import.meta.url).pathname)

afterAll(async () => {
  for (const file of CONTEXT_MIGRATIONS) {
    for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await sql.unsafe(statement)
    }
  }
  await sql.end()
})

async function ledgerRowCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
  return row!.n
}

/** The whole slice's shape in one row, so a replay that drops something shows. */
async function sliceShape(): Promise<Record<string, number | boolean>> {
  const [row] = await sql<Record<string, number | boolean>[]>`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'thread_participants'
          AND column_name IN ('participant_type', 'agent_id')) AS tp_columns,
      (SELECT is_nullable = 'YES' FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'thread_participants'
          AND column_name = 'user_id') AS tp_user_nullable,
      (SELECT count(*)::int FROM pg_constraint
        WHERE connamespace = 'kernel'::regnamespace
          AND conname IN ('thread_participants_agent_org_fk',
                          'thread_participants_one_of_user_or_agent',
                          'thread_participants_participant_type_vocabulary',
                          'thread_participants_type_matches_ids')) AS tp_constraints,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'kernel'
          AND indexname IN ('thread_participants_thread_user_idx',
                            'thread_participants_thread_agent_idx')) AS tp_indexes,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'kernel'
          AND (table_name, column_name) IN
              (('threads', 'discoverable'), ('messages', 'author_agent_id'))) AS new_columns,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conname = 'messages_author_agent_org_fk'
          AND connamespace = 'kernel'::regnamespace) AS msg_constraints,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'kernel' AND indexname = 'messages_author_agent_idx') AS msg_indexes,
      (SELECT count(*)::int FROM pg_trigger
        WHERE tgname = 'messages_agent_author_guard' AND NOT tgisinternal) AS msg_triggers,
      (SELECT count(*)::int FROM pg_policies
        WHERE schemaname = 'kernel' AND tablename = 'threads'
          AND policyname = 'threads_select' AND qual LIKE '%discoverable%') AS policies`
  return row!
}

const EXPECTED = {
  tp_columns: 2,
  tp_user_nullable: true,
  tp_constraints: 4,
  tp_indexes: 2,
  new_columns: 2,
  msg_constraints: 1,
  msg_indexes: 1,
  msg_triggers: 1,
  policies: 1,
}

async function runMigrateCommand(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "src/db/migrate.ts"], {
    cwd: API_DIR,
    env: { ...process.env, MIGRATION_DATABASE_URL: url, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: out + err }
}

describe("this slice's migrations are idempotent", () => {
  it("running this slice's migrations twice is a no-op the second time", async () => {
    const first = await runMigrateCommand()
    expect(first.code).toBe(0)
    const before = await ledgerRowCount()
    const second = await runMigrateCommand()
    expect(second.code).toBe(0)
    expect(await ledgerRowCount()).toBe(before)
    expect(await sliceShape()).toEqual(EXPECTED)
  })

  for (const [tag, file] of Object.entries(FILES)) {
    it(`replaying ${tag}'s own statements changes nothing`, async () => {
      const statements = readFileSync(file, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      expect(statements.length).toBeGreaterThan(0)
      for (const statement of statements) {
        await sql.unsafe(statement)
      }
      expect(await sliceShape()).toEqual(EXPECTED)
    })
  }
})
