// SPDX-License-Identifier: FSL-1.1-ALv2
import { csvCell } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { AppContext } from "~/modules/apps/context"

/**
 * Built-in, in-process export handlers for manifest apps that own NO app
 * schema/handler bundle but still hold exportable data in kernel tables:
 *
 * - `contacts` — kernel-owned UI surface over `kernel.contacts`.
 *
 * These run on the in-process `(ctx, format)` registry path (ctx.db is the
 * caller's RLS-bound client), so the export never escalates. The runtime
 * resolves these by app name when a manifest app declares `export` but has no
 * `_bundlePath`. Apps that DO own a handler bundle (e.g. `google-drive`) own
 * their export handler in that bundle instead.
 */
interface ExportFilters {
  dateRange?: { from?: string; to?: string }
}

type BuiltinExportHandler = (
  ctx: AppContext,
  format: string,
  filters?: ExportFilters,
) => Promise<unknown>

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

export const BUILTIN_EXPORT_HANDLERS: Record<string, BuiltinExportHandler> = {
  contacts: async (ctx, format, filters) => {
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
  },
}
