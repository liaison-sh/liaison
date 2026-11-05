// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-needs-attention — the "Needs attention now" filter is keyed on message
// DIRECTION: a ticket where the customer wrote last (ball in our court) shows;
// one we replied to last ("awaiting customer") is hidden. Guards the fix for the
// bug where awaiting-customer tickets leaked into Needs attention.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedOutboundMessage, seedTicket } from "./helpers/seed"

test("needs-attention includes customer-waiting tickets and hides ones we replied to last", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `NA-${stamp}`,
    emailAddress: `na-${stamp}@e2e.test`,
    isDefault: true,
  })
  // A: customer wrote last (seedTicket leaves last_inbound_at set, no outbound) ->
  //    ball in our court -> belongs in Needs attention.
  const waiting = await seedTicket(env, orgId, {
    subject: `Customer waiting ${stamp}`,
    sourceInboxId: inbox.id,
  })
  // B: same, but then WE replied (outbound becomes the last message) -> "awaiting
  //    customer" -> must NOT appear in Needs attention.
  const replied = await seedTicket(env, orgId, {
    subject: `We replied last ${stamp}`,
    sourceInboxId: inbox.id,
  })
  await seedOutboundMessage(env, orgId, replied.id, { textBody: "Thanks, we are on it." })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })

  // Both are open, so both show in "All open work" first.
  await expect(page.getByTestId(`tickets-list-row-${waiting.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${replied.id}`)).toBeVisible({ timeout: 10000 })

  // Switch to Needs attention: the customer-waiting ticket stays, the one we
  // replied to last drops out.
  await page.getByTestId("tickets-filter-needs-attention").click()
  await expect(page.getByTestId(`tickets-list-row-${waiting.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${replied.id}`)).toHaveCount(0)

  // Consolidated sort: Needs attention orders newest-first like every other view
  // (no special oldest-first default that made the dates read as "messed up").
  await expect(page.getByTestId("tickets-filter-chip-sort")).toContainText("Newest first")
})
