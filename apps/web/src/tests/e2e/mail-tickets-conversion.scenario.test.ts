// SPDX-License-Identifier: FSL-1.1-ALv2
// mail-tickets-conversion — verifies the Mail conversation slot hosts a
// "Convert to ticket" action.
import { expect, loginAs, test } from "./fixtures/test"
import { seedMailBaseline } from "./helpers/mail-fixtures"
import { seedInbox } from "./helpers/seed"

function ms(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC10] mail-tickets-conversion: convert-to-ticket action creates an escalated ticket", async ({
  page,
  env,
  qa,
  world,
}) => {
  const mail = await seedMailBaseline(env, world.admin.id, world.org.id)
  const inbox = await seedInbox(env, world.org.id, {
    name: `Mail conversion ${Date.now()}`,
    emailAddress: `conversion-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const conversationId = mail.conversations.unreadStarredHtml.id

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-mail").click()
  await expect(page.getByTestId("mail-inbox")).toBeVisible({ timeout: 10000 })

  const row = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator("button").first().click()
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("mail-convert-banner")).toBeVisible()
  await expect(page.getByTestId("mail-convert-action-button")).toBeVisible()

  await page.getByTestId("mail-convert-action-button").click()
  await expect(page.getByTestId("mail-convert-to-ticket-dialog")).toBeVisible()
  await page.getByTestId("mail-convert-inbox").selectOption(inbox.id)
  await page.getByTestId("mail-convert-priority").selectOption("high")
  await page.getByTestId("mail-convert-note").fill("Escalated from E2E")
  await page.getByTestId("mail-convert-submit").click()

  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT t.id, t.source_conversation_id, c.status, c.escalated_ticket_id
         FROM ${ts(env)}.tickets t
         JOIN ${ms(env)}.conversations c ON c.id = t.source_conversation_id
         WHERE t.source_conversation_id = $1`,
        [conversationId],
      )
      return rows[0]?.status ?? null
    })
    .toBe("escalated")
  const [converted] = await env.db.sql.unsafe(
    `SELECT t.id, t.source_conversation_id, c.status, c.escalated_ticket_id
     FROM ${ts(env)}.tickets t
     JOIN ${ms(env)}.conversations c ON c.id = t.source_conversation_id
     WHERE t.source_conversation_id = $1`,
    [conversationId],
  )
  expect(converted?.source_conversation_id).toBe(conversationId)
  expect(converted?.status).toBe("escalated")
  expect(converted?.escalated_ticket_id).toBe(converted?.id)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
})
