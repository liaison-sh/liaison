// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-list-and-detail — open Tickets activity bar,
// pick a ticket from the list, render its detail with conversation stream.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

test("[SC1][SC2][SC5] tickets-list-and-detail: open list, pick a ticket, render detail", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${Date.now()}`,
    emailAddress: `support-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const t = await seedTicket(env, orgId, {
    subject: `E2E ticket ${Date.now()}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${t.id}`)).toBeVisible({ timeout: 10000 })
  await page.getByTestId(`tickets-list-row-${t.id}`).click()
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-detail-subject")).toContainText(t.subject)
  await expect(page.getByTestId("tickets-conversation")).toBeVisible()
})
