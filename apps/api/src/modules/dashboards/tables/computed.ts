// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table read's computed columns, in one step after the rows are read (outside the table's
// transaction): lookup columns first (an app's tool, as the reader: tables/lookup.ts), then the
// formula columns, from the row's computed cell values (tables/formula.ts). Every read that
// returns rows goes through here: the grid and kernel__tables_query (listRows) and a dashboard
// table source (execute.ts).
import type { UserContext } from "~/db/rls"
import { dashboardTimezone } from "~/modules/dashboards/org-timezone"
import { dayIn } from "~/modules/dashboards/relative-dates"
import type { Column } from "~/modules/dashboards/tables/columns"
import { monthWindow } from "~/modules/dashboards/tables/columns"
import { applyFormulas, isMonthsFormula } from "~/modules/dashboards/tables/formula"
import { applyLookups } from "~/modules/dashboards/tables/lookup"

/** Does a read of these columns need the org's current month (a months-shaped formula)? */
export function needsMonth(columns: readonly Column[]): boolean {
  return columns.some((c) => c.type === "months" || isMonthsFormula(c, columns))
}

/** The org's current month, YYYY-MM in its timezone. */
export async function orgMonth(orgId: string): Promise<string> {
  return dayIn(await dashboardTimezone(orgId), new Date()).slice(0, 7)
}

/**
 * The rows with every computed column's cells in, and a note per column whose cells are empty
 * for a reason (a lookup whose read failed).
 */
export async function applyComputedColumns<R extends { cells: Record<string, unknown> }>(
  viewer: UserContext,
  tableId: string,
  columns: readonly Column[],
  rows: readonly R[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ rows: R[]; notes: Record<string, string> }> {
  const looked = await applyLookups(viewer, tableId, columns, rows, opts)
  if (!columns.some((c) => c.type === "formula")) return looked
  const month = columns.some((c) => isMonthsFormula(c, columns))
    ? await orgMonth(viewer.orgId)
    : null
  return {
    rows: applyFormulas(columns, looked.rows, (c) => (month ? monthWindow(c, month) : [])),
    notes: looked.notes,
  }
}
