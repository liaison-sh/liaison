// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stand-ins for bundled-app reads whose answer carries a top-level `rows` list next to its
// figures, so a dashboard block charts them (a set of counts, a keyed map, one figure, a probe
// report). A bundled app is not installed in a fresh test org, so a test registers the read from
// its manifest with a handler answering this shape. Each shape is the one the app's own test
// pins on its real handler (named beside each entry); the dashboards guard checks that every
// stand-in gives a block rows, and every-read-sources.test.ts runs a block on each.

export interface ReadRowsStandIn {
  app: string
  tool: string
  /** What the variant is, when one read has several answers. */
  variant?: string
  result: unknown
  /** The rows a block gets from `result`. */
  rows: number
}

export const READ_ROWS_STAND_INS: ReadonlyArray<ReadRowsStandIn> = [
  // ads/src/reads.test.ts
  {
    app: "ads",
    tool: "ad_preview",
    result: {
      ad_format: "DESKTOP_FEED_STANDARD",
      body: "<iframe></iframe>",
      rows: [{ ad_format: "DESKTOP_FEED_STANDARD", body: "<iframe></iframe>" }],
    },
    rows: 1,
  },
  // ads/src/metrics/tools.test.ts
  {
    app: "ads",
    tool: "metrics_run",
    result: {
      value: "4.0000",
      formulaId: "blended_mer_dtc",
      formulaVersion: "1.1.0",
      lineage: { inputs: [], period: { start: "2026-07-01", end: "2026-07-31" } },
      caveats: ["Spend covers paid channels only."],
      rows: [
        {
          key: "blended_mer_dtc",
          value: "4.0000",
          period_start: "2026-07-01",
          period_end: "2026-07-31",
          degraded: false,
        },
      ],
    },
    rows: 1,
  },
  // boxtal/src/queues.test.ts
  {
    app: "boxtal",
    tool: "queue_counts",
    result: {
      to_prepare: 3,
      ready: 2,
      returns: 1,
      exceptions: 0,
      rows: [
        { key: "to_prepare", value: 3 },
        { key: "ready", value: 2 },
        { key: "returns", value: 1 },
        { key: "exceptions", value: 0 },
      ],
    },
    rows: 4,
  },
  // social/src/pending.test.ts
  {
    app: "social",
    tool: "counts",
    result: {
      findings_new: 2,
      awaiting_approval: 0,
      open_dms: 1,
      rows: [
        { key: "findings_new", value: 2 },
        { key: "awaiting_approval", value: 0 },
        { key: "open_dms", value: 1 },
      ],
    },
    rows: 3,
  },
  // pennylane/src/reads.test.ts
  {
    app: "pennylane",
    tool: "pnl_summary",
    result: {
      period: "2026-Q2",
      start: "2026-04-01",
      end: "2026-06-30",
      revenue_minor: "100000",
      cogs_minor: "40000",
      opex_minor: "0",
      other_minor: "0",
      gross_margin_minor: "60000",
      rows: [
        { key: "revenue_minor", value: "100000" },
        { key: "cogs_minor", value: "40000" },
        { key: "opex_minor", value: "0" },
        { key: "other_minor", value: "0" },
        { key: "gross_margin_minor", value: "60000" },
      ],
    },
    rows: 5,
  },
  {
    app: "pennylane",
    tool: "home_load",
    result: {
      pnl: {
        period: "2026-Q2",
        revenue_minor: "100000",
        cogs_minor: "40000",
        opex_minor: "0",
        other_minor: "0",
        gross_margin_minor: "60000",
        refreshed_at: "2026-06-10",
      },
      cash: {
        total_by_currency: { EUR: "250000" },
        cash_status: "live",
        refreshed_at: "2026-06-10",
      },
      rows: [
        { key: "revenue_minor", value: "100000" },
        { key: "cogs_minor", value: "40000" },
        { key: "opex_minor", value: "0" },
        { key: "other_minor", value: "0" },
        { key: "gross_margin_minor", value: "60000" },
        { key: "cash_minor", currency: "EUR", value: "250000" },
      ],
    },
    rows: 6,
  },
  // monitoring/src/incidents-summary.test.ts
  {
    app: "monitoring",
    tool: "incidents_summary",
    result: {
      rows: [
        { key: "critical", status: "open", value: 1 },
        { key: "warning", status: "open", value: 1 },
        { key: "info", status: "open", value: 0 },
        { key: "acknowledged", status: "acknowledged", value: 1 },
        { key: "resolved24h", status: "resolved", value: 1 },
      ],
      data: {
        open: { critical: 1, warning: 1, info: 0, total: 2 },
        acknowledged: 1,
        resolved24h: 1,
        sources: [{ source: "watchdog", open: 2, worstSeverity: "critical", lastSeenAt: null }],
        generatedAt: "2026-11-12T00:00:00.000Z",
        profiles: [],
        warnings: [],
        sourceOrder: ["watchdog"],
        monitoringUrl: null,
        canConfigure: false,
      },
    },
    rows: 5,
  },
  // database/src/database.test.ts
  {
    app: "database",
    tool: "db_list_reads",
    result: {
      adapter: "example",
      reads: {
        open_tickets: { description: "Open tickets", domain: "support", params: {}, columns: [] },
      },
      rows: [
        {
          name: "open_tickets",
          description: "Open tickets",
          domain: "support",
          params: {},
          columns: [],
        },
      ],
    },
    rows: 1,
  },
  {
    app: "database",
    tool: "db_probe",
    result: {
      ok: false,
      mode: "direct",
      writeGrantsDetected: true,
      warnings: ["write grant"],
      rows: [
        { key: "ok", value: false },
        { key: "writeGrantsDetected", value: true },
        { key: "dangerousExecuteGrantsDetected", value: false },
        { key: "missingReads", value: 0 },
        { key: "warnings", value: 1 },
      ],
    },
    rows: 5,
  },
  // shopify/src/reads.test.ts, shopify/src/analytics-query.test.ts
  {
    app: "shopify",
    tool: "products_short_codes",
    result: {
      codes: { "DEV-2": "E2", STAND: "FS" },
      rows: [
        { sku: "DEV-2", code: "E2" },
        { sku: "STAND", code: "FS" },
      ],
    },
    rows: 2,
  },
  {
    app: "shopify",
    tool: "analytics_query",
    variant: "ShopifyQL, no timeGrain",
    result: {
      source: "shopifyql",
      metric: "units",
      period: { since: "2026-10-01", until: "2026-10-31" },
      groupBy: "sku",
      rows: [
        { sku: "A-1", units: 3 },
        { sku: "B-2", units: 5 },
      ],
      table: {
        columns: [{ name: "sku" }, { name: "units" }],
        rows: [["A-1", 3], { sku: "B-2", units: 5 }],
      },
    },
    rows: 2,
  },
  {
    app: "shopify",
    tool: "analytics_query",
    variant: "bounded tally",
    result: {
      source: "bounded_tally",
      partial: true,
      boundedTo: 12,
      totalCount: 12,
      rows: [{ key: "orders", value: 12, counted: 12, partial: true }],
      metric: "orders",
      period: { since: "2026-10-01", until: "2026-10-31" },
      groupBy: "none",
      note: "ShopifyQL is unavailable on this plan; this is a bounded in-context count.",
    },
    rows: 1,
  },
  // invoicing/src/einvoicing/settings-page.test.ts
  {
    app: "invoicing",
    tool: "einvoicing_settings_get",
    result: {
      status: "ok",
      settings: {
        id: "s1",
        provider_app: "pennylane",
        cutover_date: "2026-09-01",
        send_enabled: true,
        book_enabled: false,
        changed_by: null,
      },
      providers: ["pennylane"],
      registration: { status: "active" },
      rows: [
        { key: "provider_app", value: "pennylane" },
        { key: "cutover_date", value: "2026-09-01" },
        { key: "send_enabled", value: true },
        { key: "book_enabled", value: false },
        { key: "registration_status", value: "active" },
      ],
    },
    rows: 5,
  },
  // invoicing/src/legal-originals/record.test.ts
  {
    app: "invoicing",
    tool: "documents_download_pdf",
    result: {
      file_id: "file-1",
      url: "/api/files/file-1/inline",
      legal_original: true,
      management_copy: { file_id: "file-2", url: "/api/files/file-2/inline" },
      facturx_xml_file_id: "xml-file-1",
      rows: [
        { kind: "legal_original", file_id: "file-1", url: "/api/files/file-1/inline" },
        { kind: "management_copy", file_id: "file-2", url: "/api/files/file-2/inline" },
        { kind: "facturx_xml", file_id: "xml-file-1", url: null },
      ],
    },
    rows: 3,
  },
]
