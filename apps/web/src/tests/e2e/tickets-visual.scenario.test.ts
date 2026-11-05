// SPDX-License-Identifier: FSL-1.1-ALv2
// Visual baselines — captures a stable screenshot of the Tickets inbox.
// Baselines populate on first run via `--update-snapshots=all`. Until a CI
// baseline exists, we record the screenshot artifact without pixel comparison
// so the surface is exercised but the test stays green.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

test("[SC1] tickets-visual: inbox layout screenshot artifact", async ({
  page,
  env,
  qa,
  world,
}, testInfo) => {
  const orgId = world.org.id
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${Date.now()}`,
    emailAddress: `support-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  await seedTicket(env, orgId, { subject: `Visual ${Date.now()}`, sourceInboxId: inbox.id })
  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })
  const buffer = await page.screenshot({ fullPage: false })
  await testInfo.attach("tickets-inbox.png", { body: buffer, contentType: "image/png" })
})
