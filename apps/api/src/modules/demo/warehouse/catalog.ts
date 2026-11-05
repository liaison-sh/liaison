// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The curated read catalog a real ops team would have over this warehouse.
//
// These are the questions somebody asks every week and does not want to write
// SQL for twice: revenue by month, what is coming back and why, which dealers
// are past their terms, who the best customers are, how many weeks of stock is
// left, whether a firmware release is returning worse than the one before it.
// `db_query` still answers everything else; the catalog is the shortcut, not
// the ceiling.
//
// Read descriptions are USER FACING: an agent shows them to a visitor, so they
// carry no dash punctuation.

import type { ReadCatalog } from "@liaison/db-core"
import { registerAdapter, validateCatalog } from "@liaison/db-core"
import { DEMO_WAREHOUSE_ADAPTER, DEMO_WAREHOUSE_SCHEMA as S } from "./sentinel"

// Every column of every table, so a joined read can declare exactly which
// tables it touches without spelling each JOIN key out again. Nothing in this
// schema is a secret column (see schema.ts), which is why a full-table
// declaration is honest here and would not be for the liaison-self adapter.
const COLS = {
  products: [
    "sku",
    "title",
    "tier",
    "list_price_minor",
    "currency",
    "weight_kg",
    "launched_on",
    "is_serialized",
  ],
  dealers: [
    "dealer_code",
    "name",
    "country",
    "tier",
    "credit_terms_days",
    "credit_limit_minor",
    "vat_number",
    "onboarded_on",
  ],
  customers: ["customer_code", "name", "email", "country", "segment", "first_order_on"],
  rma_reasons: ["reason_code", "label", "category", "is_hardware_fault"],
  orders: [
    "order_id",
    "order_ref",
    "order_date",
    "channel",
    "customer_code",
    "dealer_code",
    "currency",
    "subtotal_minor",
    "discount_minor",
    "shipping_minor",
    "tax_minor",
    "total_minor",
    "ship_country",
    "status",
    "due_on",
    "paid_on",
  ],
  order_lines: [
    "line_id",
    "order_id",
    "line_no",
    "sku",
    "quantity",
    "unit_price_minor",
    "discount_minor",
    "line_total_minor",
  ],
  rmas: [
    "rma_id",
    "rma_ref",
    "order_id",
    "sku",
    "serial_number",
    "reason_code",
    "firmware_version",
    "opened_on",
    "closed_on",
    "status",
    "resolution",
    "refund_minor",
    "ship_country",
  ],
  inventory_movements: [
    "movement_id",
    "sku",
    "moved_on",
    "movement_type",
    "quantity",
    "location",
    "reference",
  ],
  device_telemetry: [
    "report_id",
    "serial_number",
    "sku",
    "firmware_version",
    "reported_on",
    "country",
    "uptime_hours",
    "crash_count",
    "session_count",
  ],
  warranties: [
    "warranty_id",
    "serial_number",
    "sku",
    "order_id",
    "plan",
    "started_on",
    "ends_on",
    "status",
  ],
  monthly_revenue: [
    "month",
    "channel",
    "sku",
    "units",
    "gross_revenue_minor",
    "refunds_minor",
    "net_revenue_minor",
    "currency",
  ],
} as const

type TableName = keyof typeof COLS

/** `{ "demo_warehouse.orders": [...], ... }` for the tables a read touches. */
function grants(...tables: TableName[]): Record<string, string[]> {
  return Object.fromEntries(tables.map((t) => [`${S}.${t}`, [...COLS[t]]]))
}
function tableList(...tables: TableName[]): string[] {
  return tables.map((t) => `${S}.${t}`)
}

export const demoWarehouseCatalog: ReadCatalog = {
  adapter: DEMO_WAREHOUSE_ADAPTER,
  // Money, dealer terms and customer value are not every team's business: their
  // reads run only for the roles the demo org grants them (DEMO_DOMAIN_ACCESS,
  // seed/tiers/demo/role-scopes.ts), admins and holders of database:query:read.
  domains: {
    revenue: { tier: "confidential" },
    dealers: { tier: "confidential" },
    customers: { tier: "confidential" },
  },
  reads: {
    // ── revenue ────────────────────────────────────────────────────────────
    revenue_by_month: {
      description:
        "Net revenue, gross revenue, refunds and units per month and per sales channel, over a month range.",
      domain: "revenue",
      sql: `SELECT to_char(m.month, 'YYYY-MM') AS month, m.channel AS channel,
              sum(m.units) AS units,
              sum(m.gross_revenue_minor) AS gross_revenue_minor,
              sum(m.refunds_minor) AS refunds_minor,
              sum(m.net_revenue_minor) AS net_revenue_minor
            FROM ${S}.monthly_revenue m
            WHERE m.month >= :from_month::date AND m.month <= :to_month::date
            GROUP BY 1, 2 ORDER BY 1, 2`,
      params: {
        from_month: { type: "string", description: "First month, as YYYY-MM-01" },
        to_month: { type: "string", description: "Last month, as YYYY-MM-01" },
      },
      columns: [
        "month",
        "channel",
        "units",
        "gross_revenue_minor",
        "refunds_minor",
        "net_revenue_minor",
      ],
      tables: tableList("monthly_revenue"),
      grantColumns: grants("monthly_revenue"),
      resultIsAggregate: true,
      maxRows: 200,
    },
    revenue_by_product: {
      description:
        "Net revenue and units per product over a month range, best selling product first.",
      domain: "revenue",
      sql: `SELECT m.sku AS sku, p.title AS product_title, p.tier AS tier,
              sum(m.units) AS units,
              sum(m.gross_revenue_minor) AS gross_revenue_minor,
              sum(m.refunds_minor) AS refunds_minor,
              sum(m.net_revenue_minor) AS net_revenue_minor
            FROM ${S}.monthly_revenue m
            JOIN ${S}.products p ON p.sku = m.sku
            WHERE m.month >= :from_month::date AND m.month <= :to_month::date
            GROUP BY 1, 2, 3 ORDER BY 7 DESC`,
      params: {
        from_month: { type: "string", description: "First month, as YYYY-MM-01" },
        to_month: { type: "string", description: "Last month, as YYYY-MM-01" },
      },
      columns: [
        "sku",
        "product_title",
        "tier",
        "units",
        "gross_revenue_minor",
        "refunds_minor",
        "net_revenue_minor",
      ],
      tables: tableList("monthly_revenue", "products"),
      grantColumns: grants("monthly_revenue", "products"),
      resultIsAggregate: true,
      maxRows: 100,
    },
    monthly_revenue_for_product: {
      description:
        "The month by month revenue and unit history of one product, oldest month first.",
      domain: "revenue",
      sql: `SELECT to_char(m.month, 'YYYY-MM') AS month, m.channel AS channel,
              sum(m.units) AS units, sum(m.net_revenue_minor) AS net_revenue_minor,
              sum(m.refunds_minor) AS refunds_minor
            FROM ${S}.monthly_revenue m
            WHERE m.sku = :sku
            GROUP BY 1, 2 ORDER BY 1, 2`,
      params: { sku: { type: "string", description: "Product SKU, for example RAL-FLAG-02" } },
      columns: ["month", "channel", "units", "net_revenue_minor", "refunds_minor"],
      tables: tableList("monthly_revenue"),
      grantColumns: grants("monthly_revenue"),
      resultIsAggregate: true,
      maxRows: 200,
    },

    // ── returns ────────────────────────────────────────────────────────────
    returns_by_reason_and_product: {
      description:
        "Returns opened in a date range, grouped by product and reason code, most frequent reason first.",
      domain: "returns",
      sql: `SELECT r.sku AS sku, p.title AS product_title, r.reason_code AS reason_code,
              x.label AS reason_label, x.category AS reason_category,
              count(*) AS rma_count, sum(r.refund_minor) AS refunded_minor
            FROM ${S}.rmas r
            JOIN ${S}.products p ON p.sku = r.sku
            JOIN ${S}.rma_reasons x ON x.reason_code = r.reason_code
            WHERE r.opened_on >= :from_date::date AND r.opened_on <= :to_date::date
            GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`,
      params: {
        from_date: { type: "string", description: "First day, as YYYY-MM-DD" },
        to_date: { type: "string", description: "Last day, as YYYY-MM-DD" },
      },
      columns: [
        "sku",
        "product_title",
        "reason_code",
        "reason_label",
        "reason_category",
        "rma_count",
        "refunded_minor",
      ],
      tables: tableList("rmas", "products", "rma_reasons"),
      grantColumns: grants("rmas", "products", "rma_reasons"),
      resultIsAggregate: true,
      maxRows: 200,
    },
    returns_by_month_for_product: {
      description:
        "How many returns one product had per month, with the money refunded, oldest month first.",
      domain: "returns",
      sql: `SELECT to_char(date_trunc('month', r.opened_on), 'YYYY-MM') AS month,
              count(*) AS rma_count,
              count(*) FILTER (WHERE r.status = 'open') AS still_open,
              sum(r.refund_minor) AS refunded_minor
            FROM ${S}.rmas r
            WHERE r.sku = :sku
            GROUP BY 1 ORDER BY 1`,
      params: { sku: { type: "string", description: "Product SKU, for example RAL-FLAG-02" } },
      columns: ["month", "rma_count", "still_open", "refunded_minor"],
      tables: tableList("rmas"),
      grantColumns: grants("rmas"),
      resultIsAggregate: true,
      maxRows: 200,
    },
    rma_rate_by_product_and_firmware: {
      description:
        "Return rate per product and firmware version, measured against the devices that reported on that version. Use it to tell a bad release from a bad batch.",
      domain: "returns",
      sql: `WITH installed AS (
              SELECT t.sku AS sku, t.firmware_version AS firmware_version,
                     count(DISTINCT t.serial_number) AS devices
              FROM ${S}.device_telemetry t GROUP BY 1, 2
            ), returned AS (
              SELECT r.sku AS sku, r.firmware_version AS firmware_version, count(*) AS rma_count
              FROM ${S}.rmas r WHERE r.firmware_version IS NOT NULL GROUP BY 1, 2
            )
            SELECT i.sku AS sku, p.title AS product_title, i.firmware_version AS firmware_version,
              i.devices AS devices, COALESCE(n.rma_count, 0) AS rma_count,
              round(100.0 * COALESCE(n.rma_count, 0) / NULLIF(i.devices, 0), 2) AS rma_rate_pct
            FROM installed i
            JOIN ${S}.products p ON p.sku = i.sku
            LEFT JOIN returned n ON n.sku = i.sku AND n.firmware_version = i.firmware_version
            WHERE i.devices >= :min_devices
            ORDER BY 6 DESC`,
      params: {
        min_devices: {
          type: "integer",
          description: "Ignore combinations with fewer reporting devices than this",
        },
      },
      columns: ["sku", "product_title", "firmware_version", "devices", "rma_count", "rma_rate_pct"],
      tables: tableList("device_telemetry", "rmas", "products"),
      grantColumns: grants("device_telemetry", "rmas", "products"),
      resultIsAggregate: true,
      maxRows: 200,
    },
    open_rmas_older_than: {
      description: "Returns that are still open after a given number of days, oldest first.",
      domain: "returns",
      sql: `SELECT r.rma_ref AS rma_ref, r.sku AS sku, r.serial_number AS serial_number,
              r.reason_code AS reason_code, r.firmware_version AS firmware_version,
              r.opened_on AS opened_on, r.ship_country AS ship_country,
              (current_date - r.opened_on) AS days_open
            FROM ${S}.rmas r
            WHERE r.status = 'open' AND r.opened_on <= current_date - :days::integer
            ORDER BY 6`,
      params: { days: { type: "integer", description: "Age threshold in days" } },
      columns: [
        "rma_ref",
        "sku",
        "serial_number",
        "reason_code",
        "firmware_version",
        "opened_on",
        "ship_country",
        "days_open",
      ],
      tables: tableList("rmas"),
      grantColumns: grants("rmas"),
      resultIsAggregate: true,
      maxRows: 200,
    },

    // ── dealers ────────────────────────────────────────────────────────────
    dealer_aging: {
      description:
        "Dealer invoices that are not settled yet, with how much is already past the dealer's credit terms. The past due column is what a chase list is built from.",
      domain: "dealers",
      sql: `SELECT d.dealer_code AS dealer_code, d.name AS dealer_name, d.country AS country,
              d.credit_terms_days AS credit_terms_days, d.credit_limit_minor AS credit_limit_minor,
              count(*) AS open_invoices,
              sum(o.total_minor) AS outstanding_minor,
              sum(CASE WHEN o.due_on < :as_of::date THEN o.total_minor ELSE 0 END) AS past_due_minor,
              max(CASE WHEN o.due_on < :as_of::date THEN (:as_of::date - o.due_on) ELSE 0 END) AS worst_days_past_due
            FROM ${S}.orders o
            JOIN ${S}.dealers d ON d.dealer_code = o.dealer_code
            WHERE o.channel = 'dealer' AND o.paid_on IS NULL
            GROUP BY 1, 2, 3, 4, 5 ORDER BY 8 DESC`,
      params: { as_of: { type: "string", description: "The date to age against, as YYYY-MM-DD" } },
      columns: [
        "dealer_code",
        "dealer_name",
        "country",
        "credit_terms_days",
        "credit_limit_minor",
        "open_invoices",
        "outstanding_minor",
        "past_due_minor",
        "worst_days_past_due",
      ],
      tables: tableList("orders", "dealers"),
      grantColumns: grants("orders", "dealers"),
      resultIsAggregate: true,
      maxRows: 100,
    },
    dealer_sales_by_quarter: {
      description: "One dealer's ordered value and unit count per calendar quarter, oldest first.",
      domain: "dealers",
      sql: `SELECT to_char(date_trunc('quarter', o.order_date), 'YYYY"Q"Q') AS quarter,
              count(DISTINCT o.order_id) AS order_count,
              sum(l.quantity) AS units,
              sum(o.total_minor) AS ordered_minor
            FROM ${S}.orders o
            JOIN ${S}.order_lines l ON l.order_id = o.order_id
            WHERE o.dealer_code = :dealer_code
            GROUP BY 1 ORDER BY 1`,
      params: {
        dealer_code: { type: "string", description: "Dealer code, for example EU-DE" },
      },
      columns: ["quarter", "order_count", "units", "ordered_minor"],
      tables: tableList("orders", "order_lines"),
      grantColumns: grants("orders", "order_lines"),
      resultIsAggregate: true,
      maxRows: 100,
    },

    // ── customers ──────────────────────────────────────────────────────────
    top_customers_by_lifetime_value: {
      description:
        "Direct customers ranked by everything they have ever spent, with their order count and the dates either side of it.",
      domain: "customers",
      sql: `SELECT c.customer_code AS customer_code, c.name AS customer_name, c.country AS country,
              c.segment AS segment,
              count(DISTINCT o.order_id) AS order_count,
              sum(o.total_minor) AS lifetime_value_minor,
              min(o.order_date) AS first_order_date,
              max(o.order_date) AS last_order_date
            FROM ${S}.orders o
            JOIN ${S}.customers c ON c.customer_code = o.customer_code
            GROUP BY 1, 2, 3, 4
            HAVING count(DISTINCT o.order_id) >= :min_orders
            ORDER BY 6 DESC`,
      params: {
        min_orders: {
          type: "integer",
          description: "Only customers with at least this many orders",
        },
      },
      columns: [
        "customer_code",
        "customer_name",
        "country",
        "segment",
        "order_count",
        "lifetime_value_minor",
        "first_order_date",
        "last_order_date",
      ],
      tables: tableList("orders", "customers"),
      grantColumns: grants("orders", "customers"),
      resultIsAggregate: true,
      maxRows: 200,
    },
    sales_by_country: {
      description:
        "Where the money came from: order count and value per destination country over a date range.",
      domain: "customers",
      sql: `SELECT o.ship_country AS ship_country, o.channel AS channel,
              count(*) AS order_count, sum(o.total_minor) AS ordered_minor
            FROM ${S}.orders o
            WHERE o.order_date >= :from_date::date AND o.order_date <= :to_date::date
            GROUP BY 1, 2 ORDER BY 4 DESC`,
      params: {
        from_date: { type: "string", description: "First day, as YYYY-MM-DD" },
        to_date: { type: "string", description: "Last day, as YYYY-MM-DD" },
      },
      columns: ["ship_country", "channel", "order_count", "ordered_minor"],
      tables: tableList("orders"),
      grantColumns: grants("orders"),
      resultIsAggregate: true,
      maxRows: 200,
    },

    // ── inventory and devices ──────────────────────────────────────────────
    stock_cover_by_product: {
      description:
        "Units on hand per product, the recent sales rate behind it, and how many days of cover that leaves. Lowest cover first.",
      domain: "inventory",
      sql: `WITH on_hand AS (
              SELECT m.sku AS sku, sum(m.quantity) AS units_on_hand
              FROM ${S}.inventory_movements m GROUP BY 1
            ), velocity AS (
              SELECT m.sku AS sku, sum(-m.quantity) AS units_sold
              FROM ${S}.inventory_movements m
              WHERE m.movement_type = 'sale'
                AND m.moved_on >= current_date - :lookback_days::integer
              GROUP BY 1
            )
            SELECT h.sku AS sku, p.title AS product_title, h.units_on_hand AS units_on_hand,
              COALESCE(v.units_sold, 0) AS units_sold_in_window,
              round(COALESCE(v.units_sold, 0)::numeric / NULLIF(:lookback_days::integer, 0), 3) AS units_per_day,
              round(h.units_on_hand / NULLIF(COALESCE(v.units_sold, 0)::numeric / NULLIF(:lookback_days::integer, 0), 0), 1) AS days_of_cover
            FROM on_hand h
            JOIN ${S}.products p ON p.sku = h.sku
            LEFT JOIN velocity v ON v.sku = h.sku
            ORDER BY 6 NULLS LAST`,
      params: {
        lookback_days: {
          type: "integer",
          description: "How many days of sales the rate is measured over, for example 90",
        },
      },
      columns: [
        "sku",
        "product_title",
        "units_on_hand",
        "units_sold_in_window",
        "units_per_day",
        "days_of_cover",
      ],
      tables: tableList("inventory_movements", "products"),
      grantColumns: grants("inventory_movements", "products"),
      resultIsAggregate: true,
      maxRows: 100,
    },
    firmware_adoption: {
      description:
        "How the installed base of one product is spread across firmware versions, with the crash counts those devices reported.",
      domain: "devices",
      sql: `SELECT t.firmware_version AS firmware_version,
              count(DISTINCT t.serial_number) AS devices,
              sum(t.crash_count) AS crash_total,
              round(avg(t.crash_count), 2) AS crashes_per_device,
              round(avg(t.uptime_hours), 1) AS avg_uptime_hours
            FROM ${S}.device_telemetry t
            WHERE t.sku = :sku
            GROUP BY 1 ORDER BY 1`,
      params: { sku: { type: "string", description: "Product SKU, for example RAL-FLAG-01" } },
      columns: [
        "firmware_version",
        "devices",
        "crash_total",
        "crashes_per_device",
        "avg_uptime_hours",
      ],
      tables: tableList("device_telemetry"),
      grantColumns: grants("device_telemetry"),
      resultIsAggregate: true,
      maxRows: 100,
    },
    warranties_expiring_between: {
      description:
        "Warranties that run out inside a date range, so the renewal list can be pulled before they lapse.",
      domain: "warranty",
      sql: `SELECT w.serial_number AS serial_number, w.sku AS sku, p.title AS product_title,
              w.plan AS plan, w.started_on AS started_on, w.ends_on AS ends_on, w.status AS status,
              o.customer_code AS customer_code
            FROM ${S}.warranties w
            JOIN ${S}.products p ON p.sku = w.sku
            JOIN ${S}.orders o ON o.order_id = w.order_id
            WHERE w.ends_on >= :from_date::date AND w.ends_on <= :to_date::date
            ORDER BY 6`,
      params: {
        from_date: { type: "string", description: "First day, as YYYY-MM-DD" },
        to_date: { type: "string", description: "Last day, as YYYY-MM-DD" },
      },
      columns: [
        "serial_number",
        "sku",
        "product_title",
        "plan",
        "started_on",
        "ends_on",
        "status",
        "customer_code",
      ],
      tables: tableList("warranties", "products", "orders"),
      grantColumns: grants("warranties", "products", "orders"),
      resultIsAggregate: true,
      maxRows: 300,
    },
    product_catalog: {
      description: "Every product the warehouse knows, with its list price, tier and launch date.",
      domain: "revenue",
      sql: `SELECT sku, title, tier, list_price_minor, currency, weight_kg, launched_on, is_serialized
            FROM ${S}.products ORDER BY tier, sku`,
      params: {},
      columns: [
        "sku",
        "title",
        "tier",
        "list_price_minor",
        "currency",
        "weight_kg",
        "launched_on",
        "is_serialized",
      ],
      tables: tableList("products"),
      grantColumns: grants("products"),
      maxRows: 100,
    },
  },
}

/** Validated at import time, so a broken read fails at boot, never at a tool call. */
validateCatalog(demoWarehouseCatalog)
registerAdapter(demoWarehouseCatalog)
