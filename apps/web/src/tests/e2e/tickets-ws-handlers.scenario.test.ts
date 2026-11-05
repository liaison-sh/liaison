// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-ws-handlers — S12: queue real outbox events for the Tickets app
// and verify the visible UI updates without reload.
import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import {
  queueTicketInboxUpdated,
  queueTicketMessageCreated,
  queueTicketSummaryUpdated,
} from "./helpers/tickets-events"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC14] tickets-ws-handlers: live message create updates the open ticket stream", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `WS inbox ${stamp}`,
    emailAddress: `ws-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `WS ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-conversation")).toBeVisible()

  // Insert a real message row first (so the WS payload references something real),
  // then queue the corresponding tickets/message:create outbox event.
  const messageId = randomUUID()
  const liveText = `Live inbound ${stamp}`
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'inbound', $4, now(), now(), now())`,
    [messageId, orgId, ticket.id, liveText],
  )
  await queueTicketMessageCreated(env, orgId, ticket.id, {
    id: messageId,
    kind: "inbound",
    textBody: liveText,
  })

  // The conversation stream should show the new message without a reload.
  await expect(page.getByTestId(`tickets-message-${messageId}`)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-message-${messageId}`)).toContainText(liveText)
})

test("[SC6][SC14] tickets-ws-handlers: live summary_updated event refreshes the summary card", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `WS summary ${stamp}`,
    emailAddress: `ws-summary-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `WS summary ${stamp}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-summary-card")).toBeVisible({ timeout: 10000 })
  // The summary renders folded by default; open it so its text is on screen.
  await page.getByTestId("tickets-summary-toggle").click()
  await expect(page.getByTestId("tickets-summary-card")).toHaveAttribute("data-collapsed", "false")

  // Update summary in DB (so subsequent fetches confirm), then emit the live event.
  const summaryText = `Live summary text ${stamp}`
  await env.db.sql.unsafe(
    `UPDATE ${ts(env)}.tickets SET summary_text = $1, summary_status = 'idle', summary_at = now() WHERE id = $2`,
    [summaryText, ticket.id],
  )
  await queueTicketSummaryUpdated(env, orgId, ticket.id, {
    summaryText,
    summaryStatus: "idle",
  })

  await expect(page.getByTestId("tickets-summary-text")).toContainText(summaryText, {
    timeout: 15000,
  })
})

test("[SC14] tickets-ws-handlers: live inbox:update event reflects in sidebar after archive", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `WS inbox archive ${stamp}`,
    emailAddress: `ws-archive-${stamp}@e2e.test`,
    isDefault: true,
  })
  await grantTicketsScopes(env, orgId, qa.admin.id)

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.getByTestId("activity-tickets").click()
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-sidebar-inbox-${inbox.id}`)).toBeVisible({
    timeout: 10000,
  })

  const archivedAt = new Date().toISOString()
  await env.db.sql.unsafe(`UPDATE ${ts(env)}.inboxes SET archived_at = $1 WHERE id = $2`, [
    archivedAt,
    inbox.id,
  ])
  // Small pause to ensure WS subscription is fully armed before queueing the event.
  // Under parallel load, subscription setup can race with event delivery.
  await page.waitForTimeout(500)
  await queueTicketInboxUpdated(env, orgId, { id: inbox.id, archivedAt })

  // Sidebar filters out archived inboxes via `visibleInboxes`. The row should
  // disappear once the WS event lands and the store updates.
  await expect(page.getByTestId(`tickets-sidebar-inbox-${inbox.id}`)).toHaveCount(0, {
    timeout: 30000,
  })
})
