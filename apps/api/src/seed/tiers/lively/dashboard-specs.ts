// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dashboard the lively org opens with: the founder's "Sales and support",
// shared with the whole org. It reads the org's own apps (invoicing, tickets,
// the carrier's queue), so its figures are the seeded world's.
const NOT_DRAFT = [{ field: "status", op: "neq", value: "draft" }]
const MONEY = { scale: 0.01, format: "currency", currency: "EUR" } as const

export const LIVELY_DASHBOARD_TITLE = "Sales and support"

export const LIVELY_DASHBOARD_SPEC = {
  v: 1,
  timeRange: { preset: "last90d" },
  compare: "none",
  datasets: {
    invoices: {
      kind: "tool",
      tool: "invoicing:documents_search",
      params: { type: "invoice", limit: 100 },
    },
    tickets: { kind: "tool", tool: "tickets:search", params: { limit: 200 }, rowsPath: "items" },
  },
  blocks: [
    {
      id: "revenue",
      type: "metric",
      title: "Invoiced",
      dataset: "invoices",
      timeRange: "fixed",
      width: 1,
      map: { value: "grand_total_minor", agg: "sum", ...MONEY, where: NOT_DRAFT },
    },
    {
      id: "open",
      type: "metric",
      title: "Open tickets",
      dataset: "tickets",
      timeRange: "fixed",
      width: 1,
      map: { agg: "count", where: [{ field: "status", op: "neq", value: "closed" }] },
    },
    {
      id: "queue",
      type: "metric",
      title: "Orders to prepare",
      source: { kind: "tool", tool: "boxtal:queue_counts", params: {}, rowsPath: "rows" },
      timeRange: "fixed",
      width: 1,
      map: {
        value: "value",
        agg: "sum",
        where: [{ field: "key", op: "eq", value: "to_prepare" }],
      },
    },
    {
      id: "byweek",
      type: "bar",
      title: "Invoiced by week",
      dataset: "invoices",
      timeRange: "fixed",
      width: 2,
      map: {
        groupBy: { field: "issued_at", bucket: "week" },
        y: "grand_total_minor",
        agg: "sum",
        ...MONEY,
        where: NOT_DRAFT,
      },
    },
    {
      id: "bycategory",
      type: "pie",
      title: "Tickets by category",
      dataset: "tickets",
      timeRange: "fixed",
      width: 1,
      map: { groupBy: { field: "categoryName" }, agg: "count" },
    },
    {
      id: "latest",
      type: "table",
      title: "Latest invoices",
      dataset: "invoices",
      timeRange: "fixed",
      width: 3,
      map: {
        columns: [
          { field: "number", label: "Number" },
          { field: "counterparty_name", label: "Customer" },
          { field: "issued_at", label: "Issued", format: "date" },
          { field: "payment_status", label: "Payment" },
        ],
        sort: { field: "issued_at", dir: "desc" },
        limit: 6,
        where: NOT_DRAFT,
      },
    },
  ],
}
