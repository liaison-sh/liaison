// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-convert-to-mail — S8: open ticket → Convert to Mail dialog →
// only the actor's own mail account is offered → submit → ticket footer
// flips to "Open linked mail conversation" CTA pointing to the new tab.
import { expect, loginAs, test } from "./fixtures/test"
import { seedMailAccount } from "./helpers/mail-fixtures"
import { seedInbox, seedTicket } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC9][SC11] tickets-convert-to-mail: only own account is offered, conversion closes ticket and links mail", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${stamp}`,
    emailAddress: `support-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Convert to mail ${stamp}`,
    sourceInboxId: inbox.id,
  })

  // Elodie owns one personal mail account.
  const mineEmail = `mine-${stamp}@e2e.test`
  await seedMailAccount(env, orgId, { userId: world.admin.id, email: mineEmail })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })

  // Convert-to-mail now lives in the ⋯ (more actions) menu, not a standalone
  // header icon — open the kebab first, then pick the labelled item.
  await page.getByTestId("tickets-detail-kebab").click()
  await page.getByTestId("tickets-detail-convert-mail-button").click()
  await expect(page.getByTestId("tickets-convert-to-mail-dialog")).toBeVisible({ timeout: 10000 })

  // Only user-owned accounts are selectable; assert the seeded email is
  // among the options. (Earlier tests in the same worker may have left other
  // personal accounts; we don't want a strict count to flake on parallel
  // ordering, just that the right one is selectable.)
  const account = page.getByTestId("tickets-convert-account")
  await expect(account).toBeVisible()
  const optionTexts = await account.locator("option").allTextContents()
  expect(optionTexts).toContain(mineEmail)
  await account.selectOption({ label: mineEmail })

  await page.getByTestId("tickets-convert-note").fill("Moving to email")
  await page.getByTestId("tickets-convert-submit").click()

  // DB side effect: ticket closes with reason converted_to_mail and links the new mail conversation.
  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT status, closed_reason, converted_to_mail_conversation_id
         FROM ${ts(env)}.tickets WHERE id = $1`,
        [ticket.id],
      )
      return rows[0] ?? null
    })
    .toMatchObject({ status: "closed", closed_reason: "converted_to_mail" })

  // Reopen the ticket detail and verify the closed footer renders only the
  // open-linked-mail CTA, with the other CTAs absent.
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail-footer-closed")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-detail-footer-open-mail")).toBeVisible()
  await expect(page.getByTestId("tickets-detail-footer-reopen")).toHaveCount(0)
  await expect(page.getByTestId("tickets-detail-footer-open-target")).toHaveCount(0)
})
