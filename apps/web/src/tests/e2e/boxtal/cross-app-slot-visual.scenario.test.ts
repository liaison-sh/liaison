// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 — cross-app slot-body VISUAL scenarios.
//
// Proves the host-driven `app.mountSlot` cross-app render: the invoicing
// document-detail "Shipment" tab mounts the REAL BoxtalShipmentTab (a foreign
// app's component) inside the invoicing surface — linked-shipment card (V1) or
// empty-state CTA (V2). Unlike `visual.scenario.test.ts` (which mocks the host
// `invokeTool`), these scenarios drive the LIVE seed + real K5 slot enumeration
// + real cross-app mount, so the screenshot captures the genuine rendered
// subtree (charcoal theme parity inside invoicing's CSS scope).
//
// Pixel goldens are darwin-only (`*-darwin.png`). FUNCTIONAL assertions (the
// real Boxtal body / empty-state visible) run EVERYWHERE.
// Re-bake after an intentional UI change with:
//   bunx --bun playwright test --update-snapshots=all -g "cross-app slot"
import { existsSync } from "node:fs"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { assertBoxtalBundle, expect, INVOICING_BUNDLE, test } from "./_boxtal-fixtures"
import { seedCreatedShipment, seedIssuedInvoice } from "./helpers/seed-shipment"

const SHOT = { maxDiffPixelRatio: 0.01 } as const
const PIXEL_BASELINES = process.platform === "darwin"

test.setTimeout(120_000)

test.describe("Boxtal: cross-app slot body (visual)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  test("V1: linked shipment — invoicing Shipment tab renders the real Boxtal card", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const { invoiceId } = await seedCreatedShipment(env.serverUrl, token, world.org.id, "v1")

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/document/${invoiceId}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="document-detail-overview"]')).toBeVisible({
      timeout: 15_000,
    })
    await page.locator('[data-testid="document-detail-tab-shipment"]').click()
    // The real BoxtalShipmentTab mounts inside invoicing's document-detail body.
    const card = page.locator('[data-testid="boxtal-shipment-tab"]')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('[data-testid="boxtal-shipment-linked"]')).toBeVisible({
      timeout: 10_000,
    })
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES) {
      await expect(card).toHaveScreenshot("invoicing-shipment-tab-linked.png", SHOT)
    }
  })

  test("V2: no shipment — Shipment tab renders the real Boxtal empty-state CTA", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    // Issue an invoice WITHOUT creating a shipment, then open its Shipment tab —
    // Boxtal's fetchLinked returns null → empty-state CTA.
    const { invoiceId } = await seedIssuedInvoice(env.serverUrl, token, world.org.id, "v2")

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/document/${invoiceId}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="document-detail-overview"]')).toBeVisible({
      timeout: 15_000,
    })
    await page.locator('[data-testid="document-detail-tab-shipment"]').click()
    const card = page.locator('[data-testid="boxtal-shipment-tab"]')
    await expect(card).toBeVisible({ timeout: 10_000 })
    const empty = card.locator('[data-testid="boxtal-shipment-empty"]')
    await expect(empty).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES) {
      await expect(card).toHaveScreenshot("invoicing-shipment-tab-empty.png", SHOT)
    }
  })
})
