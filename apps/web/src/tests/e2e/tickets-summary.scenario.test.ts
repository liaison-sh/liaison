// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-summary — TicketSummaryCard collapses + expands; collapse
// state is persistent within the session.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

test("[SC6] tickets-summary: card visible, toggles collapse", async ({ page, env, qa, world }) => {
  const orgId = world.org.id
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${Date.now()}`,
    emailAddress: `support-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const t = await seedTicket(env, orgId, {
    subject: `Summary ${Date.now()}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${t.id}`)
  await expect(page.getByTestId("tickets-summary-card")).toBeVisible({ timeout: 10000 })
  // The summary renders folded by default; only an explicit expand opens it.
  await expect(page.getByTestId("tickets-summary-card")).toHaveAttribute("data-collapsed", "true")
  await page.getByTestId("tickets-summary-toggle").click()
  await expect(page.getByTestId("tickets-summary-card")).toHaveAttribute("data-collapsed", "false")
  await page.getByTestId("tickets-summary-toggle").click()
  await expect(page.getByTestId("tickets-summary-card")).toHaveAttribute("data-collapsed", "true")
})
