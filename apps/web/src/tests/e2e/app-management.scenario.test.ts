// SPDX-License-Identifier: FSL-1.1-ALv2
// App management (S18–S24) — browser E2E, admin and members side by side.
//
//  1. The admin turns Tickets Off on its page (in-page confirm): a member loses
//     Tickets after a refresh (no rail entry, absent from the manifests feed,
//     its tool route refused with app_disabled); the admin keeps an "Off" row
//     and a read-only page with the notice; turning it back On restores it.
//  2. The admin restricts Invoicing to one role: the member outside the role
//     loses it, the member inside keeps it; back to Everyone restores it.
//  3. The App store: Installed / Available and category filters, search, and a
//     listing that shows its source repository and licence, never a price.
//  4. Remove from this workspace, then Add it back from the App store.
//  5. Uninstall from the server is refused while another workspace has the app,
//     and the dialog says so in words.
//
// Each test leaves the workspace as it found it (Tickets On, Invoicing added
// and open to everyone), so the tests read alone.

import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test, type WorkerEnvWithDrive } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { assignRoleToUser, seedRoleWithScopes } from "./helpers/seed"
import { grantSupportAgent } from "./helpers/settings-roles"
import { installInvoicingApp } from "./invoicing/helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./invoicing/helpers/invoicing-bundle"

const QA_PASSWORD = "QaPass1!"
const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"
const PRICE_TEXT = /\b(price|pricing|per month|subscription|free trial)\b|[$€£]\s?\d/i

type Env = WorkerEnvWithDrive

/** The app names in a user's manifests feed, with a token minted now. */
async function feedFor(
  env: Env,
  email: string,
): Promise<{ names: string[]; unavailable: string[] }> {
  const token = await freshAccessToken(env.serverUrl, email, QA_PASSWORD)
  const res = await api(env.serverUrl, "/api/apps/manifests", { token })
  expect(res.status).toBe(200)
  const body = res.body as { data: Array<{ name: string }>; unavailableApps?: string[] }
  return { names: body.data.map((d) => d.name), unavailable: body.unavailableApps ?? [] }
}

/** The admin's view of one app (GET /api/org/apps). */
async function orgApp(env: Env, name: string) {
  // Every change bumps permission_version: a token minted now.
  const token = await freshAccessToken(env.serverUrl, ADMIN_EMAIL, ADMIN_PASSWORD)
  const res = await api(env.serverUrl, "/api/org/apps", { token })
  expect(res.status).toBe(200)
  const apps = (res.body as { data: Array<{ name: string; status: string; accessMode: string }> })
    .data
  return apps.find((a) => a.name === name)
}

async function withMember<T>(
  browser: Browser,
  env: Env,
  email: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await loginAs(page, env, email, QA_PASSWORD)
    return await fn(page)
  } finally {
    await context.close()
  }
}

async function ensureInvoicing(env: Env, token: string, orgId: string): Promise<void> {
  await installInvoicingApp({
    serverUrl: env.serverUrl,
    token,
    orgId,
    bundlePath: INVOICING_BUNDLE,
    issuerCountry: "FR",
  })
}

test.describe("App management", () => {
  test("Tickets Off: the member loses it after a refresh, the admin keeps an Off row; back On restores it", async ({
    authenticatedPage,
    browser,
    env,
    qa,
    world,
  }) => {
    const page = authenticatedPage
    const web = `http://localhost:${env.ports[1]}`
    const amina = qa.amina.email
    // The member works in Tickets (a support agent's scopes, no admin).
    await grantSupportAgent(env, world.org.id, qa.amina.id)

    // Discriminator: before the change the member has Tickets.
    expect((await feedFor(env, amina)).names).toContain("tickets")
    await withMember(browser, env, amina, async (m) => {
      await expect(m.getByTestId("activity-tickets")).toBeVisible({ timeout: 20_000 })
    })

    // The admin turns it Off from its page, through the in-page confirm.
    await page.goto(`${web}/settings/apps/tickets`)
    const sw = page.getByTestId("app-enabled-switch")
    await expect(sw).toBeVisible({ timeout: 20_000 })
    await sw.click()
    const confirm = page.getByTestId("app-disable-confirm")
    await expect(confirm).toBeVisible()
    const disabled = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/tickets/disable") && r.request().method() === "POST",
    )
    await page.getByTestId("app-disable-confirm-yes").click()
    expect((await disabled).status()).toBeLessThan(400)
    await expect(confirm).toHaveCount(0)

    // The admin: the page turns read-only with the notice, and an "Off" row.
    await expect(page.getByTestId("app-off-notice")).toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(page.getByTestId("app-off-notice")).toBeVisible({ timeout: 20_000 })
    const row = page.getByTestId("settings-link-app:tickets")
    await expect(row).toBeVisible()
    await expect(row).toContainText("Off")
    expect((await orgApp(env, "tickets"))?.status).toBe("disabled")

    // The member: absent from the feed, no rail entry after a refresh, and its
    // tool route refuses with app_disabled.
    const feed = await feedFor(env, amina)
    expect(feed.names).not.toContain("tickets")
    expect(feed.unavailable).toContain("tickets")
    const memberToken = await freshAccessToken(env.serverUrl, amina, QA_PASSWORD)
    const tool = await api(env.serverUrl, "/api/apps/tickets/tools/tickets_list", {
      method: "POST",
      token: memberToken,
      body: {},
    })
    expect(tool.status).toBe(410)
    expect((tool.body as { error?: { code?: string } }).error?.code).toBe("app_disabled")
    await withMember(browser, env, amina, async (m) => {
      await expect(m.locator("[data-shell]")).toBeVisible()
      await m.waitForLoadState("networkidle")
      await expect(m.getByTestId("activity-tickets")).toHaveCount(0)
    })

    // Back On, from the same switch: the page and the member's Tickets return.
    const enabled = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/tickets/enable") && r.request().method() === "POST",
    )
    await page.getByTestId("app-enabled-switch").click()
    expect((await enabled).status()).toBeLessThan(400)
    await expect(page.getByTestId("app-off-notice")).toHaveCount(0, { timeout: 15_000 })
    expect((await feedFor(env, amina)).names).toContain("tickets")
    await withMember(browser, env, amina, async (m) => {
      await expect(m.getByTestId("activity-tickets")).toBeVisible({ timeout: 20_000 })
    })
  })

  test("Invoicing restricted to one role: the member outside it loses it, the member inside keeps it", async ({
    authenticatedPage,
    env,
    qa,
    world,
  }) => {
    const page = authenticatedPage
    const web = `http://localhost:${env.ports[1]}`
    await ensureInvoicing(env, qa.admin.token, world.org.id)
    const tag = randomUUID().slice(0, 6)
    // Both members use Invoicing, through different roles; only Finance is listed.
    const finance = await seedRoleWithScopes(env, world.org.id, {
      name: `Finance ${tag}`,
      scopes: ["invoicing:*"],
    })
    const users = await seedRoleWithScopes(env, world.org.id, {
      name: `Invoicing users ${tag}`,
      scopes: ["invoicing:*"],
    })
    await assignRoleToUser(env, world.org.id, finance, qa.lucas.id)
    await assignRoleToUser(env, world.org.id, users, qa.amina.id)

    // Discriminator: before the restriction both members have Invoicing.
    expect((await feedFor(env, qa.amina.email)).names).toContain("invoicing")
    expect((await feedFor(env, qa.lucas.email)).names).toContain("invoicing")

    await page.goto(`${web}/settings/apps/invoicing`)
    const who = page.getByTestId("app-access-button")
    await expect(who).toBeVisible({ timeout: 20_000 })
    await who.click()
    const dialog = page.getByTestId("app-access-dialog")
    await expect(dialog).toBeVisible()
    await dialog.getByTestId("app-access-some").check()
    await dialog.getByTestId(`app-access-role-${finance}`).click()
    await expect(dialog.getByTestId(`app-access-role-${finance}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/invoicing/access") && r.request().method() === "PUT",
    )
    await dialog.getByTestId("app-access-save").click()
    const savedRes = await saved
    expect(savedRes.status()).toBeLessThan(400)
    expect(savedRes.request().postDataJSON()).toMatchObject({
      mode: "restricted",
      roleIds: [finance],
    })
    await expect(dialog).toHaveCount(0)
    await expect(who).toContainText(`Finance ${tag}`)

    expect((await feedFor(env, qa.amina.email)).names).not.toContain("invoicing")
    expect((await feedFor(env, qa.lucas.email)).names).toContain("invoicing")

    // Back to Everyone: the member outside the role has it again.
    await who.click()
    await expect(dialog).toBeVisible()
    await dialog.getByTestId("app-access-everyone").check()
    const back = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/invoicing/access") && r.request().method() === "PUT",
    )
    await dialog.getByTestId("app-access-save").click()
    expect((await back).status()).toBeLessThan(400)
    await expect(dialog).toHaveCount(0)
    expect((await feedFor(env, qa.amina.email)).names).toContain("invoicing")
  })

  test("App store: filters, search, and a listing with its source repository and licence, no price", async ({
    authenticatedPage,
    env,
    qa,
    world,
  }) => {
    const page = authenticatedPage
    const web = `http://localhost:${env.ports[1]}`
    await ensureInvoicing(env, qa.admin.token, world.org.id)

    await page.goto(`${web}/settings/store`)
    const store = page.getByTestId("app-store")
    await expect(store.getByTestId("app-store-list")).toBeVisible({ timeout: 20_000 })
    await expect(store.getByTestId("app-store-seg-installed")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(store.getByTestId("app-store-row-tickets")).toBeVisible()
    await expect(store.getByTestId("app-store-row-invoicing")).toBeVisible()
    await expect(store.getByTestId("app-store-state-tickets")).toHaveText("Running")

    // A category chip narrows the list; All brings everything back.
    await store.getByTestId("app-store-cat-Finance").click()
    await expect(store.getByTestId("app-store-row-invoicing")).toBeVisible()
    await expect(store.getByTestId("app-store-row-tickets")).toHaveCount(0)
    await store.getByTestId("app-store-cat-All").click()
    await expect(store.getByTestId("app-store-row-tickets")).toBeVisible()

    // Search.
    await store.getByTestId("app-store-search").fill("ticket")
    await expect(store.getByTestId("app-store-row-tickets")).toBeVisible()
    await expect(store.getByTestId("app-store-row-invoicing")).toHaveCount(0)
    await store.getByTestId("app-store-search").fill("")

    // The Available segment lists only what this workspace has not added.
    await store.getByTestId("app-store-seg-available").click()
    await expect(store.getByTestId("app-store-seg-available")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(store.getByTestId("app-store-row-tickets")).toHaveCount(0)
    await store.getByTestId("app-store-seg-installed").click()

    expect(await store.innerText()).not.toMatch(PRICE_TEXT)

    // The listing page.
    await store.getByTestId("app-store-open-invoicing").click()
    await expect(page).toHaveURL(/\/settings\/store\/invoicing$/)
    const detail = page.getByTestId("app-store-detail-invoicing")
    await expect(detail).toBeVisible({ timeout: 15_000 })
    await expect(detail.getByTestId("app-store-detail-repo")).toHaveText(
      "https://github.com/mathieufro/liaison/tree/main/bundled-apps/invoicing",
    )
    await expect(detail.getByTestId("app-store-detail-licence")).toContainText("FSL-1.1-ALv2")
    await expect(detail.getByTestId("app-store-detail-publisher")).toContainText("Liaison")
    await expect(detail.getByTestId("app-store-detail-perms")).toBeVisible()
    expect(await detail.innerText()).not.toMatch(PRICE_TEXT)
  })

  test("Remove from this workspace, then Add it back from the App store", async ({
    authenticatedPage,
    env,
    qa,
    world,
  }) => {
    const page = authenticatedPage
    const web = `http://localhost:${env.ports[1]}`
    await ensureInvoicing(env, qa.admin.token, world.org.id)

    await page.goto(`${web}/settings/apps/invoicing`)
    await expect(page.getByTestId("app-management")).toBeVisible({ timeout: 20_000 })
    await page.getByTestId("app-management-more").click()
    await page.getByTestId("app-management-remove").click()
    const dialog = page.getByTestId("app-remove-dialog")
    await expect(dialog).toBeVisible()
    const removed = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/invoicing/remove") && r.request().method() === "POST",
    )
    await dialog.getByTestId("app-remove-confirm").click()
    expect((await removed).status()).toBeLessThan(400)
    await expect(dialog).toHaveCount(0)
    expect((await orgApp(env, "invoicing"))?.status).toBe("removed")
    expect((await feedFor(env, qa.amina.email)).names).not.toContain("invoicing")

    // The App store offers it again: Add brings it back to the workspace.
    await page.goto(`${web}/settings/store`)
    const store = page.getByTestId("app-store")
    await expect(store.getByTestId("app-store-list")).toBeVisible({ timeout: 20_000 })
    await store.getByTestId("app-store-seg-available").click()
    const add = store.getByTestId("app-store-add-invoicing")
    await expect(add).toBeVisible()
    const added = page.waitForResponse(
      (r) => r.url().endsWith("/api/org/apps/invoicing/add") && r.request().method() === "POST",
    )
    await add.click()
    expect((await added).status()).toBeLessThan(400)
    await store.getByTestId("app-store-seg-installed").click()
    await expect(store.getByTestId("app-store-state-invoicing")).toHaveText("Running", {
      timeout: 15_000,
    })
    expect((await orgApp(env, "invoicing"))?.status).toBe("active")
  })

  test("Uninstall from the server is refused while another workspace has the app", async ({
    authenticatedPage,
    env,
    qa,
    world,
  }) => {
    const page = authenticatedPage
    const web = `http://localhost:${env.ports[1]}`
    await ensureInvoicing(env, qa.admin.token, world.org.id)
    // A second workspace on this server that has Invoicing added.
    const k = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const slug = `other-${randomUUID().slice(0, 8)}`
    const [other] = (await env.db.sql.unsafe(
      `INSERT INTO ${k}.organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Other workspace ${slug}`, slug],
    )) as Array<{ id: string }>
    await env.db.sql.unsafe(
      `INSERT INTO ${k}.apps (org_id, name, version, status) VALUES ($1, 'invoicing', '0', 'active')`,
      [other.id],
    )
    try {
      await page.goto(`${web}/settings/store/invoicing`)
      const detail = page.getByTestId("app-store-detail-invoicing")
      await expect(detail).toBeVisible({ timeout: 20_000 })
      await detail.getByTestId("app-store-detail-more").click()
      await page.getByTestId("app-store-detail-uninstall").click()
      const dialog = page.getByTestId("app-store-uninstall-dialog")
      await expect(dialog).toBeVisible()
      const refused = page.waitForResponse(
        (r) => r.url().includes("/invoicing") && r.request().method() === "DELETE",
      )
      await dialog.getByTestId("app-store-uninstall-confirm").click()
      expect((await refused).status()).toBe(409)
      await expect(dialog.getByTestId("app-store-uninstall-error")).toHaveText(
        "invoicing is still added in 1 other workspace. It can be uninstalled once it removes it.",
      )
      // Still installed and added here.
      expect((await orgApp(env, "invoicing"))?.status).toBe("active")
    } finally {
      await env.db.sql.unsafe(`DELETE FROM ${k}.organizations WHERE id = $1`, [other.id])
    }
  })
})
