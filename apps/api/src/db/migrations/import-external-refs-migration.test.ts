// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0208_import_external_refs: the import dedup columns and their partial unique
// indexes, and the task-dependency id the import ledger names rows by. The
// file must replay on a database that already has it (a hand-applied hotfix,
// a re-run) and leave exactly one column and one index of each behind.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0208_import_external_refs.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await sql.end()
})

async function shape(): Promise<Record<string, number>> {
  const [row] = await sql<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE (table_schema, table_name, column_name) IN (
          ('app_knowledge', 'documents', 'external_ref'),
          ('app_knowledge', 'collections', 'external_ref'),
          ('kernel', 'messages', 'external_ref'),
          ('app_projects', 'task_dependencies', 'id'))) AS columns,
      (SELECT count(*)::int FROM pg_indexes
        WHERE (schemaname, indexname) IN (
          ('app_knowledge', 'uniq_app_knowledge_documents_external_ref'),
          ('app_knowledge', 'uniq_app_knowledge_collections_external_ref'),
          ('kernel', 'uniq_kernel_messages_thread_external_ref'),
          ('app_projects', 'app_projects_task_dependencies_id_key'),
          ('kernel', 'import_ledger_files_once'))) AS indexes,
      (SELECT count(*)::int FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ('uniq_app_knowledge_documents_external_ref', 'import_ledger_files_once',
                            'uniq_app_knowledge_collections_external_ref',
                            'uniq_kernel_messages_thread_external_ref')
          AND i.indisunique AND i.indpred IS NOT NULL) AS partial_uniques`
  return row!
}

describe("0208_import_external_refs", () => {
  it("is applied: four columns, five indexes, the external refs partial and unique", async () => {
    expect(await shape()).toEqual({ columns: 4, indexes: 5, partial_uniques: 4 })
  })

  it("replays on a database that already has it and changes nothing", async () => {
    for (let i = 0; i < 2; i++) {
      for (const statement of readFileSync(FILE, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement)
      }
    }
    expect(await shape()).toEqual({ columns: 4, indexes: 5, partial_uniques: 4 })
  })

  it("every task dependency has an id, and ids are unique", async () => {
    const [row] = await sql<{ nulls: number }[]>`
      SELECT count(*)::int AS nulls FROM app_projects.task_dependencies WHERE id IS NULL`
    expect(row!.nulls).toBe(0)
    const [col] = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'app_projects' AND table_name = 'task_dependencies'
        AND column_name = 'id'`
    expect(col!.is_nullable).toBe("NO")
  })
})
