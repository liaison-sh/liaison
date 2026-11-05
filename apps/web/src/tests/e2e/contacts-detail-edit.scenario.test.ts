// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { resolveContact } from "./helpers/contacts-seed"
import { freshAccessToken } from "./helpers/fresh-token"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("Contacts detail: inline name edit + delete confirmation", async ({
  page,
  env,
  qa,
}, testInfo) => {
  const unique = `delete-target-${testInfo.workerIndex}-${Date.now()}`
  const targetEmail = `${unique}@e2e.test`
  // Refresh the admin's token — earlier tests in the same worker may have bumped
  // his permission_version, which would 401 a `qa.admin.token`-based seed.
  const adminToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const target = await resolveContact(env, adminToken, {
    email: targetEmail,
    name: "Initial Name",
    company: "E2E Co",
    externalId: { e2e: unique },
  })

  await loginAs(page, env, qa.admin.email, "12345678")

  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 10000 })
  await page.getByTestId("contacts-search").fill(unique)
  const row = page.getByTestId(`contact-row-${target.id}`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()

  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })

  // InlineField swaps a <button> (display) for an <input> (edit) under the same
  // data-testid via <Show>. Click to enter edit mode, then re-locate the input.
  const nameTrigger = page.getByTestId("contact-name-input")
  await expect(nameTrigger).toBeVisible()
  await nameTrigger.click()
  const nameInput = page.getByTestId("contact-name-input")
  await expect(nameInput).toBeEditable()
  const patchPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/contacts/${target.id}`) &&
      response.request().method() === "PATCH",
  )
  await nameInput.fill("Delete Target Tester")
  await nameInput.blur()
  const patchResponse = await patchPromise
  expect(patchResponse.status()).toBe(200)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT name FROM ${ks(env.schemaPrefix)}.contacts WHERE id = $1`,
        [target.id],
      )) as Array<{ name: string }>
      return rows[0]?.name
    })
    .toBe("Delete Target Tester")

  await page.getByTestId("contact-overflow-menu").click()
  await page.getByTestId("contact-delete").click()

  const confirmBar = page.getByTestId("contact-delete-confirmation")
  await expect(confirmBar).toBeVisible()
  const deletePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/contacts/${target.id}`) &&
      response.request().method() === "DELETE",
  )
  await page.getByTestId("contact-delete-confirm").click()
  const deleteResponse = await deletePromise
  expect(deleteResponse.status()).toBe(200)

  await expect(page.getByTestId("contact-not-found")).toBeVisible({ timeout: 5000 })

  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 10000 })
  await page.getByTestId("contacts-search").fill(unique)
  await expect(page.getByTestId(`contact-row-${target.id}`)).toHaveCount(0)
})
