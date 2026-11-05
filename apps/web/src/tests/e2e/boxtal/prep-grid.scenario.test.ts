// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e -- the REWORKED To prepare grid, on the real rendered screen.
//
// Everything else in this folder drives tools. This drives the SCREEN: a real browser, a real
// install of shopify + invoicing + boxtal, real open orders in the offline Shopify mock, and the
// real prep_list read behind the grid. It exists because the defects the rework fixes are all
// screen-level facts that no tool test can see:
//
//   * an order with no invoice is a ROW (it used to be structurally absent from the worklist)
//   * a refunded order is NOT a row
//   * the whole row is tinted by its status, and On hold disables Ship with the hold as the reason
//   * a row action re-renders ONE ROW: every other row's DOM node survives it, which is what the
//     "ticking the checkbox reloads the page" complaint was actually about
//   * the header count equals the visible rows
//
// Screenshots of each state are written to apps/web/test-results/boxtal-prep-local/ for a visual
// review pass, and attached to the Playwright report.

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import { installShopifyApp } from "../shopify/helpers/install-shopify-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  LIAISON_ROOT,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock } from "./helpers/mock-boxtal"
import {
  numericOrderId,
  SENDER,
  seedIssuedInvoiceForOrder,
  seedOpenOrders,
  toolPost,
} from "./helpers/seed-shipment"

test.setTimeout(180_000)

const SHOT_DIR = join(LIAISON_ROOT, "apps/web/test-results/boxtal-prep-local")

/** Save a full-page capture for the visual review pass AND attach it to the report. */
async function capture(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  await testInfo.attach(name, { path: file, contentType: "image/png" })
}

/** The prep grid's layout, as the browser actually resolved it. One probe, both geometries. */
async function measurePrepGeometry(
  page: import("@playwright/test").Page,
  docKey: string,
  apprKey: string,
) {
  return page.evaluate(
    ({ docKey, apprKey }: { docKey: string; apprKey: string }) => {
      const scroller = document.querySelector(
        '[data-testid="boxtal-prep-grid-scroller"]',
      ) as HTMLElement
      const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
      const box = (el: Element | null) => {
        const r = rect(el)
        return r ? { left: r.left, right: r.right, width: r.width } : null
      }
      const docRow = document.querySelector(`[data-testid="boxtal-prep-row-${docKey}"]`)
      const apprRow = document.querySelector(`[data-testid="boxtal-prep-row-${apprKey}"]`)
      const tds = docRow ? [...docRow.querySelectorAll("td")] : []
      const actions = tds[tds.length - 1] ?? null
      const doc = tds[tds.length - 2] ?? null
      const pill =
        docRow?.querySelector(`[data-testid="boxtal-prep-invoice-${docKey}-pill"]`) ?? null
      const link = (apprRow?.querySelector(
        `[data-testid="boxtal-prep-invoice-approvals-${apprKey}"]`,
      ) ?? null) as HTMLElement | null
      const actionsStyle = actions ? getComputedStyle(actions) : null
      const view = scroller.getBoundingClientRect()
      // Every OTHER cell of the row: whatever the Actions cell paints over, it
      // paints over one of these.
      const others = tds.slice(0, -1).map((td, i) => ({ i, ...box(td)! }))
      // Every carrier mark the grid actually rendered.
      const marks = [
        ...document.querySelectorAll('[data-testid^="boxtal-prep-estimate-"] svg[role="img"]'),
      ].map((svg) => ({
        name: svg.getAttribute("aria-label"),
        title: svg.querySelector("title")?.textContent ?? null,
        width: svg.getBoundingClientRect().width,
      }))
      return {
        container: {
          left: view.left,
          right: view.right,
          clientWidth: scroller.clientWidth,
          scrollWidth: scroller.scrollWidth,
          scrollLeft: scroller.scrollLeft,
          // A horizontal scrollbar takes height off the content box; 0 means the
          // platform draws an overlay scrollbar instead.
          scrollbarPx: scroller.offsetHeight - scroller.clientHeight,
          overflows: scroller.scrollWidth > scroller.clientWidth,
          stickyAttr: scroller.getAttribute("data-sticky-actions"),
        },
        actions: {
          ...(box(actions) ?? { left: 0, right: 0, width: 0 }),
          position: actionsStyle?.position ?? null,
          background: actionsStyle?.backgroundColor ?? null,
        },
        doc: box(doc),
        pill: pill
          ? {
              ...box(pill)!,
              text: (pill.textContent ?? "").trim(),
              scrollWidth: (pill as HTMLElement).scrollWidth,
              clientWidth: (pill as HTMLElement).clientWidth,
            }
          : null,
        approvals: link
          ? {
              ...box(link)!,
              text: (link.textContent ?? "").trim(),
              scrollWidth: link.scrollWidth,
              clientWidth: link.clientWidth,
            }
          : null,
        others,
        marks,
      }
    },
    { docKey, apprKey },
  )
}

/**
 * The property that has to hold at EVERY container width: no in-flow cell of
 * the row is painted over by the Actions cell. It holds two different ways --
 * pinned, when the table fits its container and the row's own geometry clears
 * the pin; UN-PINNED, when it does not, because then Actions is a normal last
 * column and the table scrolls. What is never acceptable is an opaque cell
 * pinned over a column that has nowhere else to go (measured 2026-09-08 at
 * 1440x900 with the agent panel open: 108.0px of the Document column, the
 * invoice number and the Approvals link behind it, under the pin at rest).
 */
function assertActionsCoversNothing(
  g: Awaited<ReturnType<typeof measurePrepGeometry>>,
  label: string,
): void {
  if (g.container.overflows) {
    // Too narrow for the whole table: the pin comes OFF, ground and edge with it.
    expect(g.container.stickyAttr, `${label}: sticky attr`).toBe("false")
    expect(g.actions.position, `${label}: actions position`).not.toBe("sticky")
    // Nothing is painted over: the cell has no opaque ground of its own.
    expect(g.actions.background, `${label}: actions background`).toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    )
    // ...and it scrolls, which is how every action stays reachable.
    expect(g.container.scrollWidth, `${label}: scrollable`).toBeGreaterThan(g.container.clientWidth)
  } else {
    // The table fits: the pin stays exactly as it was, marking the edge.
    expect(g.container.stickyAttr, `${label}: sticky attr`).toBe("true")
    expect(g.actions.position, `${label}: actions position`).toBe("sticky")
  }
  // Either way: the Actions cell starts at or after the right edge of every
  // other cell in the row. That is the covering test, stated once.
  for (const o of g.others) {
    expect(o.right, `${label}: cell ${o.i} runs under the Actions cell`).toBeLessThanOrEqual(
      g.actions.left + 0.5,
    )
  }
}

const PROFILE = {
  product_source: "shopify",
  product_id: "VARIANT-STAB",
  unit_weight: 0.8,
  solo_length: 30,
  solo_width: 20,
  solo_height: 12,
  content_category: "content:v1:10120",
}

const FR_ADDRESS = {
  name: "Amina Example",
  address1: "5 rue du Test",
  city: "Lyon",
  zip: "69001",
  country: "France",
  countryCode: "FR",
  phone: "+33612345678",
}

const INVOICE_ITEMS = [
  {
    position: 1,
    description: "Tessera 2 controller",
    quantity: "1",
    unit_price_minor: "69900",
    product_source: "shopify",
    external_id: "VARIANT-STAB",
  },
]

interface PrepSeed {
  orderA: string
  orderB: string
  orderD: string
  invoiceA: string
  invoiceD: string
}

/** Install the three apps, put four open orders in the store, invoice two of them. */
async function seedPrepWorld(serverUrl: string, token: string, orgId: string): Promise<PrepSeed> {
  await resetMock(serverUrl, token)
  const invoicing = await installInvoicingApp({
    serverUrl,
    token,
    orgId,
    bundlePath: INVOICING_BUNDLE,
    issuerCountry: "FR",
    additionalContacts: [
      {
        country: "FR",
        name: "Amina Example",
        email: "amina-prep@e2e.test",
        customerKind: "individual",
      },
    ],
  })
  await installShopifyApp({ serverUrl, token, orgId })
  await installBoxtalApp({
    serverUrl,
    token,
    orgId,
    bundlePath: BOXTAL_BUNDLE,
    seedSenderAddress: SENDER,
    seedShippingProfiles: [PROFILE],
  })
  // The packaging policy is ORG DATA and neutral by default, so a fresh org has no nominal
  // declared value and no proforma can be issued for a repair or a sample. An order-less shipment
  // ships on exactly that proforma, so the world has to be an org that configured one, the way a
  // real shipping org is.
  await toolPost(serverUrl, token, "boxtal", "settings_packaging_policy_set", {
    nominal_proforma_value_minor: 5000,
  })
  await toolPost(serverUrl, token, "invoicing", "hs_codes_assign", {
    product_source: "shopify",
    external_id: "VARIANT-STAB",
    hs_code: "92071000",
    country_of_origin: "FR",
    customs_description: "Electronic musical instrument controller",
  })

  const lineItems = [
    { title: "Tessera 2 controller", sku: "VARIANT-STAB", quantity: 1, unitAmount: "699.00" },
  ]
  // The DEALER order, copied line for line off the prod row of 2026-09-08. Its skus are the
  // wholesale variants (`EMB-` house prefix, `-B2B` channel suffix), which carry no shipping
  // profile and therefore no short_code, and Shopify lists the SAME unit on two separate line
  // items. Verbatim, that summary printed nine wrapped lines in the products cell and made the
  // row three times the height of its neighbours; the tags made the client cell a third line on
  // top of it. It is in the fixture so the capture shows the condition the grid has to survive,
  // not just the two-character retail case.
  const b2bLineItems = [
    { title: "Tessera 2 black", sku: "EMB-ET2-BLACK-B2B", quantity: 2, unitAmount: "559.00" },
    { title: "Fabric skin", sku: "EMB-ET2-FABRICSKIN-B2B", quantity: 1, unitAmount: "39.00" },
    { title: "Hard cover", sku: "EMB-ET2-HARDCOVER-B2B", quantity: 1, unitAmount: "59.00" },
    { title: "Metal plate", sku: "EMB-ET2-PLATE-B2B", quantity: 1, unitAmount: "49.00" },
    { title: "USB-C power supply", sku: "PSUSBCACMEII-B2B", quantity: 2, unitAmount: "19.00" },
    { title: "Drum skin", sku: "EMB-ET2-DRUMSKIN-B2B", quantity: 1, unitAmount: "39.00" },
    { title: "USB-C cable 2m", sku: "USBC2M-B2B", quantity: 2, unitAmount: "12.00" },
    { title: "Tessera 2 black", sku: "EMB-ET2-BLACK-B2B", quantity: 1, unitAmount: "559.00" },
  ]
  const [gidA, gidB, gidC, gidD] = await seedOpenOrders(serverUrl, token, [
    { name: "#8001", email: "amina-prep@e2e.test", shippingAddress: FR_ADDRESS, lineItems },
    {
      name: "#8002",
      email: "lucas-prep@e2e.test",
      customerName: "Klangwerk GmbH Musikhaus",
      tags: ["B2B", "DepotFR"],
      shippingAddress: FR_ADDRESS,
      lineItems: b2bLineItems,
    },
    // Refunded: shipping work that is NOT work. It must never reach the grid.
    {
      name: "#8003",
      email: "carol-prep@e2e.test",
      financialStatus: "REFUNDED",
      shippingAddress: FR_ADDRESS,
      lineItems,
    },
    { name: "#8004", email: "dave-prep@e2e.test", shippingAddress: FR_ADDRESS, lineItems },
  ])
  void gidC

  const contactId = invoicing.additionalContactIds[0] as string
  const issuer = invoicing.primaryIssuerProfileId as string
  const invoiceA = await seedIssuedInvoiceForOrder(serverUrl, token, {
    issuerProfileId: issuer,
    contactId,
    shopifyOrderId: numericOrderId(gidA!),
    counterpartyName: "Amina Example",
    counterpartyCountry: "FR",
    items: INVOICE_ITEMS,
  })
  const invoiceD = await seedIssuedInvoiceForOrder(serverUrl, token, {
    issuerProfileId: issuer,
    contactId,
    shopifyOrderId: numericOrderId(gidD!),
    counterpartyName: "Amina Example",
    counterpartyCountry: "FR",
    items: INVOICE_ITEMS,
  })
  return {
    orderA: `so:${numericOrderId(gidA!)}`,
    orderB: `so:${numericOrderId(gidB!)}`,
    orderD: `so:${numericOrderId(gidD!)}`,
    invoiceA,
    invoiceD,
  }
}

test.describe("Boxtal: the To prepare grid (rendered screen)", () => {
  // This checkout's `.env.test` sets SHOPIFY_E2E_LIVE=1 so the shopify and invoicing scenarios reach the real
  // dev store. The prep worklist IS the set of open Shopify orders, so it has to read the OFFLINE
  // mock instead (a live store has no deterministic open orders, and `mock-shop.myshopify.com`
  // resolves to Shopify's edge and answers 404 to every call). Unset it for this file and put it
  // back afterwards, so a worker that later runs a live scenario is unaffected.
  const LIVE_BEFORE = process.env.SHOPIFY_E2E_LIVE ?? "1"
  let offlineArmed = false
  /** Point the spawned API at the OFFLINE Shopify mock, once per worker. */
  async function useOfflineShopify(env: {
    restart: (o: Record<string, unknown>) => Promise<void>
  }) {
    if (offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: "0" }, timeoutMs: 180_000 })
    offlineArmed = true
  }
  test.afterAll(async ({ env }) => {
    if (!offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: LIVE_BEFORE }, timeoutMs: 180_000 })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 950 })
    await forceDarkMode(page)
  })

  test("the worklist is the open orders, one row re-renders alone, and hold blocks the buy", async ({
    page,
    env,
    world,
    qa,
  }, testInfo) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const s = env.serverUrl
    const token = qa.admin.token
    await useOfflineShopify(env as never)
    const seed = await seedPrepWorld(s, token, world.org.id)

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/queue/to_prepare`)
    await expect(page.locator('[data-testid="boxtal-prep-grid"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="boxtal-prep-grid-table"]')).toBeVisible({
      timeout: 30_000,
    })

    const rowA = page.locator(`[data-testid="boxtal-prep-row-${seed.orderA}"]`)
    const rowB = page.locator(`[data-testid="boxtal-prep-row-${seed.orderB}"]`)
    const rowD = page.locator(`[data-testid="boxtal-prep-row-${seed.orderD}"]`)

    // 1. Every open order is a row: the invoiced ones AND the un-invoiced one. The refunded order
    //    is not, and the header count equals what is on screen.
    await expect(rowA).toBeVisible()
    await expect(rowB).toBeVisible()
    await expect(rowD).toBeVisible()
    const visibleRows = await page.locator('[data-testid^="boxtal-prep-row-"][data-state]').count()
    expect(visibleRows).toBe(3)
    const headerCount = await page
      .locator('[data-testid="boxtal-prep-grid-header"] span.font-mono')
      .first()
      .innerText()
    expect(headerCount.trim()).toBe(String(visibleRows))
    await capture(page, testInfo, "01-worklist")

    // 2. The un-invoiced order says what it is missing rather than looking ready.
    const invoiceB = page.locator(`[data-testid="boxtal-prep-invoice-${seed.orderB}"]`)
    await expect(invoiceB).toHaveAttribute("data-state", "missing")
    // The PILL is short (it renders inside the sticky Actions band's shadow, and the long form
    // was what got sliced to "No inv yet" in prod), and the FULL wording is on the title, so
    // nothing was dropped -- only moved to hover.
    await expect(
      invoiceB.locator(`[data-testid="boxtal-prep-invoice-${seed.orderB}-pill"]`),
    ).toHaveText("No invoice")
    expect(await invoiceB.locator("span[title]").first().getAttribute("title")).toContain(
      "No invoice yet",
    )
    const shipB = page.locator(`[data-testid="boxtal-prep-ship-${seed.orderB}"]`)
    await expect(shipB).toBeDisabled()
    expect(await shipB.getAttribute("title")).toContain("No invoice issued for this order yet")

    // 3. Pull orders resolves the anchored rows: A gets packages and a price.
    await page.locator('[data-testid="boxtal-prep-pull-orders"]').click()
    await expect(rowA).toHaveAttribute("data-state", "ready", { timeout: 60_000 })
    await capture(page, testInfo, "02-synced")

    // 3b. The carton summary is READABLE, not just present. It used to live in a ninth
    //     column that rendered under the opaque sticky Actions cell or past the right edge
    //     of the scroll container (measured 1440x900, agent panel open: container 812px wide,
    //     1128px of content, the Packages cell at x 1096.6-1197.6). It is now the third line
    //     of the total cell, so assert the geometry that made it invisible: fully inside the
    //     scroll container, and entirely LEFT of the sticky Actions cell.
    const summaryGeom = await page.evaluate((key: string) => {
      const el = document.querySelector(`[data-testid="boxtal-prep-package-summary-${key}"]`)
      const row = document.querySelector(`[data-testid="boxtal-prep-row-${key}"]`)
      if (!el || !row) return null
      const tds = [...row.querySelectorAll("td")]
      const scroller = (
        document.querySelector('[data-testid="boxtal-prep-grid-table"]') as HTMLElement
      ).parentElement as HTMLElement
      const b = el.getBoundingClientRect()
      const actions = tds[tds.length - 1]!.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      return {
        left: b.left,
        right: b.right,
        actionsLeft: actions.left,
        viewLeft: view.left,
        viewRight: view.right,
      }
    }, seed.orderA)
    expect(summaryGeom, "the synced row must show a package summary line").not.toBeNull()
    const g = summaryGeom!
    expect(g.left).toBeGreaterThanOrEqual(g.viewLeft)
    expect(g.right).toBeLessThanOrEqual(g.viewRight)
    expect(g.right).toBeLessThanOrEqual(g.actionsLeft)

    // 3c. Same oracle for the DOCUMENT cell, which is the column the sticky Actions cell
    //     actually sliced in prod on 2026-09-04: what an operator read was the fragment
    //     "Iss 20:" where "Issued INV-2026-3493" should have been, and "No inv yet" for
    //     "No invoice yet". The invoice NUMBER is the thing that gets cross-checked against
    //     the parcel, so its cell has to end at or before the opaque sticky edge, and the
    //     pill has to be strictly clear of it. Fixed by shortening the pill's label (the
    //     state word moved to the title) and by narrowing the Actions cell (Label is
    //     icon-only) and the Category column, not by widening the viewport.
    const docGeom = await page.evaluate((key: string) => {
      const row = document.querySelector(`[data-testid="boxtal-prep-row-${key}"]`)
      if (!row) return null
      const tds = [...row.querySelectorAll("td")]
      const doc = tds[tds.length - 2]
      const actions = tds[tds.length - 1]
      const pill = row.querySelector(`[data-testid="boxtal-prep-invoice-${key}-pill"]`)
      if (!doc || !actions || !pill) return null
      const scroller = (
        document.querySelector('[data-testid="boxtal-prep-grid-table"]') as HTMLElement
      ).parentElement as HTMLElement
      const view = scroller.getBoundingClientRect()
      return {
        docRight: doc.getBoundingClientRect().right,
        pillLeft: pill.getBoundingClientRect().left,
        pillRight: pill.getBoundingClientRect().right,
        pillText: (pill.textContent ?? "").trim(),
        actionsLeft: actions.getBoundingClientRect().left,
        viewLeft: view.left,
        viewRight: view.right,
      }
    }, seed.orderA)
    expect(docGeom, "the synced row must render a document pill").not.toBeNull()
    const d = docGeom!
    // The pill reads the whole document number, on one line, inside the viewport.
    expect(d.pillText).toMatch(/^[A-Z]+-\d{4}-\d+$/)
    expect(d.pillLeft).toBeGreaterThanOrEqual(d.viewLeft)
    expect(d.pillRight).toBeLessThanOrEqual(d.viewRight)
    // And it is not under the opaque sticky Actions cell: the whole cell clears it.
    expect(d.pillRight).toBeLessThan(d.actionsLeft)
    expect(d.docRight).toBeLessThanOrEqual(d.actionsLeft)

    // 3d. The document cell's SECOND control is the one that got sliced next: on a document-less
    //     row the pill is followed by an `Approvals` link, and at 1440x900 with the agent panel
    //     open it read `Ap`. A link whose text is cut is not a link an operator can trust, so
    //     assert the full word, un-truncated (scrollWidth <= clientWidth), inside the viewport and
    //     clear of the opaque sticky Actions cell.
    const apprGeom = await page.evaluate((key: string) => {
      const row = document.querySelector(`[data-testid="boxtal-prep-row-${key}"]`)
      if (!row) return null
      const tds = [...row.querySelectorAll("td")]
      const link = row.querySelector(
        `[data-testid="boxtal-prep-invoice-approvals-${key}"]`,
      ) as HTMLElement | null
      if (!link) return null
      const scroller = (
        document.querySelector('[data-testid="boxtal-prep-grid-table"]') as HTMLElement
      ).parentElement as HTMLElement
      const view = scroller.getBoundingClientRect()
      const b = link.getBoundingClientRect()
      return {
        text: (link.textContent ?? "").trim(),
        scrollWidth: link.scrollWidth,
        clientWidth: link.clientWidth,
        left: b.left,
        right: b.right,
        actionsLeft: tds[tds.length - 1]!.getBoundingClientRect().left,
        viewLeft: view.left,
        viewRight: view.right,
      }
    }, seed.orderB)
    expect(apprGeom, "the document-less row must offer an Approvals link").not.toBeNull()
    const a = apprGeom!
    expect(a.text).toBe("Approvals")
    expect(a.scrollWidth).toBeLessThanOrEqual(a.clientWidth)
    expect(a.left).toBeGreaterThanOrEqual(a.viewLeft)
    expect(a.right).toBeLessThanOrEqual(a.viewRight)
    expect(a.right).toBeLessThanOrEqual(a.actionsLeft)

    // 3e. The carrier control in the total cell is COLLAPSED to the carrier's logo, and that logo
    //     IS the offer picker (a transparent native <select> at the same size). The width saving is
    //     only legitimate if the control stays announceable and operable: the select keeps an
    //     aria-label naming the offer, the mark carries the carrier's name on title + aria-label,
    //     the carrier name is no longer spelled out in the cell, and the control is focusable.
    const carrierCtl = await page.evaluate((key: string) => {
      const cell = document.querySelector(`[data-testid="boxtal-prep-estimate-${key}"]`)
      if (!cell) return null
      const sel = cell.querySelector("select") as HTMLSelectElement | null
      const svg = cell.querySelector("svg[role='img']")
      if (!sel || !svg) return null
      sel.focus()
      return {
        selAria: sel.getAttribute("aria-label"),
        selTitle: sel.getAttribute("title"),
        optionCount: sel.options.length,
        focused: document.activeElement === sel,
        tabbable: sel.tabIndex >= 0,
        svgAria: svg.getAttribute("aria-label"),
        svgTitle: svg.querySelector("title")?.textContent ?? null,
        // What the cell RENDERS. The svg's <title> and the select's <option>s are text
        // content but paint nothing, so strip both before asking whether the carrier is
        // still spelled out on the row.
        cellText: (() => {
          const c = cell.cloneNode(true) as HTMLElement
          for (const g of [...c.querySelectorAll("svg, select")]) g.remove()
          return (c.textContent ?? "").trim()
        })(),
      }
    }, seed.orderA)
    expect(carrierCtl, "the synced row must render a collapsed carrier control").not.toBeNull()
    const cc = carrierCtl!
    expect(cc.optionCount).toBeGreaterThan(0)
    expect(cc.focused).toBe(true)
    expect(cc.tabbable).toBe(true)
    expect(cc.selAria ?? "").toContain("Choose which offer to ship this order with")
    expect(cc.selTitle).toBe("Choose which offer to ship this order with")
    // The mark is NAMED: an icon with no accessible name is a finding, not a fix.
    expect((cc.svgAria ?? "").length).toBeGreaterThan(0)
    expect(cc.svgTitle).toBe(cc.svgAria)
    // And the carrier is no longer spelled out in the cell's text: that is where the width went.
    expect(cc.cellText).not.toContain(cc.svgAria!)

    // 3e-bis. THE MARK IS A WORDMARK, AND IT FITS. The first collapse pass drew
    //     2-3 letter abbreviations (`CHR` for Chronopost) on a coloured badge, which is
    //     not a logo and is less recognisable than the carrier's name; the mark now draws
    //     the brand's NAME in the brand's colours. That is only a legitimate trade if the
    //     mark still costs the Total column what it was promised, so measure it: the mark
    //     the grid rendered, and then every OTHER brand's mark drawn through the SAME
    //     rendered element (same font, same context), which is what makes the declared
    //     width a measured fact rather than an assumption about font metrics.
    const marks = (await import(
      pathToFileURL(join(LIAISON_ROOT, "bundled-apps/boxtal/src/ui/carrier-mark.ts")).href
    )) as {
      CARRIER_MARKS: readonly {
        brand: string
        name: string
        text: string
        text2?: string
        width: number
      }[]
      MARK_MAX_WIDTH: number
    }
    const measuredMarks = await page.evaluate(
      ({
        specs,
        height,
      }: {
        specs: { brand: string; text: string; width: number }[]
        height: number
      }) => {
        const live = document.querySelector(
          '[data-testid^="boxtal-prep-estimate-"] svg[role="img"]',
        ) as SVGSVGElement | null
        if (!live) return null
        const host = live.parentElement as HTMLElement
        const out: { brand: string; width: number; textWidth: number }[] = []
        const clones: SVGSVGElement[] = []
        for (const spec of specs) {
          const c = live.cloneNode(true) as SVGSVGElement
          c.setAttribute("width", String(spec.width))
          c.setAttribute("viewBox", `0 0 ${spec.width} ${height}`)
          const rect = c.querySelector("rect")!
          rect.setAttribute("width", String(spec.width - 0.5))
          const text = c.querySelector("text") as SVGTextElement
          text.setAttribute("x", String(spec.width / 2))
          text.setAttribute("textLength", String(spec.width - 6))
          text.textContent = spec.text
          host.appendChild(c)
          clones.push(c)
        }
        // One layout pass, then read every clone.
        for (let i = 0; i < clones.length; i++) {
          const c = clones[i]!
          const text = c.querySelector("text") as SVGTextElement
          out.push({
            brand: specs[i]!.brand,
            width: c.getBoundingClientRect().width,
            textWidth: text.getComputedTextLength(),
          })
        }
        for (const c of clones) c.remove()
        return out
      },
      {
        specs: marks.CARRIER_MARKS.map((m) => ({
          brand: m.brand,
          text: `${m.text}${m.text2 ?? ""}`,
          width: m.width,
        })),
        height: 14,
      },
    )
    expect(
      measuredMarks,
      "the grid must render at least one carrier mark to measure",
    ).not.toBeNull()
    for (const m of measuredMarks!) {
      expect(m.width, `${m.brand} mark rendered width`).toBeLessThanOrEqual(marks.MARK_MAX_WIDTH)
      // The condensing actually happened: the letters fit the badge they were
      // given, so no wordmark spills past the width the column paid for.
      expect(m.textWidth, `${m.brand} wordmark advance`).toBeLessThanOrEqual(m.width)
    }

    // 3f. THE STICKY ACTIONS RULE, AT BOTH GEOMETRIES, keyed on the SCROLL CONTAINER.
    //     The grid's overlap was never a column-width problem after the mark pass: at
    //     1440x900 with the agent panel open the seven remaining columns are already at
    //     their content minimums and the table is simply wider than the 812px container,
    //     so an opaque cell pinned to the right edge has to be painted over something.
    //     Below the width where the table fits, the pin comes OFF and the table scrolls
    //     (Actions stays REACHABLE, which is the charter's rule, rather than always
    //     pinned). The trigger is the CONTAINER's own `scrollWidth > clientWidth`, not the
    //     window's width, because the agent panel changes one without changing the other.
    //     Both geometries are asserted here, in one test, so neither can regress alone.
    const wide = await measurePrepGeometry(page, seed.orderA, seed.orderB)
    // 1600x950 with the panel open: the table fits, so the pin stays exactly as it was.
    expect(wide.container.overflows, "1600x950: the table fits its container").toBe(false)
    assertActionsCoversNothing(wide, "1600x950")
    // Nothing scrolls here, so there is nothing to say about scrolling.
    await expect(page.locator('[data-testid="boxtal-prep-grid-scroll-hint"]')).toHaveCount(0)

    // Now the narrow geometry: the 812px grid container that once measured 108.0px of the
    // Document column under the pin. The agent column that used to take that width at
    // 1440x900 is gone (chat lives in the dock), so the same container is reached by the
    // viewport alone: 1120px minus the activity bar and the app sidebar.
    await page.setViewportSize({ width: 1120, height: 900 })
    // The ResizeObserver flips the attribute; wait for its decision rather than a timer.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document
                .querySelector('[data-testid="boxtal-prep-grid-scroller"]')
                ?.getAttribute("data-sticky-actions") ?? null,
          ),
        { timeout: 10_000 },
      )
      .toBe("false")
    const narrow = await measurePrepGeometry(page, seed.orderA, seed.orderB)
    expect(narrow.container.overflows, "1120x900: the table does not fit").toBe(true)
    assertActionsCoversNothing(narrow, "1120x900")
    // The actions are now reached by scrolling, and this platform draws an OVERLAY
    // scrollbar (0px of the container's height), so the affordance has to be said.
    expect(narrow.container.scrollbarPx).toBe(0)
    await expect(page.locator('[data-testid="boxtal-prep-grid-scroll-hint"]')).toBeVisible()
    // The Document pill and the Approvals link are RENDERED WHOLE (neither is clipped by
    // its own box) -- that is what "Iss 20:" and "Ap" were.
    expect(narrow.pill!.text).toMatch(/^[A-Z]+-\d{4}-\d+$/)
    expect(narrow.pill!.scrollWidth).toBeLessThanOrEqual(narrow.pill!.clientWidth)
    expect(narrow.approvals!.text).toBe("Approvals")
    expect(narrow.approvals!.scrollWidth).toBeLessThanOrEqual(narrow.approvals!.clientWidth)
    // ...and REACHABLE: scrolling the grid to its right end brings both fully inside the
    // container, with nothing pinned over them.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="boxtal-prep-grid-scroller"]') as HTMLElement
      el.scrollLeft = el.scrollWidth
    })
    const scrolled = await measurePrepGeometry(page, seed.orderA, seed.orderB)
    expect(scrolled.container.scrollLeft).toBeGreaterThan(0)
    for (const [name, b] of [
      ["document pill", scrolled.pill!],
      ["Approvals link", scrolled.approvals!],
    ] as const) {
      expect(b.left, `${name} left edge inside the container`).toBeGreaterThanOrEqual(
        scrolled.container.left - 0.5,
      )
      expect(b.right, `${name} right edge inside the container`).toBeLessThanOrEqual(
        scrolled.container.right + 0.5,
      )
    }
    assertActionsCoversNothing(scrolled, "1120x900 scrolled right")

    // Back to the geometry the rest of this test (and its captures) is written at.
    await page.setViewportSize({ width: 1600, height: 950 })
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document
                .querySelector('[data-testid="boxtal-prep-grid-scroller"]')
                ?.getAttribute("data-sticky-actions") ?? null,
          ),
        { timeout: 10_000 },
      )
      .toBe("true")
    await expect(page.locator('[data-testid="boxtal-prep-grid-scroll-hint"]')).toHaveCount(0)

    // 4. ONE-ROW RE-RENDER. Stamp every row's DOM node, change ONE row's status, and assert every
    //    OTHER node survived. A whole-list refetch replaces them all and the stamps are gone: that
    //    is precisely the "ticking the checkbox reloads the page" defect.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-testid^="boxtal-prep-row-"][data-state]')) {
        ;(el as HTMLElement & { __probe?: number }).__probe = 1
      }
    })
    await page.locator(`[data-testid="boxtal-prep-status-${seed.orderD}"]`).selectOption("on_hold")
    await expect(rowD).toHaveAttribute("data-status", "on_hold", { timeout: 30_000 })
    const probes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="boxtal-prep-row-"][data-state]')].map((el) => ({
        key: el.getAttribute("data-testid"),
        kept: (el as HTMLElement & { __probe?: number }).__probe === 1,
      })),
    )
    expect(probes.length).toBe(3)
    // The CHANGED row is a new row object (that is what a patch is), so <For> rebuilds its node and
    // its own stamp is gone. Every OTHER row must survive untouched: that is the property, and a
    // whole-list refetch fails it because it replaces all three.
    const untouched = probes.filter((p) => p.key !== `boxtal-prep-row-${seed.orderD}`)
    expect(untouched.length).toBe(2)
    for (const p of untouched) {
      expect(p.kept, `${p.key} was re-created by an action on another row`).toBe(true)
    }

    // 5. On hold paints the WHOLE row red (a coloured left rule over a tinted ground, read from
    //    the computed style, not the class list), and Ship says the hold is the reason.
    const rowPaint = () =>
      rowD.evaluate((el) => {
        const cs = getComputedStyle(el)
        return {
          rule: cs.borderLeftColor,
          ruleWidth: cs.borderLeftWidth,
          ground: cs.backgroundColor,
        }
      })
    const heldPaint = await rowPaint()
    expect(heldPaint.ruleWidth).toBe("2px")
    expect(heldPaint.rule).not.toBe("rgba(0, 0, 0, 0)")
    expect(heldPaint.ground).not.toBe("rgba(0, 0, 0, 0)")
    const shipD = page.locator(`[data-testid="boxtal-prep-ship-${seed.orderD}"]`)
    await expect(shipD).toBeDisabled()
    expect(await shipD.getAttribute("title")).toContain("on hold")
    // `data-status` flips optimistically (PrepGrid's setStatus patches the row locally before the
    // round trip even starts), so the assertion above can resolve while the row is still `busy`
    // from the in-flight confirmation read -- the button briefly reads "Working" rather than "Ship".
    // Wait for that to settle before the capture, so the screenshot documents the state an operator
    // actually looks at, not a one-frame transient.
    await expect(shipD).toHaveText("Ship", { timeout: 10_000 })
    await capture(page, testInfo, "03-on-hold")

    // 6. Clearing the hold gives the row its Ship button back, from the same row read.
    await page
      .locator(`[data-testid="boxtal-prep-status-${seed.orderD}"]`)
      .selectOption("validated")
    await expect(rowD).toHaveAttribute("data-status", "validated", { timeout: 30_000 })
    await expect.poll(async () => (await rowPaint()).rule).not.toBe(heldPaint.rule)
    // Same optimistic-update settle as above, now for the row's own Quote button.
    await expect(page.locator(`[data-testid="boxtal-prep-quote-${seed.orderD}"]`)).not.toHaveText(
      "Working",
      { timeout: 10_000 },
    )
    await capture(page, testInfo, "04-validated")

    // 7. Exclusion reaches a row with NO document, which the old per-document keying could not do.
    await page.locator(`[data-testid="boxtal-prep-exclude-${seed.orderB}"]`).click()
    await expect(rowB).toBeHidden({ timeout: 30_000 })
    await page.locator('[data-testid="boxtal-prep-show-excluded"]').check()
    await expect(rowB).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`[data-testid="boxtal-prep-restore-${seed.orderB}"]`)).toBeVisible()
    // Settle B's own busy flag (its restore-visibility read) before the capture, same reasoning.
    await expect(page.locator(`[data-testid="boxtal-prep-quote-${seed.orderB}"]`)).not.toHaveText(
      "Working",
      { timeout: 10_000 },
    )
    await capture(page, testInfo, "05-excluded")
    await page.locator(`[data-testid="boxtal-prep-restore-${seed.orderB}"]`).click()
    await expect(page.locator(`[data-testid="boxtal-prep-exclude-${seed.orderB}"]`)).toBeVisible({
      timeout: 30_000,
    })
  })

  test("Add shipment creates an order-less row on its own proforma", async ({
    page,
    env,
    world,
    qa,
  }, testInfo) => {
    assertBoxtalBundle()
    const s = env.serverUrl
    const token = qa.admin.token
    await useOfflineShopify(env as never)
    await seedPrepWorld(s, token, world.org.id)

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/boxtal/queue/to_prepare`)
    await expect(page.locator('[data-testid="boxtal-prep-grid"]')).toBeVisible({ timeout: 30_000 })

    await page.locator('[data-testid="boxtal-prep-add-shipment"]').click()
    const panel = page.locator('[data-testid="boxtal-prep-add-shipment-panel"]')
    await expect(panel).toBeVisible()

    // The submit button refuses until the label has an address it can print.
    await expect(page.locator('[data-testid="boxtal-prep-add-submit"]')).toBeDisabled()
    await expect(page.locator('[data-testid="boxtal-prep-add-missing"]')).toContainText("name")
    await capture(page, testInfo, "06-add-shipment-empty")

    await page.locator('[data-testid="boxtal-prep-add-name"]').fill("Repair Owner")
    await page.locator('[data-testid="boxtal-prep-add-street"]').fill("9 rue Neuve")
    await page.locator('[data-testid="boxtal-prep-add-city"]').fill("Nantes")
    await page.locator('[data-testid="boxtal-prep-add-postalCode"]').fill("44000")
    await page.locator('[data-testid="boxtal-prep-add-countryIsoCode"]').fill("FR")
    await page.locator('[data-testid="boxtal-prep-add-email"]').fill("owner@e2e.test")
    await page.locator('[data-testid="boxtal-prep-add-phone"]').fill("+33612345678")
    await page.locator('[data-testid="boxtal-prep-add-item-name-0"]').fill("Tessera 2 controller")
    await page.locator('[data-testid="boxtal-prep-add-item-ref-0"]').fill("VARIANT-STAB")
    await expect(page.locator('[data-testid="boxtal-prep-add-submit"]')).toBeEnabled()
    await capture(page, testInfo, "07-add-shipment-filled")

    await page.locator('[data-testid="boxtal-prep-add-submit"]').click()
    // The new row is ORDER-LESS: keyed on the proforma document once it exists (`doc:`), or on its
    // pending token (`pending:`) while the issue is waiting for an approval. Issuing a proforma is
    // gated in invoicing, so BOTH are correct outcomes and which one happens depends on the
    // operator's invoicing rights. What must hold either way: a row appeared, it is not an order
    // row, it says which of the two states it is in, and it does not offer to ship yet.
    const newRow = page.locator(
      '[data-testid^="boxtal-prep-row-doc:"], [data-testid^="boxtal-prep-row-pending:"]',
    )
    await expect(newRow).toBeVisible({ timeout: 60_000 })
    const newKey = (await newRow.getAttribute("data-testid"))!.replace("boxtal-prep-row-", "")
    const invoiceCell = page.locator(`[data-testid="boxtal-prep-invoice-${newKey}"]`)
    const invoiceState = await invoiceCell.getAttribute("data-state")
    expect(["issued", "pending_approval"]).toContain(invoiceState)
    if (invoiceState === "issued") {
      expect(newKey.startsWith("doc:")).toBe(true)
      // The pill now renders the NUMBER alone, so "it is a proforma, not the sale invoice" is
      // asserted where that word now lives: the title. The number must still be there.
      const pill = invoiceCell.locator(`[data-testid="boxtal-prep-invoice-${newKey}-pill"]`)
      const number = ((await pill.innerText()) ?? "").trim()
      expect(number.length).toBeGreaterThan(0)
      const title = (await invoiceCell.locator("span[title]").first().getAttribute("title")) ?? ""
      expect(title).toContain("Proforma")
      expect(title).toContain(number)
    } else {
      expect(newKey.startsWith("pending:")).toBe(true)
      await expect(
        invoiceCell.locator(`[data-testid="boxtal-prep-invoice-${newKey}-pill"]`),
      ).toHaveText("Pending")
      expect(await invoiceCell.locator("span[title]").first().getAttribute("title")).toContain(
        "Pending approval",
      )
      // A parked row must not offer a Ship button that cannot work.
      const ship = page.locator(`[data-testid="boxtal-prep-ship-${newKey}"]`)
      await expect(ship).toBeDisabled()
      expect((await ship.getAttribute("title")) ?? "").toMatch(/proforma/i)
    }
    // The row carries the category it was created with, and the recipient that was typed.
    await expect(page.locator(`[data-testid="boxtal-prep-row-${newKey}"]`)).toContainText(
      "Repair Owner",
    )
    await capture(page, testInfo, "08-order-less-row")
  })
})
