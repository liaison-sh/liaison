// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S7 Saved views lifecycle (e2e-plan §S7, spec §1.2 / §3.2 / §6.3).
//
// Browser-driven coverage: defaults render, create via dialog, apply, rename,
// delete. Share/unshare and the kernel:saved_views:share permission negative
// case remain pending for the S7b collaboration scenario.

import { expect, test } from "./fixtures/test"

test("create/apply/rename/delete a saved view from the sidebar", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]
  const uniqueName = `E2E saved view ${Date.now()}`
  const renamedName = `${uniqueName} (renamed)`

  await page.goto(`http://localhost:${vitePort}/tickets`)
  await expect(page.getByTestId("saved-views-list")).toBeVisible({ timeout: 20000 })

  // ── Create ─────────────────────────────────────────────────────────────
  await page.getByTestId("saved-view-create").click()
  await expect(page.getByTestId("saved-view-dialog")).toBeVisible({ timeout: 5000 })
  await page.getByTestId("saved-view-dialog-name").fill(uniqueName)
  const createResp = page.waitForResponse(
    (r) => r.url().endsWith("/api/saved-views") && r.request().method() === "POST",
  )
  await page.getByTestId("saved-view-dialog-submit").click()
  const createRespFinal = await createResp
  expect(createRespFinal.status()).toBeLessThan(400)
  const created = (await createRespFinal.json()) as { data: { id: string } }
  const viewId = created.data.id
  expect(viewId).toBeTruthy()

  // Row appears in the sidebar
  const row = page.getByTestId(`saved-view-${viewId}`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row).toContainText(uniqueName)

  // ── Apply ──────────────────────────────────────────────────────────────
  // Clicking applies handler; we observe no error and the row remains.
  await row.locator("button").first().click()
  await expect(row).toBeVisible()

  // ── Rename via dialog ─────────────────────────────────────────────────
  await page.getByTestId(`saved-view-overflow-${viewId}`).click()
  await page.getByTestId(`saved-view-action-rename-${viewId}`).click()
  await expect(page.getByTestId("saved-view-dialog")).toBeVisible({ timeout: 5000 })
  await page.getByTestId("saved-view-dialog-name").fill(renamedName)
  const renameResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/saved-views/${viewId}`) && r.request().method() === "PATCH",
  )
  await page.getByTestId("saved-view-dialog-submit").click()
  expect((await renameResp).status()).toBeLessThan(400)
  await expect(row).toContainText(renamedName, { timeout: 10000 })

  // Reload — name should persist
  await page.reload()
  await expect(page.getByTestId(`saved-view-${viewId}`)).toContainText(renamedName, {
    timeout: 15000,
  })

  // ── Delete ─────────────────────────────────────────────────────────────
  await page.getByTestId(`saved-view-overflow-${viewId}`).click()
  const deleteResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/saved-views/${viewId}`) && r.request().method() === "DELETE",
  )
  await page.getByTestId(`saved-view-action-delete-${viewId}`).click()
  expect((await deleteResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`saved-view-${viewId}`)).toHaveCount(0, { timeout: 10000 })
})
