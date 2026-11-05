// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-read-state — opening a ticket flips it from unread→read
// and increments the org-global readByCount.
import type { WorkerEnv } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

/** How many people have read the ticket: its read marks, as the list's readByCount counts them. */
async function ticketReadCount(env: WorkerEnv, ticketId: string): Promise<number> {
  const schema = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
  const rows = (await env.db.sql.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${schema}.ticket_reads WHERE ticket_id = $1`,
    [ticketId],
  )) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

test("[SC2][SC3][SC14] tickets-read-state: opening a ticket marks it read for the actor", async ({
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
    subject: `Unread ${Date.now()}`,
    sourceInboxId: inbox.id,
  })
  expect(await ticketReadCount(env, t.id)).toBe(0)

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })
  // Wait for the row to render first; the unread state is asserted through a
  // stable data attribute so the test is not brittle to badge styling.
  await expect(page.getByTestId(`tickets-list-row-${t.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${t.id}`)).toHaveAttribute("data-unread", "true")
  await page.getByTestId(`tickets-list-row-${t.id}`).click()
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })

  await expect.poll(async () => ticketReadCount(env, t.id)).toBeGreaterThan(0)
})
