// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — VISUAL baselines for the Invoicing plugin's UI surfaces.
//
// Mirrors the Phase 16 Shopify visual pattern: install the bundle (proves the
// manifest + ui.js are wired), then intercept `window.__liaisonHost.invokeTool`
// per-test with canned per-tool responses so every panel renders with fixed,
// representative data — no live tool round-trips. The interceptor matches mock
// keys dot- OR underscore-insensitively (the app-sdk wrapper passes dotted
// combined names like `invoicing:documents.search`; the host splits on the first
// colon, so the toolName the host sees keeps the dot).
//
// Pixel goldens are darwin-only (`*-darwin.png`): cross-platform font hinting /
// subpixel rendering makes CI pixel diffs unreliable, so `toHaveScreenshot`
// runs only on darwin. The FUNCTIONAL assertions (panel mounts, content testids
// visible) run everywhere. Re-bake after an intentional UI change with
// `bunx --bun playwright test --update-snapshots=all -g "Invoicing — visual"`.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { resolveContact } from "../helpers/contacts-seed"
import { volatileShellMasks } from "../helpers/visual-masks"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

const SHOT = { maxDiffPixelRatio: 0.02 } as const
const PIXEL_BASELINES = process.platform === "darwin"

test.setTimeout(120_000)

// Representative issued/draft rows the dashboards render. Money as strings (the
// wire shape that crosses the bridge); camelCase-free snake_case per DocumentRow.
const ROW = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "11111111-1111-1111-1111-111111111111",
  type: "invoice",
  status: "issued",
  payment_status: "unpaid",
  number: "INV-2026-0001",
  number_int: 1,
  currency: "EUR",
  subtotal_minor: "10000",
  tax_total_minor: "2000",
  grand_total_minor: "12000",
  counterparty_name: "Acme SAS",
  counterparty_contact_id: "c0000000-0000-0000-0000-000000000001",
  destination_country: "FR",
  tax_treatment: "eu_domestic",
  incoterm: "DAP",
  issued_at: "2026-05-01",
  due_at: "2026-05-31",
  is_b2b: true,
  ...over,
})

const DOC_ROWS = [
  // d1 carries the store order reference (the Shopify-channel case): the Order
  // column and the golden must show the human order name, not the numeric id.
  // Leaving every fixture row order-less would pin an always-blank column and
  // the baseline would not notice if the value stopped rendering.
  ROW({
    id: "d1",
    number: "INV-2026-0001",
    grand_total_minor: "12000",
    channel: "shopify",
    shopify_order_id: "12768069779622",
    shopify_order_number: "#1149",
  }),
  ROW({
    id: "d2",
    number: "INV-2026-0002",
    grand_total_minor: "45000",
    counterparty_name: "Globex US",
    destination_country: "US",
    tax_treatment: "eu_export_non_eu",
    payment_status: "unpaid",
    days_overdue: 12,
  }),
  ROW({
    id: "d3",
    number: "INV-2026-0003",
    grand_total_minor: "8000",
    counterparty_name: "Müller GmbH",
    destination_country: "DE",
    tax_treatment: "eu_reverse_charge",
    payment_status: "paid",
    paid_at: "2026-05-10",
  }),
  ROW({
    id: "d4",
    number: "INV-2026-0004",
    grand_total_minor: "30000",
    payment_status: "unpaid",
    days_overdue: 3,
  }),
  ROW({
    id: "d5",
    number: "INV-2026-0005",
    grand_total_minor: "5000",
    counterparty_name: "Globex US",
    destination_country: "US",
    tax_treatment: "eu_export_non_eu",
    hs_codes: ["9207.10"],
  }),
]

// Shopify order this Shopify-sourced document was auto-issued from — a paid
// order that stays `status: "issued"` (boxtal still ships it) but carries
// `payment_status: "paid"` underneath, plus the external_refs the detail
// panel's "Open Shopify order" link is built from.
const SHOPIFY_ORDER_ID = "12768069779622"
const SHOPIFY_SHOP_DOMAIN = "example-store.myshopify.com"

const DOC_DETAIL = {
  document: {
    ...ROW({
      id: "d2",
      number: "INV-2026-0002",
      grand_total_minor: "45000",
      tax_treatment: "eu_export_non_eu",
      payment_status: "paid",
      paid_at: "2026-05-10",
    }),
    pdf_status: "ready",
    pdf_file_id: "f0000000-0000-0000-0000-000000000001",
    lifecycle_log: [
      { event: "issued", at: "2026-05-01T10:00:00Z", actor: { type: "user", id: "u1" } },
    ],
    external_refs: {
      shopify_order_id: SHOPIFY_ORDER_ID,
      shopify_shop_domain: SHOPIFY_SHOP_DOMAIN,
      scope: "goods",
    },
  },
  // Multiple lines with DISTINCT HS codes — an export document classifies each
  // line independently, so the customs view aggregates per (HS × destination),
  // not one code per document.
  lines: [
    {
      id: "l1",
      position: 1,
      description: "Kestrel 2 — Black",
      quantity: "1",
      unit_price_minor: "30000",
      tax_rate_bp: 0,
      subtotal_minor: "30000",
      tax_minor: "0",
      total_minor: "30000",
      hs_code: "9207.10",
      country_of_origin: "CN",
      customs_description: "Electronic pad controller",
    },
    {
      id: "l2",
      position: 2,
      description: "USB-C interface cable",
      quantity: "2",
      unit_price_minor: "4000",
      tax_rate_bp: 0,
      subtotal_minor: "8000",
      tax_minor: "0",
      total_minor: "8000",
      hs_code: "8544.42",
      country_of_origin: "DE",
      customs_description: "Insulated data cable",
    },
    {
      id: "l3",
      position: 3,
      description: "Quick-start guide (printed)",
      quantity: "1",
      unit_price_minor: "7000",
      tax_rate_bp: 0,
      subtotal_minor: "7000",
      tax_minor: "0",
      total_minor: "7000",
      hs_code: "4901.99",
      country_of_origin: "FR",
      customs_description: "Printed instructional matter",
    },
  ],
}

const ISSUER = {
  id: "i0000000-0000-0000-0000-000000000001",
  legal_name: "Fabrikam SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 Rue de Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swift_bic: "AGRIFRPP",
  bank_name: "Crédit Agricole",
  default_currency: "EUR",
  default_language: "fr",
  default_payment_terms_days: 30,
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  invoice_approval_threshold_minor: "5000",
  require_two_eyes: false,
  auto_email_enabled: true,
  reference_count: 12,
}

// Keyed by the host-level `<appName>:<toolName>` (toolName keeps the app-sdk's
// dotted form). The interceptor also matches the underscore-normalized variant.
const MOCKS: Record<string, unknown> = {
  // documents_search resolves to a BARE DocumentHeader[] (see
  // dashboards/loader.ts + ContactDocumentsPanel.tsx) — no `{ items }`
  // envelope, unlike the issuer profile list read below.
  "invoicing:documents.search": DOC_ROWS,
  "invoicing:documents.get": DOC_DETAIL,
  "invoicing:pending_approvals.list": {
    items: [{ id: "a1", tool_name: "invoicing:invoice_create_and_issue" }],
  },
  "invoicing:deferred.list": { items: [] },
  "invoicing:contact_relationships.get": {
    contact_id: "c0000000-0000-0000-0000-000000000001",
    relationship: "customer",
    source: "manual",
  },
  "invoicing:settings.issuer_profile.list": { items: [ISSUER] },
  // DocumentDetail calls `app.invokeTool("kernel:slots.list", …)`; `app` binds
  // the invoicing app name, so the host sees `invoicing:kernel:slots.list`.
  "invoicing:kernel:slots.list": { panels: [] },
}

async function installHostMockInterceptor(page: import("@playwright/test").Page) {
  await page.addInitScript((mocks: Record<string, unknown>) => {
    const norm = (k: string) => k.replace(/\./g, "_")
    const lookup = (key: string): { hit: boolean; value: unknown } => {
      if (Object.hasOwn(mocks, key)) return { hit: true, value: mocks[key] }
      const n = norm(key)
      for (const mk of Object.keys(mocks)) {
        if (norm(mk) === n) return { hit: true, value: mocks[mk] }
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
  }, MOCKS)
}

test.describe("Invoicing: visual baselines", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      issuerOverrides: { invoice_approval_threshold_minor: 5000 },
    })
  })

  test.beforeEach(async ({ page, env, qa }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
  })

  // Direct-route surfaces (kernel routes + the invoicing shell root) render from
  // a cold page.goto.
  async function gotoAndShot(
    page: import("@playwright/test").Page,
    env: { ports: number[] },
    relativeUrl: string,
    panelSelector: string,
    snapshotName: string,
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}${relativeUrl}`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator(panelSelector).first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(300)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot(snapshotName, {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  }

  // App-tab surfaces (dashboards, editor) open through the tab system, which a
  // cold deep-link goto does NOT restore (it lands on the Invoicing Home
  // placeholder). Load the shell, then click the sidebar link — the real flow.
  async function clickNavAndShot(
    page: import("@playwright/test").Page,
    env: { ports: number[] },
    linkHref: string,
    panelSelector: string,
    snapshotName: string,
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await expect(page.locator('[data-testid="invoicing-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await page.locator(`a[href="${linkHref}"]`).first().click()
    const panel = page.locator(panelSelector).first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(300)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot(snapshotName, {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  }

  // Open the Documents view, switch the Group-by segmented control, screenshot.
  async function gotoDocsAndGroup(
    page: import("@playwright/test").Page,
    env: { ports: number[] },
    group: "customer" | "market",
    snapshotName: string,
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await expect(page.locator('[data-testid="invoicing-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await page.locator('a[href="/invoicing/documents/all"]').first().click()
    const panel = page.locator('[data-testid="invoicing-documents-list"]').first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await page.locator(`[data-testid="invoicing-documents-group-${group}"]`).click()
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(300)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot(snapshotName, {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  }

  test("sidebar — documents active", async ({ page, env }) => {
    await gotoAndShot(
      page,
      env,
      "/invoicing",
      '[data-testid="invoicing-sidebar"]',
      "sidebar-documents-active.png",
    )
  })

  test("settings — issuer profile", async ({ page, env }) => {
    await gotoAndShot(
      page,
      env,
      "/settings/apps/invoicing",
      '[data-testid="invoicing-settings"]',
      "settings-issuer-profile.png",
    )
    // FUNCTIONAL layout assertion (the golden is too lenient to notice a
    // scrolled-off column): in the settings page's issuer block the row's Edit action
    // sits inside the table's scroll box, with nothing to scroll sideways.
    const table = page.getByTestId("settings-panel-issuer-profiles").getByTestId("card-table")
    const overflow = await table.evaluate((el) => {
      const scroller = el.firstElementChild as HTMLElement
      return scroller.scrollWidth - scroller.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(0)
  })

  // Document detail — a dynamic `:documentId` route (the matcher fix lets a cold
  // goto resolve it directly; there's no sidebar link to a specific document).
  // DOC_DETAIL (d2) is Shopify-sourced (external_refs + payment_status: "paid"),
  // so this is also the "link present" + "payment chip shows Paid" coverage
  // for the Shopify-order-link and payment-status-badge features.
  test("document detail — issued", async ({ page, env }) => {
    await gotoAndShot(
      page,
      env,
      "/invoicing/document/d2",
      '[data-testid="document-detail-overview"]',
      "document-detail-issued.png",
    )
    const detail = page.locator('[data-testid="document-detail"]').first()
    const shopifyLink = detail.getByTestId("document-detail-open-shopify-order")
    await expect(shopifyLink).toBeVisible()
    await expect(shopifyLink).toHaveAttribute(
      "href",
      `https://${SHOPIFY_SHOP_DOMAIN}/admin/orders/${SHOPIFY_ORDER_ID}`,
    )
    await expect(detail.getByTestId("document-detail-payment-chip")).toBeVisible()
    await expect(detail.getByTestId("document-detail-payment-chip")).toContainText("Paid")
  })

  // A manually-created invoice carries no external_refs — the Shopify order
  // link must NOT render. `__liaisonHost` is defined via a `configurable:
  // true` property trap (installHostMockInterceptor above); redefining it
  // again here with a second addInitScript (registered after beforeEach's)
  // shadows the shared MOCKS for just this test, overriding documents_get
  // with a manual-document response while every other tool call still falls
  // through to the real host — same trap shape, just this test's own mocks.
  test("document detail — manual invoice shows no Shopify order link", async ({ page, env }) => {
    const manualDetail = {
      document: {
        ...ROW({ id: "d5", number: "INV-2026-0005", grand_total_minor: "5000" }),
        pdf_status: "ready",
        pdf_file_id: "f0000000-0000-0000-0000-000000000002",
        lifecycle_log: [],
        // No external_refs at all — the manual-creation shape.
      },
      lines: [],
    }
    await page.addInitScript((detail: unknown) => {
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
            invokeTool: async (
              appName: string,
              toolName: string,
              args: Record<string, unknown>,
            ) => {
              if (`${appName}:${toolName}`.replace(/\./g, "_") === "invoicing:documents_get")
                return detail
              const orig = original.invokeTool as
                | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
                | undefined
              if (orig) return orig.call(original, appName, toolName, args)
              throw new Error(`unmocked tool: ${appName}:${toolName}`)
            },
          }
        },
      })
    }, manualDetail)
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/document/d5`)
    await page.waitForLoadState("networkidle")
    const detail = page.locator('[data-testid="document-detail"]').first()
    await expect(detail).toBeVisible({ timeout: 20_000 })
    await expect(detail.getByTestId("document-detail-open-shopify-order")).toHaveCount(0)
  })

  // Documents — the unified primary view (absorbed All-sales / B2B / By-market).
  // The sidebar All/Invoices/… links drive the type filter; the Group-by control
  // switches between the flat list and the customer / market rollups.
  test("documents — list", async ({ page, env }) => {
    await clickNavAndShot(
      page,
      env,
      "/invoicing/documents/all",
      '[data-testid="invoicing-documents-list"]',
      "documents-list-all.png",
    )
    // FUNCTIONAL assertion, deliberately NOT left to the pixel golden and NOT
    // darwin-gated. The store order reference is the whole point of the Order
    // column, and the golden cannot be trusted to notice it: at
    // maxDiffPixelRatio 0.02 this baseline silently absorbed a new toolbar
    // search box, a footer wording change, AND this entire column before
    // anyone re-baked it. Assert the header and the rendered value directly, so
    // a regression that drops the order reference fails loudly on every platform.
    const list = page.locator('[data-testid="invoicing-documents-list"]').first()
    await expect(list).toContainText("Order")
    await expect(list).toContainText("#1149")
    // The from/to date fields are one pair on one row, never stacked.
    const from = await page.getByTestId("invoicing-dashboard-date-from").first().boundingBox()
    const to = await page.getByTestId("invoicing-dashboard-date-to").first().boundingBox()
    if (!from || !to) throw new Error("date range fields not rendered")
    expect(Math.abs(from.y - to.y)).toBeLessThan(2)
    expect(to.x).toBeGreaterThan(from.x + from.width)
  })

  test("documents — grouped by customer", async ({ page, env }) => {
    await gotoDocsAndGroup(page, env, "customer", "documents-by-customer.png")
  })

  test("documents — grouped by market", async ({ page, env }) => {
    await gotoDocsAndGroup(page, env, "market", "documents-by-market.png")
  })

  // Contact-detail slot surface — the invoicing ContactDocumentsPanel mounts via
  // the kernel's `contact_detail` slot. SlotPanels fetches /api/v1/slots/... from
  // the REAL server (not the host-mock), so the panel only renders because
  // invoicing is installed with the documents:read scope (granted by default).
  // The panel's own data tools (documents_search, contact_relationships_get) are
  // mocked like every other surface. Needs a real kernel contact to navigate to.
  test("contact detail — invoicing documents panel", async ({ page, env, qa }) => {
    const stamp = Date.now()
    const contact = await resolveContact(env, qa.admin.token, {
      email: `invoicing-panel-${stamp}@e2e.test`,
      name: `Panel Co ${stamp}`,
      externalId: { e2e: `invoicing-panel-${stamp}` },
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/contacts/${contact.id}`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="contact-documents-panel"]').first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(300)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("contact-documents-panel.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  // Awaiting payment — the one focused view that survived the unification (a
  // payment worklist). All-sales / B2B / By-market are now Documents groupings;
  // there is no separate customs view (export docs are just invoices with extra
  // fields, shown in the document detail). Reached by clicking the sidebar link.
  test("awaiting payment view — populated", async ({ page, env }) => {
    await clickNavAndShot(
      page,
      env,
      "/invoicing/dashboards/awaiting-payment",
      '[data-testid="invoicing-dashboard-awaiting-payment"]',
      "awaiting-payment-populated.png",
    )
  })

  test("editor — draft", async ({ page, env }) => {
    // Invoices are never started by hand (they come from orders or a converted
    // quote), so the draft editor is reached the way an operator reaches it: the
    // sidebar's New CTA, whose default type is a quote.
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await expect(page.getByTestId("invoicing-sidebar")).toBeVisible({ timeout: 20_000 })
    await page.getByTestId("invoicing-sidebar-new-cta").click()
    const panel = page.getByTestId("invoicing-editor").first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    // The contact is linked by searching its name, never by typing a raw id.
    await expect(panel.getByTestId("editor-field-contact-search")).toBeVisible()
    await expect(panel.getByTestId("editor-field-counterparty-contact-id")).toHaveCount(0)
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(300)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("editor-draft.png", {
        ...SHOT,
        // The issue date defaults to today.
        mask: [...volatileShellMasks(page), page.getByTestId("editor-field-issued-at")],
      })
  })

  // FUNCTIONAL: the editor links a real kernel contact by searching its name;
  // the linked contact reads as its name and fills the empty customer fields.
  test("editor — link a contact by name", async ({ page, env, qa }) => {
    const stamp = Date.now()
    const contact = await resolveContact(env, qa.admin.token, {
      email: `picker-${stamp}@e2e.test`,
      name: `Picker Person ${stamp}`,
      externalId: { e2e: `invoicing-picker-${stamp}` },
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await expect(page.getByTestId("invoicing-sidebar")).toBeVisible({ timeout: 20_000 })
    await page.getByTestId("invoicing-sidebar-new-cta").click()
    const panel = page.getByTestId("invoicing-editor").first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await panel.getByTestId("editor-field-contact-search").fill(`Picker Person ${stamp}`)
    const result = panel.getByTestId("editor-contact-result").first()
    await expect(result).toContainText(`Picker Person ${stamp}`, { timeout: 15_000 })
    await result.click()
    const linked = panel.getByTestId("editor-field-contact-linked")
    await expect(linked).toContainText(`Picker Person ${stamp}`)
    await expect(linked).not.toContainText(contact.id)
    await expect(panel.getByTestId("editor-field-customer-email")).toHaveValue(
      `picker-${stamp}@e2e.test`,
    )
    await panel.getByTestId("editor-field-contact-clear").click()
    await expect(panel.getByTestId("editor-field-contact-search")).toBeVisible()
  })
})
