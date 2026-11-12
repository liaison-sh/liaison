// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The contacts app's export (manifest `export.handler: exportContacts`): server
 * code over `kernel.contacts`, which the app owns as a kernel table (it has no
 * app schema and no handler bundle). It runs on the caller's RLS-bound client
 * (ctx.db, a whole-run transaction), so the export never escalates.
 */
import { csvCell } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { AppContext } from "~/modules/apps/context"

interface ExportFilters {
  dateRange?: { from?: string; to?: string }
}

// Optional `created_at BETWEEN` clause. Range narrows within the RLS-bound
// client (ctx.db) — it never escalates visibility.
function createdAtClause(filters?: ExportFilters) {
  const from = filters?.dateRange?.from
  const to = filters?.dateRange?.to
  if (!from && !to) return drizzleSql.raw("")
  if (from && to) return drizzleSql` AND created_at >= ${from} AND created_at <= ${to}`
  if (from) return drizzleSql` AND created_at >= ${from}`
  return drizzleSql` AND created_at <= ${to}`
}

function serialize(
  rows: Array<Record<string, unknown>>,
  columns: Array<[string, string]>,
  format: string,
): unknown {
  const projected = rows.map((row) => {
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of columns) {
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    return out
  })
  if (format === "csv") {
    const header = columns.map(([k]) => k).join(",")
    const body = projected.map((r) => columns.map(([k]) => csvCell(r[k])).join(",")).join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}

const CONTACTS_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["handle", "handle"],
  ["name", "name"],
  ["email", "email"],
  ["phone", "phone"],
  ["company", "company"],
  ["createdAt", "created_at"],
]

export async function exportContacts(
  ctx: AppContext,
  format: string,
  filters?: ExportFilters,
): Promise<unknown> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  // No LIMIT — a data-sovereignty export must return the full RLS-visible
  // set (E3 row-count equivalence), not a silently truncated 1000.
  const rows = extractRows<Record<string, unknown>>(
    await ctx.db.execute(
      drizzleSql`SELECT id, handle, name, email, phone, company, created_at
                   FROM ${K}.contacts
                   WHERE TRUE${createdAtClause(filters)}
                   ORDER BY created_at ASC`,
    ),
  )
  return serialize(rows, CONTACTS_COLUMNS, format)
}
