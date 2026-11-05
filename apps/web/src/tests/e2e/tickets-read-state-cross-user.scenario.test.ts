// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-read-state-cross-user — verifies org-global read-by behavior:
// when one user marks read, a second user sees them in the read-by list,
// and a new inbound message flips the row back to unread for everyone.
import { expect, loginAs, test } from "./fixtures/test"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC2][SC3][SC14] tickets-read-state-cross-user: read-by reflects another user, inbound flips back to unread", async ({
  browser,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${Date.now()}`,
    emailAddress: `cross-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Cross-user ${Date.now()}`,
    sourceInboxId: inbox.id,
  })

  // QA users only carry kernel/mail scopes by default — grant Amina tickets read so
  // she can see and mark-read this ticket through the real RLS path.
  await grantTicketsScopes(env, orgId, qa.amina.id)

  // Elodie (admin) opens and reads the ticket. Use a dedicated context so
  // localStorage is fresh (the read-state contract is org-global, not browser-local).
  const aminaCtx = await browser.newContext()
  const aminaPage = await aminaCtx.newPage()
  try {
    await loginAs(aminaPage, env, qa.amina.email, "QaPass1!")
    await aminaPage.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(aminaPage.getByTestId("tickets-detail")).toBeVisible({ timeout: 15000 })
    await expect
      .poll(async () => {
        const rows = await env.db.sql.unsafe(
          `SELECT user_id::text AS user_id FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1`,
          [ticket.id],
        )
        return rows.length
      })
      .toBeGreaterThan(0)
  } finally {
    await aminaCtx.close()
  }

  // Elodie opens the ticket in a fresh context. He should see Amina in the read-by list,
  // and the row should NOT be flagged unread because Amina already marked read.
  const lucasCtx = await browser.newContext()
  const lucasPage = await lucasCtx.newPage()
  try {
    await loginAs(lucasPage, env, qa.admin.email, "12345678")
    await lucasPage.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(lucasPage.getByTestId("tickets-detail")).toBeVisible({ timeout: 15000 })
    // Read-by list lives inside a popover triggered from the avatar stack pill.
    // Open the popover by clicking the "Read by N" trigger, then assert the list.
    const readByTrigger = lucasPage.locator('button[title^="Read by"]').first()
    await expect(readByTrigger).toBeVisible({ timeout: 10000 })
    await readByTrigger.click()
    await expect(lucasPage.getByTestId("tickets-readby-list")).toBeVisible({ timeout: 10000 })
    await expect(lucasPage.getByTestId(`tickets-readby-item-${qa.amina.id}`)).toBeVisible()
    // Close popover before continuing so it doesn't intercept clicks elsewhere.
    await lucasPage.keyboard.press("Escape")

    // Wait for Elodie's read state to commit before inserting the inbound —
    // mark-read is debounced on mount and posts asynchronously, so we need his
    // read_at to land BEFORE last_inbound_at to make the unread flip deterministic.
    await expect
      .poll(async () => {
        const rows = (await env.db.sql.unsafe(
          `SELECT 1 AS ok FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1 AND user_id = $2`,
          [ticket.id, qa.admin.id],
        )) as Array<{ ok: number }>
        return rows.length
      })
      .toBeGreaterThan(0)

    // Append a new inbound message to the seeded ticket and bump last_inbound_at.
    // This simulates a fresh customer reply landing on the ticket.
    await env.db.sql.unsafe(
      `INSERT INTO ${ts(env)}.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'inbound', 'follow-up', now(), now(), now())`,
      [orgId, ticket.id],
    )
    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets SET last_inbound_at = now(), last_message_at = now() WHERE id = $1`,
      [ticket.id],
    )

    // Elodie navigates to the inbox and the row should now be unread.
    await lucasPage.goto(`http://localhost:${env.ports[1]}/tickets`)
    await expect(lucasPage.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
    await expect(lucasPage.getByTestId(`tickets-list-row-${ticket.id}`)).toHaveAttribute(
      "data-unread",
      "true",
      { timeout: 15000 },
    )
  } finally {
    await lucasCtx.close()
  }
})
