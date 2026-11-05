// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"

test("Contacts UI: list default, empty state, and detail visuals", async ({ page, env, qa }) => {
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-contacts").click()

  const list = page.getByTestId("contacts-list")
  await expect(list).toBeVisible({ timeout: 10000 })
  // Wait for at least one row before snapshotting the populated list.
  await expect(page.getByTestId(`contact-row-${qa.contacts.hansPrimary.id}`)).toBeVisible({
    timeout: 10000,
  })

  // F1: contacts list default visual baseline.
  // Semantic fallback: list has search field; rows show name/email/company/created;
  // no merge or delete confirmation overlay is visible.
  await expect(list).toHaveScreenshot("contacts-list-default.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.locator('[data-testid="contact-row-created"]')],
  })

  // F2: contacts list empty state.
  // Semantic fallback: empty state clearly says no contacts match the query and does not
  // show stale contact rows.
  await page.getByTestId("contacts-search").fill("zzz-no-such-contact-prefix-deterministic")
  await expect(list).toContainText(/No contacts match|No contacts/)
  await expect(list).toHaveScreenshot("contacts-list-empty.png", {
    maxDiffPixelRatio: 0.05,
  })

  // F3: contact detail populated.
  // Semantic fallback: identity fields and mail backlinks are visible; delete confirmation
  // is not open by default.
  await page.getByTestId("contacts-search").fill("Hans")
  const row = page.getByTestId(`contact-row-${qa.contacts.hansPrimary.id}`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()

  const detail = page.getByTestId("contact-detail")
  await expect(detail).toBeVisible({ timeout: 10000 })
  await expect(detail).toContainText("hans@acme.de")
  await expect(detail).toHaveScreenshot("contact-detail-populated.png", {
    maxDiffPixelRatio: 0.05,
    mask: [detail.locator("time, [data-relative-time]")],
  })
})

test("Contacts UI: search, detail, and merge Hans duplicate", async ({ page, env, qa }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible()

  await page.getByTestId("contacts-search").fill("Hans")
  await expect(page.getByTestId(`contact-row-${qa.contacts.hansDuplicate.id}`)).toBeVisible()
  // The merge flow treats the opened contact as the SOURCE (gets deleted)
  // and the picked candidate as the TARGET ("Survivor" in the dialog UI).
  // To delete the duplicate, open it and merge into hansPrimary.
  await page.getByTestId(`contact-row-${qa.contacts.hansDuplicate.id}`).click()

  await expect(page.getByTestId("contact-detail")).toContainText("hans.weber@acme.de")
  await page.getByTestId("contact-merge-open").click()

  await page.getByTestId("merge-target-search").fill("Hans")
  await page.getByTestId("merge-target-search-submit").click()
  await page.getByTestId(`merge-target-candidate-${qa.contacts.hansPrimary.id}`).click()
  await page.getByTestId("merge-continue").click()
  await page.getByTestId("merge-confirm").click()

  await expect(page.getByText("Contacts merged")).toBeVisible({ timeout: 5000 })

  // Tabs are keep-alive (display:none when inactive). Switch back to the list
  // tab so we can see the row disappear; the contacts-list was rendered with
  // hansDuplicate before the merge, and the WS `delete` event the backend
  // emits in mergeContacts() should remove it from contactListStore.
  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`contact-row-${qa.contacts.hansDuplicate.id}`)).toHaveCount(0, {
    timeout: 10000,
  })

  const kernelSchema = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
  const mailSchema = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
  const sourceRows = await env.db.sql.unsafe(
    `SELECT id FROM ${kernelSchema}.contacts WHERE id = $1`,
    [qa.contacts.hansDuplicate.id],
  )
  expect(sourceRows).toHaveLength(0)
  const staleRefs = await env.db.sql.unsafe(
    `SELECT id FROM ${mailSchema}.conversations WHERE contact_id = $1`,
    [qa.contacts.hansDuplicate.id],
  )
  expect(staleRefs).toHaveLength(0)
})
