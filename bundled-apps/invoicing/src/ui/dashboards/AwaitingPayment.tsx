// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Awaiting-payment dashboard. Outstanding (status='issued' AND
// payment_status != 'paid') sorted by age descending. Footer: total
// outstanding per currency. Empty state: "All issued documents are paid. ✓".
import { tr } from "../i18n"
import { createResource, createSignal, type Component } from "solid-js"
import { AWAITING_PAYMENT_COLUMNS, EMPTY_STATE, toCsv } from "./columns"
import { DEFAULT_FILTER, applyFilter, type DashboardFilter, type DocumentRow } from "./types"
import { searchDocuments, searchParamsFromFilter } from "./loader"
import { Toolbar } from "./Toolbar"
import { DataTable } from "./DataTable"
import { formatMoneyMinor } from "../../money"

export function isOutstanding(r: DocumentRow): boolean {
  // Credit notes issue straight to 'issued' and are NEVER payable (no due date, no mark_paid) — they
  // must never appear as an outstanding receivable even though their payment_status defaults to
  // 'unpaid' like everything else. Explicit type gate, not just relying on the (also-true) absence of
  // due_at, mirrors the overdue-scan job's belt-and-braces `doc.type !== "invoice"` guard.
  return r.type !== "credit_note" && r.status === "issued" && r.payment_status !== "paid"
}

function ageDescending(rows: DocumentRow[]): DocumentRow[] {
  return [...rows].sort((a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0))
}

function outstandingFooter(rows: DocumentRow[]): string {
  if (rows.length === 0) return ""
  const perCurrency = new Map<string, bigint>()
  for (const r of rows) {
    const total = typeof r.grand_total_minor === "bigint" ? r.grand_total_minor : BigInt(r.grand_total_minor)
    perCurrency.set(r.currency, (perCurrency.get(r.currency) ?? 0n) + total)
  }
  return [...perCurrency.entries()]
    .map(([cur, sum]) => formatMoneyMinor(sum, cur))
    .join(" + ")
}

export const AwaitingPayment: Component = () => {
  const [filter, setFilter] = createSignal<DashboardFilter>({ ...DEFAULT_FILTER, status: "issued" })
  const [data] = createResource(filter, async (f) => {
    const rows = await searchDocuments({ ...searchParamsFromFilter(f), status: "issued" })
    return ageDescending(applyFilter(rows, f).filter(isOutstanding))
  })

  const exportCsv = () => {
    const rows = data() ?? []
    const csv = toCsv(AWAITING_PAYMENT_COLUMNS, rows) + `Total outstanding: ${outstandingFooter(rows)}`
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `invoicing-awaiting-payment-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div data-testid="invoicing-dashboard-awaiting-payment" class="flex h-full min-h-0 flex-col">
      <Toolbar
        filter={filter()}
        onChange={setFilter}
        onExportCsv={exportCsv}
        statusOptions={["issued", "overdue"]}
      />
      <DataTable
        columns={AWAITING_PAYMENT_COLUMNS}
        rows={data() ?? []}
        emptyState={EMPTY_STATE.awaiting_payment /* "All issued documents are paid. ✓" */}
        testid="invoicing-awaiting-payment-table"
        footer={() => tr("Total outstanding: {{amount}}", { amount: outstandingFooter(data() ?? []) })}
        rowHref={(r) => `/invoicing/document/${r.id}`}
      />
    </div>
  )
}
