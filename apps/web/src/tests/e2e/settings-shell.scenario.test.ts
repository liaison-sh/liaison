// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The settings shell (settings overhaul P2, S9-S12), end to end in the browser.
 *
 * (a) The settings column shows each person the rows their scopes reach: an
 *     admin sees the workspace and Connectors rows, a support lead the Tickets
 *     app row and no admin row, a member their own rows only.
 * (b) Former settings URLs land on their new home, including a former
 *     sub-page (/settings/tickets/categories), an MCP server's former page
 *     (/settings/admin/mcp-servers/:id, the id carried over) and an app page
 *     (/settings/invoicing).
 * (c) At phone width the You screen lists exactly the rows of the desktop
 *     column.
 */

import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { assignRoleToUser, seedRoleWithScopes } from "./helpers/seed"
import { grantSupportAgent } from "./helpers/settings-roles"
import { installInvoicingApp } from "./invoicing/helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./invoicing/helpers/invoicing-bundle"

const QA_PASSWORD = "QaPass1!"
const SHOT = { maxDiffPixelRatio: 0.02 } as const
const PIXEL_BASELINES = process.platform === "darwin"
const ADMIN_ROWS = [
  "settings-link-kernel:users",
  "settings-link-kernel:roles",
  "settings-link-kernel:org",
  "settings-link-kernel:system",
]

/** The column's rows, read once `waitFor` (a row the viewer has) is there: app rows
 *  arrive with the manifests, after the kernel rows. */
async function sidebarRows(page: Page, waitFor: string): Promise<string[]> {
  const nav = page.getByTestId("settings-sidebar")
  await expect(nav.getByTestId(waitFor)).toBeVisible({ timeout: 20_000 })
  return nav
    .locator("[data-testid^='settings-link-']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""))
}

test.describe("settings column rows by role", () => {
  test("an admin sees the workspace rows and the Connectors heading", async ({
    authenticatedPage,
    env,
  }) => {
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings`)
    const rows = await sidebarRows(page, "settings-link-app:tickets")
    expect(rows).toContain("settings-link-app:tickets")
    expect(rows).toContain("settings-link-kernel:connectors")
    for (const admin of [
      "settings-link-kernel:users",
      "settings-link-kernel:roles",
      "settings-link-kernel:org",
    ]) {
      expect(rows).toContain(admin)
    }
    await expect(page.getByTestId("settings-group-heading-connectors")).toBeVisible()
    await page.screenshot({ path: test.info().outputPath("sidebar-admin.png") })
    // The admin's column: five groups, one row per app, the Connectors heading link.
    if (PIXEL_BASELINES) {
      await expect(page.getByTestId("settings-sidebar")).toHaveScreenshot(
        "settings-sidebar-admin.png",
        SHOT,
      )
    }
  })

  test("a support lead sees the Tickets row and no workspace admin row", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const roleId = await seedRoleWithScopes(env, world.org.id, {
      name: `Support lead ${Date.now()}`,
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:inboxes:read",
        "tickets:inboxes:admin",
        "tickets:categories:read",
        "tickets:categories:admin",
        "tickets:accounts:admin",
      ],
    })
    await assignRoleToUser(env, world.org.id, roleId, qa.lucas.id)
    await loginAs(page, env, qa.lucas.email, QA_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/settings`)
    const rows = await sidebarRows(page, "settings-link-app:tickets")
    expect(rows).toContain("settings-link-app:tickets")
    expect(rows).not.toContain("settings-link-kernel:connectors")
    for (const admin of ADMIN_ROWS) expect(rows).not.toContain(admin)

    // The Tickets page shows the lead's sections and none of the admin's.
    await page.getByTestId("settings-link-app:tickets").click()
    await expect(page.getByTestId("settings-section-inboxes")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("settings-section-categories")).toBeVisible()
    await expect(page.getByTestId("settings-section-api-keys")).toHaveCount(0)
    await expect(page.getByTestId("settings-section-response-times")).toHaveCount(0)
  })

  test("a member sees only their own rows", async ({ page, env, world, qa }) => {
    await grantSupportAgent(env, world.org.id, qa.tobias.id)
    await loginAs(page, env, qa.tobias.email, QA_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/settings`)
    const rows = await sidebarRows(page, "settings-link-app:tickets")
    expect(rows).not.toContain("settings-link-kernel:connectors")
    for (const admin of ADMIN_ROWS) expect(rows).not.toContain(admin)
    // Tickets has a section for every member who uses it (the signature): the row is there.
    expect(rows).toContain("settings-link-app:tickets")
    // An app with org-only sections has no row for a member.
    expect(rows).not.toContain("settings-link-app:projects")
  })
})

test.describe("former settings URLs", () => {
  test("a former Tickets sub-page lands on the Tickets page", async ({
    authenticatedPage,
    env,
  }) => {
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/tickets/categories`)
    await expect(page).toHaveURL(/\/settings\/apps\/tickets(\?|$)/, { timeout: 15_000 })
    await expect(page.getByTestId("settings-section-categories")).toBeVisible({ timeout: 15_000 })
  })

  test("a former MCP server page lands on its Connectors page, id carried over", async ({
    authenticatedPage,
    env,
    qa,
  }) => {
    if (!env.mockMcp) throw new Error("Per-worker mock-MCP fixture failed to start")
    const created = await api(env.serverUrl, "/api/apps/mcp-manager/connections", {
      method: "POST",
      token: qa.admin.token,
      body: {
        slug: `shell-${env.workerId}-${Date.now()}`,
        displayName: "Shell redirect MCP",
        transport: "http",
        ownershipScope: "org",
        authFlavor: "none",
        connectionDefaultPolicy: "auto",
        httpUrl: env.mockMcp.url,
      },
    })
    expect([200, 201]).toContain(created.status)
    const body = created.body as { id?: string; data?: { id?: string } }
    const id = body.id ?? body.data?.id
    expect(id).toBeTruthy()
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/admin/mcp-servers/${id}`)
    await expect(page).toHaveURL(new RegExp(`/settings/connectors/mcp/${id}$`), {
      timeout: 15_000,
    })
    await expect(page.getByTestId("mcp-server-detail-page")).toBeVisible({ timeout: 15_000 })
  })

  test("/settings/invoicing lands on the Invoicing page", async ({
    authenticatedPage,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(120_000)
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
    })
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/invoicing`)
    await expect(page).toHaveURL(/\/settings\/apps\/invoicing/, { timeout: 20_000 })
    await expect(page.getByTestId("app-settings-page-invoicing")).toBeVisible({ timeout: 20_000 })
  })
})

test("phone parity: the You screen lists the desktop column's rows", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings`)
  const nav = page.getByTestId("settings-sidebar")
  await expect(nav.getByTestId("settings-link-app:tickets")).toBeVisible({ timeout: 20_000 })
  const readDesktop = () =>
    nav
      .locator("[data-testid^='settings-link-']")
      .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()))
  // Each app adds its row once its bundle loads (an app an earlier test
  // installed can come after Tickets), so read the column once it settles.
  let desktop = await readDesktop()
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(1_000)
        const now = await readDesktop()
        const settled = JSON.stringify(now) === JSON.stringify(desktop)
        desktop = now
        return settled
      },
      { intervals: [0], timeout: 20_000 },
    )
    .toBe(true)
  expect(desktop.length).toBeGreaterThan(4)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${env.ports[1]}/settings`)
  await expect(page.getByTestId("you-screen")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("you-row-apps-tickets")).toBeAttached({ timeout: 20_000 })
  const readPhone = () =>
    page
      .locator("[data-testid^='you-row-']")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("data-testid") !== "you-row-agent-app")
          .map((el) => (el.textContent ?? "").trim()),
      )
  await expect.poll(readPhone, { timeout: 20_000 }).toEqual(desktop)
  await page.screenshot({ path: test.info().outputPath("you-phone.png") })
})
