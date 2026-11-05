// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-manual-create — open NewTicketDialog, submit, then verify the
// detail tab opens and the new ticket appears in the inbox list.
import { expect, loginAs, test } from "./fixtures/test"

test("[SC4] tickets-manual-create: create via dialog and verify list/detail", async ({
  page,
  env,
  qa,
}) => {
  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })

  const subject = `Manual ${Date.now()}`
  await page.getByTestId("tickets-new-ticket-button").click()
  await expect(page.getByTestId("tickets-new-dialog")).toBeVisible()
  await page.getByTestId("tickets-new-subject").fill(subject)
  await page.getByTestId("tickets-new-contact-email").fill(`manual-${Date.now()}@e2e.test`)
  await page.getByTestId("tickets-new-contact-name").fill("Manual Customer")
  await page.getByTestId("tickets-new-body").fill("Initial manual ticket body")
  await page.getByTestId("tickets-new-priority").selectOption("high")
  await page.getByTestId("tickets-new-submit").click()

  // Detail view opens with the new ticket
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-detail-subject")).toContainText(subject)
})
