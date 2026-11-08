// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 — VISUAL baselines for the Boxtal plugin's UI surfaces.
//
// These are FULL-PAGE shots (kernel shell + BoxtalSidebar + main panel) of the
// real operational workflows — the redesign replaced the bare per-panel goldens
// with populated, screenshot-worthy views: the invoice→shipment "to prepare"
// queue, the "ready to ship" print station, shipments master/detail, returns,
// catalog, create-draft, and settings.
//
// Each test intercepts `window.__liaisonHost.invokeTool` per-test with canned
// per-tool responses so every panel renders with fixed, representative data —
// no live tool round-trips and no sandbox-fetch dependency. The host splits the
// combined tool name on the first colon, so the interceptor key is
// `boxtal:<toolName>` (underscore-named tools, `.`↔`_` normalized).
//
// Pixel goldens are per platform (`*-darwin.png`, `*-linux.png`, helpers/pixel-baselines.ts). FUNCTIONAL assertions (panel +
// sidebar mount, content testids visible, expected text) run EVERYWHERE.
// Re-bake after an intentional UI change with:
//   bunx --bun playwright test --update-snapshots=all -g "Phase 18 — Boxtal — visual"

import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { PIXEL_BASELINES } from "../helpers/pixel-baselines"
import { volatileShellMasks } from "../helpers/visual-masks"
import { assertBoxtalBundle, BOXTAL_BUNDLE, expect, test } from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"

const SHOT = { maxDiffPixelRatio: 0.02 } as const

test.setTimeout(120_000)

// ─────────────────────────────────────────────────────────────────────────
// Representative fixtures — the shapes each tool returns over the host bridge.
// ─────────────────────────────────────────────────────────────────────────
const SENDER = {
  sender: {
    name: "Fabrikam SAS",
    phone: "+33123456789",
    street: "12 Rue de la Paix",
    city: "Paris",
    postalCode: "75002",
    countryIsoCode: "FR",
  },
  complete: true,
}

const CATALOG = {
  // packages_list's shape since one profile serves several variants: shared
  // profiles carry their variants, and variants with no profile are listed apart.
  shared_profiles: [
    {
      id: "p1",
      label: "Kestrel 2 — controller",
      short_code: "KES2",
      unit_weight: 0.8,
      variants: [{ product_source: "shopify", product_id: "VARIANT-STAB" }],
      short_code_sync: null,
    },
    {
      id: "p2",
      label: "USB-C cable 2m",
      short_code: null,
      unit_weight: 0.12,
      variants: [{ product_source: "shopify", product_id: "VARIANT-USBC" }],
      short_code_sync: null,
    },
    {
      id: "p3",
      label: null,
      short_code: null,
      unit_weight: 0,
      variants: [{ product_source: "manual", product_id: "SKU-NOWEIGHT" }],
      short_code_sync: null,
    },
  ],
  unprofiled_variants: [],
  packs: [
    {
      id: "k1",
      name: "Master box (10× Push)",
      gross_weight: 9.2,
      stale: false,
      components: [
        { product_source: "shopify", product_id: "VARIANT-STAB", quantity: 10, label: "Kestrel 2" },
      ],
    },
    {
      id: "k2",
      name: "Legacy bundle",
      gross_weight: 2.0,
      stale: true,
      components: [
        { product_source: "shopify", product_id: "DELETED-REF", quantity: 1, label: null },
      ],
    },
  ],
  local_products: [{ id: "l1", sku: "SKU-LOCAL-1", label: "Branded mailer box" }],
}

const SHIPMENT_ROWS = {
  results: [
    {
      id: "ord_globex_1",
      entity: "shipment",
      title: "Globex US",
      attributes: {
        order_status: "CONFIRMED",
        tracking_status: "IN_TRANSIT",
        carrier: "CHRP-Chrono13",
        cost: 25,
        document_ref: "inv-1",
        tracking_number: "CR260530000000000KZN1FR",
      },
    },
    {
      id: "ord_acme_2",
      entity: "shipment",
      title: "Acme SAS",
      attributes: {
        order_status: "CONFIRMED",
        tracking_status: "DELIVERED",
        carrier: "POFR-ColissimoAccess",
        cost: 12,
        document_ref: "inv-2",
        tracking_number: "6A210000000000FR",
      },
    },
    {
      id: "ord_wayne_3",
      entity: "shipment",
      title: "Wayne Enterprises",
      attributes: {
        order_status: "PENDING",
        tracking_status: null,
        carrier: "UPSE-ExpressSaver",
        cost: 42.1,
        document_ref: "inv-3",
        tracking_number: null,
      },
    },
  ],
  nextCursor: null,
}

const DOCS_CONFIRMED = {
  documents: [
    { type: "LABEL", format: "PDF_A4" },
    { type: "CN23", format: "PDF_A4" },
  ],
}

const DRAFT_RESOLVED = {
  document_ref: "inv-1",
  parcels: [{ length: 30, width: 20, height: 12, weight: 0.8 }],
  customsArticles: [
    {
      description: "Electronic musical instrument controller",
      quantity: 1,
      unitWeight: 0.8,
      tariffNumber: "92071000",
    },
  ],
  unresolved: [],
  recipient: "Globex US",
  route: "US",
  recipient_country: "US",
}

const OFFERS = {
  offers: [
    {
      offer_code: "MONR-CpourToi",
      carrier: "Mondial Relay",
      price_ht: 6.5,
      price_ttc: 7.8,
      currency: "EUR",
      delivery_date: "2026-06-03",
    },
    {
      offer_code: "CHRP-Chrono13",
      carrier: "Chronopost",
      price_ht: 11.2,
      price_ttc: 13.44,
      currency: "EUR",
      delivery_date: "2026-06-02",
    },
  ],
}

// New operational-view fixtures.
// to_prepare must equal PREP_LIST.rows.length: the badge and the prep grid share one source of
// truth in the real backend (queueCounts subtracts excluded refs), so the mocks must agree too.
const QUEUE_COUNTS = { to_prepare: 4, ready: 2, returns: 1 }

const TO_PREPARE = {
  rows: [
    {
      id: "tp1",
      invoice_ref: "INV-1042",
      customer: "Globex US",
      destination: "New York, US",
      items: 2,
      weight: 3.2,
      prep_status: "ready_to_prepare",
    },
    {
      id: "tp2",
      invoice_ref: "INV-1043",
      customer: "Acme SAS",
      destination: "Lyon, FR",
      items: 1,
      weight: 0.8,
      prep_status: "ready_to_prepare",
    },
    {
      id: "tp3",
      invoice_ref: "INV-1051",
      customer: "Initech GmbH",
      destination: "Berlin, DE",
      items: 4,
      weight: null,
      prep_status: "needs_fix",
      reason: "Missing weight",
    },
    {
      id: "tp4",
      invoice_ref: "INV-1052",
      customer: "Hooli Inc",
      destination: "Austin, US",
      items: 1,
      weight: 1.1,
      prep_status: "needs_fix",
      reason: "Bad address",
    },
  ],
}

// PrepGrid's own fixture (prep_list), in the exact PrepRow shape bundled-apps/boxtal/src/prep.ts
// buildRow emits: every row carries order_key, status, invoice, shipment and recipient. The rows
// cover an issued invoice, a proforma parked on approval, and an order with no document yet.
const offer = (carrier: string, code: string, htMinor: number, date: string, days: number) => ({
  carrier,
  service: "Standard",
  offer_code: code,
  price_ht_minor: htMinor,
  price_ttc_minor: Math.round(htMinor * 1.2),
  currency: "EUR",
  delivery_date: date,
  eta_business_days: days,
  is_pickup_point: false,
})
const noQuote = {
  cheapest: null,
  alternates: [],
  offers: [],
  selected_offer_code: null,
  selected: null,
  quoted_at: null,
  stale: false,
}
const recipient = (name: string, city: string, country: string) => ({
  name,
  company: name,
  email: "ops@example.com",
  phone: "+33612345678",
  street: "1 Main Street",
  city,
  postalCode: "10001",
  countryIsoCode: country,
  state: null,
  complete: true,
  missing_fields: [],
})
const issued = (docId: string, number: string) => ({
  state: "issued",
  document_id: docId,
  number,
  approval_id: null,
  kind: "invoice",
})
const PREP_ROW_BASE = {
  anchor_kind: "invoice",
  order_created_at: "2026-06-01T00:00:00.000Z",
  order_tags: [],
  currency: "EUR",
  category: "sale",
  status: "to_prepare",
  status_note: null,
  staff_note: null,
  excluded: false,
  validated: false,
  shipment: null,
}
const PREP_LIST = {
  rows: [
    {
      ...PREP_ROW_BASE,
      order_key: "tp1",
      document_ref: "doc-1042",
      invoice_ref: "INV-1042",
      order_name: "#1042",
      customer: "Globex US",
      destination: "US",
      order_tags: ["wholesale"],
      products: "2xES",
      grand_total_minor: 139800,
      parcels: [{ length: 30, width: 25, height: 20, weight: 3.2 }],
      package_count: 1,
      quote: {
        cheapest: offer("Chronopost", "CHRP-Chrono13", 980, "2026-06-02", 1),
        alternates: [],
        offers: [offer("Chronopost", "CHRP-Chrono13", 980, "2026-06-02", 1)],
        selected_offer_code: null,
        selected: null,
        quoted_at: "2026-06-01T01:00:00.000Z",
        stale: false,
      },
      state: "ready",
      invoice: issued("doc-1042", "INV-1042"),
      recipient: recipient("Globex US", "New York", "US"),
    },
    {
      ...PREP_ROW_BASE,
      order_key: "tp2",
      document_ref: "doc-1043",
      invoice_ref: "INV-1043",
      order_name: "#1043",
      customer: "Acme SAS",
      destination: "FR",
      products: "1xES",
      grand_total_minor: 69900,
      parcels: [{ length: 30, width: 25, height: 20, weight: 0.8 }],
      package_count: 1,
      quote: {
        cheapest: offer("Mondial Relay", "MRLY-Point", 540, "2026-06-03", 2),
        alternates: [],
        offers: [offer("Mondial Relay", "MRLY-Point", 540, "2026-06-03", 2)],
        selected_offer_code: null,
        selected: null,
        quoted_at: "2026-06-01T01:00:00.000Z",
        stale: false,
      },
      state: "ready",
      status: "validated",
      validated: true,
      invoice: issued("doc-1043", "INV-1043"),
      recipient: recipient("Acme SAS", "Lyon", "FR"),
    },
    {
      ...PREP_ROW_BASE,
      order_key: "tp3",
      document_ref: "doc-1051",
      anchor_kind: "proforma",
      invoice_ref: "PRO-1051",
      order_name: "#1051",
      order_created_at: "2026-06-02T00:00:00.000Z",
      customer: "Initech GmbH",
      destination: "DE",
      products: "4xES",
      grand_total_minor: 279600,
      parcels: [],
      package_count: 0,
      category: "repair",
      quote: noQuote,
      state: "needs_fix",
      reason: "Missing weight",
      invoice: {
        state: "pending_approval",
        document_id: null,
        number: null,
        approval_id: "appr-1051",
        kind: "proforma",
      },
      recipient: recipient("Initech GmbH", "Berlin", "DE"),
    },
    {
      ...PREP_ROW_BASE,
      order_key: "tp4",
      document_ref: "doc-1052",
      invoice_ref: "INV-1052",
      order_name: "#1052",
      order_created_at: "2026-06-02T00:00:00.000Z",
      customer: "Hooli Inc",
      destination: "US",
      products: "1xES",
      grand_total_minor: 69900,
      parcels: [{ length: 30, width: 25, height: 20, weight: 1.1 }],
      package_count: 1,
      quote: noQuote,
      state: "needs_fix",
      reason: "Bad address",
      invoice: issued("doc-1052", "INV-1052"),
      recipient: {
        ...recipient("Hooli Inc", "Austin", "US"),
        street: null,
        complete: false,
        missing_fields: ["street"],
      },
    },
    {
      ...PREP_ROW_BASE,
      order_key: "tp5",
      document_ref: null,
      anchor_kind: null,
      invoice_ref: "#1055",
      order_name: "#1055",
      order_created_at: "2026-06-03T00:00:00.000Z",
      customer: "Umbrella SARL",
      destination: "FR",
      products: "1xET2",
      grand_total_minor: 49900,
      parcels: [],
      package_count: 0,
      quote: noQuote,
      state: "not_synced",
      invoice: { state: "missing", document_id: null, number: null, approval_id: null, kind: null },
      recipient: recipient("Umbrella SARL", "Paris", "FR"),
    },
  ],
  total: 5,
  last_sync_at: "2026-06-01T08:00:00.000Z",
  truncated: false,
  last_sync_error: null,
  invoicing_available: true,
}

const READY = {
  rows: [
    {
      id: "r1",
      recipient: "Globex US",
      carrier: "Chronopost",
      tracking_number: "CR260530…KZN1FR",
      cost: 25,
      order_status: "CONFIRMED",
      has_label: true,
      invoice_ref: "INV-1042",
      order_name: "#1042",
      packed: false,
      packed_at: null,
      fulfillment_state: null,
      fulfillment_error: null,
    },
    {
      id: "r2",
      recipient: "Wayne Enterprises",
      carrier: "UPS Express Saver",
      tracking_number: "1Z999AA…88",
      cost: 42.1,
      order_status: "CONFIRMED",
      has_label: true,
      invoice_ref: "INV-1039",
      order_name: "#1039",
      // Packed and fulfilled: the whole row is light green.
      packed: true,
      packed_at: "2026-10-01T10:00:00.000Z",
      fulfillment_state: "fulfilled",
      fulfillment_error: null,
    },
  ],
}

const RETURNS = {
  rows: [
    {
      id: "rt1",
      customer: "Globex US",
      reason: "Defective unit",
      proforma_ref: "PRO-220",
      order_status: "CONFIRMED",
      tracking_status: "IN_TRANSIT",
      label_ready: true,
      created_by: "agent",
    },
    {
      id: "rt2",
      customer: "Stark Labs",
      reason: "Wrong item shipped",
      proforma_ref: "PRO-221",
      order_status: "PENDING",
      tracking_status: null,
      label_ready: false,
      created_by: "user",
    },
  ],
}

const BASE_MOCKS: Record<string, unknown> = {
  "boxtal:packages_list": CATALOG,
  "boxtal:settings_sender_address_get": SENDER,
  "boxtal:settings_sender_address_set": { ok: true },
  "boxtal:search": SHIPMENT_ROWS,
  "boxtal:get_documents": DOCS_CONFIRMED,
  "boxtal:shipment_draft_create": DRAFT_RESOLVED,
  "boxtal:quote": OFFERS,
  "boxtal:create_shipment": { boxtal_order_id: "ord_globex_1", order_status: "PENDING" },
  "boxtal:queue_counts": QUEUE_COUNTS,
  "boxtal:to_prepare_list": TO_PREPARE,
  "boxtal:prep_list": PREP_LIST,
  "boxtal:ready_list": READY,
  "boxtal:returns_list": RETURNS,
}

async function installHostMockInterceptor(
  page: import("@playwright/test").Page,
  overrides: Record<string, unknown> = {},
) {
  const mocks = { ...BASE_MOCKS, ...overrides }
  await page.addInitScript((m: Record<string, unknown>) => {
    const norm = (k: string) => k.replace(/\./g, "_")
    const lookup = (key: string): { hit: boolean; value: unknown } => {
      if (Object.hasOwn(m, key)) return { hit: true, value: m[key] }
      const n = norm(key)
      for (const mk of Object.keys(m)) {
        if (norm(mk) === n) return { hit: true, value: m[mk] }
      }
      return { hit: false, value: undefined }
    }
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    let real: any
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    Object.defineProperty(window as any, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const { hit, value } = lookup(`${appName}:${toolName}`)
            if (hit) return value
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${appName}:${toolName}`)
          },
        }
      },
    })
  }, mocks)
}

test.describe("Boxtal: visual baselines", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    assertBoxtalBundle()
    expect(existsSync(BOXTAL_BUNDLE)).toBe(true)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  // Navigate to an app route, wait for the BoxtalSidebar + a panel to mount,
  // optionally run an interaction, then full-page screenshot the whole shell.
  async function shotPage(
    page: import("@playwright/test").Page,
    env: { ports: number[] },
    relativeUrl: string,
    panelSelector: string,
    name: string,
    interact?: (page: import("@playwright/test").Page) => Promise<void>,
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}${relativeUrl}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator(panelSelector).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="boxtal-sidebar"]')).toBeVisible({ timeout: 20_000 })
    if (interact) await interact(page)
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot(name, { ...SHOT, mask: volatileShellMasks(page) })
  }

  test("to-prepare queue — order prep dashboard (ready + needs-fix rows)", async ({
    page,
    env,
    qa,
  }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/boxtal/queue/to-prepare",
      '[data-testid="boxtal-prep-grid"]',
      "queue-to-prepare.png",
    )
    const q = page.locator('[data-testid="boxtal-prep-grid"]')
    // PrepGrid renders one row per prep_list entry; blocked rows carry data-state="needs_fix"
    // and show their reason as a warning badge.
    await expect(q.locator('[data-testid^="boxtal-prep-row-"][data-state]')).toHaveCount(5)
    await expect(
      q.locator('[data-testid^="boxtal-prep-row-"][data-state="needs_fix"]'),
    ).toHaveCount(2)
    await expect(page.getByTestId("boxtal-prep-reason-tp3")).toHaveText(/Missing weight/i)
    await expect(page.getByTestId("boxtal-prep-reason-tp4")).toHaveText(/Bad address/i)
    await expect(page.getByTestId("boxtal-prep-reason-tp1")).toHaveCount(0)
    // The dashboard's own columns beyond the old bare list — category select + package summary.
    await expect(page.locator('[data-testid="boxtal-prep-category-tp1"]')).toBeVisible()
    // Packages render as a dense one-line summary at rest (the Actions column
    // is sticky at the right edge, and a wide expanded editor left nothing of
    // Packages visible before it); the per-carton dims and the package-count
    // select only cost column width once the row is opened for editing.
    await expect(page.locator('[data-testid="boxtal-prep-package-summary-tp1"]')).toBeVisible()
    await expect(page.locator('[data-testid="boxtal-prep-weight-tp1-0"]')).toHaveCount(0)
    await page.locator('[data-testid="boxtal-prep-package-toggle-tp1"]').click()
    await expect(page.locator('[data-testid="boxtal-prep-weight-tp1-0"]')).toBeVisible()
    const count = page.locator('[data-testid="boxtal-prep-package-count-tp1"]')
    await expect(count).toBeVisible()
    await expect(count.locator("option")).toHaveCount(10)
  })

  test("to-prepare queue — editing a package stages the edit and offers a per-row refresh", async ({
    page,
    env,
    qa,
  }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    // Behavioural, NOT a pixel baseline: the dirty state is covered by these
    // assertions, and the grid's pixel golden stays the single queue-to-prepare
    // shot above (one baseline to re-bake, not two).
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/queue/to-prepare`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="boxtal-prep-grid"]')).toBeVisible({ timeout: 20_000 })
    // Untouched row: no button, because there is nothing to re-quote.
    await expect(page.locator('[data-testid="boxtal-prep-refresh-quote-tp1"]')).toHaveCount(0)
    // The per-carton fields (and the count select / refresh button) live behind
    // the row's collapsed summary; open it before editing.
    await page.locator('[data-testid="boxtal-prep-package-toggle-tp1"]').click()
    // Typing a dimension must NOT fire a quote by itself (the old
    // commit-on-blur behaviour cost one live Boxtal quote per field left).
    await page.locator('[data-testid="boxtal-prep-weight-tp1-0"]').fill("4.2")
    await page.locator('[data-testid="boxtal-prep-length-tp1-0"]').fill("55")
    await page.locator('[data-testid="boxtal-prep-package-count-tp1"]').selectOption("2")
    await page.locator('[data-testid="boxtal-prep-length-tp1-0"]').blur()
    // The staged edit surfaces exactly one affordance on that row, and only there.
    const refresh = page.locator('[data-testid="boxtal-prep-refresh-quote-tp1"]')
    await expect(refresh).toBeVisible()
    await expect(refresh).toHaveText(/Refresh quote/i)
    await expect(page.locator('[data-testid="boxtal-prep-refresh-quote-tp2"]')).toHaveCount(0)
  })

  test("ready-to-ship — operator print station", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/boxtal/queue/ready",
      '[data-testid="boxtal-ready-to-ship"]',
      "queue-ready.png",
    )
    await expect(page.locator('[data-testid="boxtal-print-r1"]')).toBeVisible()
    await expect(page.locator('[data-testid="boxtal-download-label-r1"]')).toBeVisible()
    // One worklist: the state of each parcel is on its row, and the filter sits above.
    await expect(page.getByTestId("boxtal-worklist-filter")).toBeVisible()
    await expect(page.getByTestId("boxtal-ready-state-r1")).toHaveText("Label bought")
    await expect(page.getByTestId("boxtal-ready-state-r2")).toHaveText("Packed, fulfilled")
  })

  test("shipments — master/detail (rows + selected detail)", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/boxtal/shipments",
      '[data-testid="boxtal-shipments-table"]',
      "shipments-detail.png",
      async (p) => {
        const row = p
          .locator('[data-testid="boxtal-shipments-table"] tr', { hasText: /Globex/i })
          .first()
        await expect(row).toBeVisible({ timeout: 20_000 })
        await row.click()
        await expect(p.locator('[data-testid="boxtal-shipment-detail"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    await expect(page.locator('[data-testid="boxtal-shipment-detail"]')).toContainText(/Label/i)
  })

  test("returns — inbound return worklist (agent + user rows)", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(page, env, "/boxtal/returns", '[data-testid="boxtal-returns"]', "returns.png")
    await expect(page.locator('[data-testid="boxtal-returns-table"]')).toContainText(
      /Defective unit/i,
    )
    await expect(page.locator('[data-testid="boxtal-returns"]')).toContainText(/Agent/i)
  })

  test("catalog — profiles + packs + local products", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(page, env, "/boxtal/catalog", '[data-testid="boxtal-catalog"]', "catalog.png")
    const catalog = page.locator('[data-testid="boxtal-catalog"]')
    await expect(catalog.locator('[data-invalid="true"]')).toHaveCount(1)
    await expect(catalog.locator('[data-stale="true"]')).toHaveCount(1)
  })

  test("create draft — quoted (offers + recipient form)", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/boxtal/create/inv-1",
      '[data-testid="boxtal-create-draft"]',
      "create-draft-quoted.png",
      async (p) => {
        await p.getByRole("button", { name: "Open draft" }).click()
        await expect(p.locator('[data-testid="boxtal-recipient-form"]')).toBeVisible({
          timeout: 10_000,
        })
        await p.getByRole("button", { name: "Get quotes" }).click()
        await expect(p.locator('[data-testid="boxtal-create-draft"]')).toContainText(
          /Mondial Relay/i,
        )
      },
    )
  })

  // The app's declarative settings page reads the real server (the kernel's
  // connections block and settings_sender_form_get), so the sender is seeded
  // through the tool, not the host mock.
  test("settings — connected (credentials + sender form)", async ({ page, env, qa }) => {
    const seeded = await api(env.serverUrl, "/api/apps/boxtal/tools/settings_sender_address_set", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { ...SENDER.sender, email: "shipping@fabrikam.test" } },
    })
    expect(seeded.status).toBe(200)
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/apps/boxtal`)
    await page.waitForLoadState("networkidle")
    await expect(page.getByTestId("connections-conn-boxtal")).toContainText("Connected", {
      timeout: 20_000,
    })
    await expect(page.getByTestId("settings-input-name")).toHaveValue(/Fabrikam/)
    await expect(page.getByTestId("settings-section-labels")).toBeVisible()
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("settings-connected.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })
})
