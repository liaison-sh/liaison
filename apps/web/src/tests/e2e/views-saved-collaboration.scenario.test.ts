// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S7b Saved-views collaboration: manifest defaults, share/unshare,
// clone (multi-user), kernel:saved_views:share permission negative.
// Bridges S7 gaps (spec §1.2, §3.2, §6.3 share + clone semantics).

import { randomUUID } from "node:crypto"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantTicketsScopes } from "./helpers/seed"

test("manifest defaults render on first load", async ({ authenticatedPage, env, qa }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })

  const defaultsResp = await api(env.serverUrl, "/api/saved-views?app=tickets&viewId=inbox", {
    token: qa.admin.token,
  })
  expect(defaultsResp.status).toBe(200)
  const rows = defaultsResp.body.data as Array<{ id: string; manifestKey: string | null }>
  const manifestSeeded = rows.find((r) => r.manifestKey !== null)
  expect(manifestSeeded).toBeDefined()
  await expect(page.getByTestId(`saved-view-${manifestSeeded!.id}`)).toBeVisible()
})

test("share/unshare + clone across users", async ({
  authenticatedPage,
  browser,
  env,
  qa,
  world,
}) => {
  const adminPage = authenticatedPage
  const vitePort = env.ports[1]
  const sharedName = `S7b shared ${randomUUID().slice(0, 6)}`

  await adminPage.goto(`http://localhost:${vitePort}/tickets`)
  await expect(adminPage.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })
  await adminPage.getByTestId("saved-view-create").click()
  await expect(adminPage.getByTestId("saved-view-dialog")).toBeVisible({ timeout: 5000 })
  await adminPage.getByTestId("saved-view-dialog-name").fill(sharedName)
  await expect(adminPage.getByTestId("saved-view-dialog-share")).toBeVisible()
  await adminPage.getByTestId("saved-view-dialog-share").check()
  const createResp = adminPage.waitForResponse(
    (r) => r.url().endsWith("/api/saved-views") && r.request().method() === "POST",
  )
  await adminPage.getByTestId("saved-view-dialog-submit").click()
  const createFinal = await createResp
  expect(createFinal.status()).toBeLessThan(400)
  const sharedId = (await createFinal.json()).data.id as string

  const aminaCtx = await browser.newContext()
  const aminaPage = await aminaCtx.newPage()
  try {
    // QA users carry kernel and mail scopes only: without tickets read the
    // Tickets app (and its saved views) is not in Amina's shell at all.
    await grantTicketsScopes(env, world.org.id, qa.amina.id, ["tickets:tickets:read"])
    await loginAs(aminaPage, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await aminaPage.goto(`http://localhost:${vitePort}/tickets`)
    await expect(aminaPage.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })
    const sharedRow = aminaPage.getByTestId(`saved-view-${sharedId}`)
    await expect(sharedRow).toBeVisible({ timeout: 10000 })
    await expect(sharedRow).toContainText(sharedName)
    await expect(sharedRow).toContainText(/Shared by/i)

    await aminaPage.getByTestId(`saved-view-overflow-${sharedId}`).click()
    await expect(aminaPage.getByTestId(`saved-view-action-rename-${sharedId}`)).toHaveCount(0)
    await expect(aminaPage.getByTestId(`saved-view-action-delete-${sharedId}`)).toHaveCount(0)
    await expect(aminaPage.getByTestId(`saved-view-action-clone-${sharedId}`)).toBeVisible()

    const cloneResp = aminaPage.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/saved-views/${sharedId}/clone`) && r.request().method() === "POST",
    )
    await aminaPage.getByTestId(`saved-view-action-clone-${sharedId}`).click()
    expect((await cloneResp).status()).toBeLessThan(400)
    const aminaClone = aminaPage
      .getByTestId("saved-views-list")
      .getByTestId(/^saved-view-[0-9a-f-]+$/)
      .filter({ hasText: sharedName })
      .filter({ hasNotText: "Shared by" })
    await expect(aminaClone.first()).toBeVisible({ timeout: 10000 })

    await adminPage.getByTestId(`saved-view-overflow-${sharedId}`).click()
    const unshareResp = adminPage.waitForResponse(
      (r) => r.url().endsWith(`/api/saved-views/${sharedId}`) && r.request().method() === "PATCH",
    )
    await adminPage.getByTestId(`saved-view-action-share-${sharedId}`).click()
    expect((await unshareResp).status()).toBeLessThan(400)

    await aminaPage.reload()
    await expect(aminaPage.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })
    await expect(aminaPage.getByTestId(`saved-view-${sharedId}`)).toHaveCount(0, { timeout: 10000 })
    await expect(aminaClone.first()).toBeVisible()
  } finally {
    await aminaCtx.close()
  }
})

test("user without kernel:saved_views:share cannot toggle share", async ({
  page,
  env,
  qa,
  world,
}) => {
  const password = "QaPass1!"
  const noShareUser = await createUserWithScopes(
    env.serverUrl,
    env.db.sql,
    qa.admin.token,
    world.org.id,
    {
      email: `s7b-no-share-${randomUUID().slice(0, 8)}@e2e.test`,
      password,
      name: "S7b No Share",
      scopes: ["tickets:tickets:read"],
      schemaPrefix: env.schemaPrefix,
    },
  )
  await loginAs(page, env, noShareUser.email, password)
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })
  await page.getByTestId("saved-view-create").click()
  await expect(page.getByTestId("saved-view-dialog")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("saved-view-dialog-share")).toHaveCount(0)
  await page.getByTestId("saved-view-dialog-cancel").click()
})
