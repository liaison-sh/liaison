// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S15 + S16 — the local shipment index surfaced in the UI.
//
// S15 (search-merge): after a shipment is created, the unified command palette
//   renders a "From Boxtal" section (entity `shipment`, namespaced `app:boxtal`)
//   sourced from the LOCAL `shipment` index via `fanoutExternal` → the Boxtal
//   `searchHandler`. Also asserts the tool-level `search` returns the row.
//
// S16 (invoice back-reference): the invoice detail enumerates the Boxtal shipment
//   tab via the real K1 `kernel:slots.list` (the K1 gap-closure), and the Boxtal
//   Shipments standalone surface shows the linked shipment's status badge +
//   carrier + cost.
import { existsSync } from "node:fs"
import { loginAs } from "../fixtures/test"
import { assertBoxtalBundle, expect, INVOICING_BUNDLE, test } from "./_boxtal-fixtures"
import { seedCreatedShipment, toolPost } from "./helpers/seed-shipment"

test.describe("Boxtal: local index in the UI", () => {
  test("S15: a created shipment surfaces in the command palette + the tool-level search", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    const { orderId } = await seedCreatedShipment(s, token, world.org.id, "s15")

    // Tool-level: the local search index returns the row by the recipient name.
    const search = await toolPost(s, token, "boxtal", "search", { query: "Globex", limit: 10 })
    expect(search.status, JSON.stringify(search.body)).toBe(200)
    const results = search.body.results as Array<{ id: string; entity: string; title: string }>
    expect(results.length, JSON.stringify(results)).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.entity === "shipment")).toBe(true)
    expect(results.some((r) => /Globex/i.test(r.title))).toBe(true)

    // UI: the command palette renders a Boxtal-sourced shipment hit.
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/`)
    await page.waitForLoadState("networkidle")
    await page.keyboard.press("Meta+P")
    const palette = page.getByTestId("command-palette-input")
    if (!(await palette.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+P")
    }
    await expect(palette).toBeVisible({ timeout: 5_000 })
    await palette.fill("Globex")

    // The merged results render external Boxtal hits as buttons whose secondary
    // text is `boxtal:shipment` (CommandPalette external-entity mapping). Fail
    // loud if `fanoutExternal` → the Boxtal search handler doesn't surface the
    // local row.
    const dialog = page.getByRole("dialog")
    const boxtalHit = dialog
      .locator("button", { hasText: /Globex/i })
      .filter({ hasText: /boxtal/i })
    await expect(boxtalHit.first()).toBeVisible({ timeout: 15_000 })
    // Keep `orderId` referenced (the row this hit is sourced from).
    expect(orderId).toBeTruthy()
  })

  test("S16: invoice detail enumerates the Boxtal tab; the Shipments surface shows the linked shipment", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    const { invoiceId } = await seedCreatedShipment(s, token, world.org.id, "s16")

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`

    // --- (a) the invoice detail enumerates the Boxtal shipment tab via the real
    //     K1 `kernel:slots.list` (the K1 gap-closure), AND the cross-app slot
    //     body now renders the real BoxtalShipmentTab (host-driven `mountSlot`).
    //     The TAB appearing proves the slot enumeration resolved boxtal's
    //     `slots.invoicing.document_detail.tabs` against the real kernel; the
    //     real body proves the cross-app mount path.
    await page.goto(`${viteUrl}/invoicing/document/${invoiceId}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="document-detail-overview"]')).toBeVisible({
      timeout: 15_000,
    })
    // The Boxtal "Shipment" tab is enumerated alongside the built-in tabs.
    // The invoicing document-detail renders body tabs as <button> elements in a
    // <nav> (testid `document-detail-tab-<id>`), NOT ARIA role="tab" — the only
    // role="tab" elements are the OUTER kernel tab bar (Home/Home/detail). The
    // Boxtal contribution declares `id:"shipment"` in its
    // `slots.invoicing.document_detail.tabs[]`, so the K1 `kernel:slots.list`
    // enumeration surfaces it as `document-detail-tab-shipment`. Its mere
    // presence (merged into the built-in set) is the K1 gap-closure proof.
    const shipmentTab = page.locator('[data-testid="document-detail-tab-shipment"]')
    await expect(shipmentTab).toBeVisible({ timeout: 10_000 })
    await expect(shipmentTab).toContainText(/Shipment/i)
    await shipmentTab.click()
    // Cross-app slot-body rendering: the invoicing Shipment tab now mounts the
    // real BoxtalShipmentTab. entityId === the invoice id, which Boxtal indexes as
    // document_ref, so the linked-shipment card resolves (not the empty state).
    const body = page.locator('[data-testid="document-detail-tab-body-shipment"]')
    await expect(body).toBeVisible({ timeout: 10_000 })
    await expect(body.locator('[data-testid="boxtal-shipment-tab"]')).toBeVisible({
      timeout: 10_000,
    })
    // Linked, not empty: the empty-state CTA must be absent for a doc with a shipment.
    await expect(body.locator('[data-testid="boxtal-shipment-empty"]')).toHaveCount(0)

    // --- (b) the Boxtal Shipments standalone surface shows the linked shipment's
    //     status badge + carrier + cost (the linked-shipment view).
    await page.goto(`${viteUrl}/boxtal/shipments`)
    await page.waitForLoadState("networkidle")
    // The shipments table is rows-only (no header) and lists the LOCAL search
    // index, which returns nothing for the empty initial query — so an empty
    // table collapses to zero height and reads as `hidden`. Anchor on the
    // always-present search box, then drive the query so the row (and thus the
    // populated table) becomes visible.
    // Target the Shipments-surface search by testid — the sidebar has an
    // identical "Search shipments…" placeholder, so getByPlaceholder is ambiguous
    // (strict-mode violation). The e2e guideline mandates data-testid anyway.
    const searchBox = page.getByTestId("boxtal-shipments-search")
    await expect(searchBox).toBeVisible({ timeout: 15_000 })
    await searchBox.fill("Globex")
    const row = page.locator('[data-testid="boxtal-shipments-table"] tr', { hasText: /Globex/i })
    await expect(row.first()).toBeVisible({ timeout: 10_000 })
    // Click the row → the detail panel shows the order status badge + carrier.
    await row.first().click()
    await expect(page.locator('[data-testid="boxtal-shipment-detail"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="boxtal-shipment-detail"]')).toContainText(/Globex/i)
    await expect(page.locator('[data-testid="boxtal-shipment-detail"]')).toContainText(/Carrier/i)
  })
})
