// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every ON CONFLICT on the mail send and persist path names a target Postgres
// can infer, on the migrated schema. An upsert whose target matches no unique
// index fails with 42P10 on EVERY write: on 2026-10-01 a deployment whose mail
// uniques had fallen back to plain indexes (0116, on duplicate rows) refused
// every sync page and every sent-mail record, so each approved mail:compose was
// sent by Gmail and then parked "ambiguous". 0118 merged the duplicates and built
// the uniques; registration adds a declared UNIQUE a live table lacks. This test
// is the standing check that each target the code names has its index.
//
// A target needs a unique index on exactly its columns. A partial index is only
// inferred when the clause repeats its predicate, so a clause with no WHERE needs
// a NON-partial unique, and one with a WHERE needs the partial one.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"

const SRC = path.resolve(import.meta.dir, "../..")

/** The files the mail send and persist path runs, and the upsert targets they name. */
const FILES = [
  "modules/mail/page-write.ts",
  "modules/mail/service.ts",
  "modules/mail/sender-contacts.ts",
  "modules/apps/sandbox/bridge/conversion.ts",
  "modules/approvals/handler-protocol.ts",
  "modules/apps/run-approved-handler.ts",
]

interface Target {
  schema: string
  table: string
  columns: string[]
  partial: boolean
}

const TARGETS: Target[] = [
  {
    schema: "app_mail",
    table: "conversations",
    columns: ["org_id", "account_id", "external_thread_id"],
    partial: false,
  },
  {
    schema: "app_mail",
    table: "messages",
    columns: ["org_id", "account_id", "external_message_id"],
    partial: false,
  },
  {
    schema: "app_tickets",
    table: "messages",
    columns: ["org_id", "external_message_id"],
    partial: true,
  },
  {
    schema: "kernel",
    table: "resource_grants",
    columns: ["resource_type", "resource_id", "grantee_kind", "grantee"],
    partial: false,
  },
  {
    schema: "kernel",
    table: "approved_handler_executions",
    columns: ["approval_request_id", "tool_name"],
    partial: false,
  },
  // sender-contacts' Drizzle upsert (target + targetWhere), not a raw clause.
  {
    schema: "kernel",
    table: "contacts",
    columns: ["org_id", "audience_key", "email"],
    partial: true,
  },
]

const key = (columns: string[]) => [...columns].sort().join(",")

function rawClauses(): Array<{ file: string; columns: string[]; partial: boolean }> {
  const out: Array<{ file: string; columns: string[]; partial: boolean }> = []
  for (const file of FILES) {
    const text = readFileSync(path.join(SRC, file), "utf8")
    for (const m of text.matchAll(/ON CONFLICT \(([^)]*)\)\s*(WHERE\b[^\n]*?)?\s*DO\b/g)) {
      const columns = (m[1] ?? "").split(",").map((c) => c.trim())
      out.push({ file, columns, partial: m[2] !== undefined })
    }
  }
  return out
}

describe("mail send path ON CONFLICT targets", () => {
  it("every raw ON CONFLICT clause on the path is a declared target", () => {
    const clauses = rawClauses()
    expect(clauses.length).toBeGreaterThan(0)
    const declared = new Set(TARGETS.map((t) => `${key(t.columns)}|${t.partial}`))
    const undeclared = clauses
      .filter((c) => !declared.has(`${key(c.columns)}|${c.partial}`))
      .map((c) => `${c.file}: (${c.columns.join(", ")})${c.partial ? " WHERE ..." : ""}`)
    expect(undeclared).toEqual([])
  })

  it("each target has a unique index Postgres can infer for it", async () => {
    const missing: string[] = []
    for (const t of TARGETS) {
      const rows = await sql<{ cols: string; partial: boolean }[]>`
        SELECT (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                  FROM unnest(i.indkey) AS k(attnum)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols,
               (i.indpred IS NOT NULL) AS partial
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = ${t.schema} AND t.relname = ${t.table} AND i.indisunique`
      const ok = rows.some((r) => r.cols === key(t.columns) && r.partial === t.partial)
      if (!ok) missing.push(`${t.schema}.${t.table} (${t.columns.join(", ")})`)
    }
    expect(missing).toEqual([])
  })
})
