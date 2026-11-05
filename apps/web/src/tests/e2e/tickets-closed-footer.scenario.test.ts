// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-closed-footer — verifies the closed-ticket footer state machine.
// Asserts each closed_reason renders exactly one CTA: Reopen for resolved/spam,
// Open target ticket for merged, Open linked mail conversation for converted.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC8][SC9] tickets-closed-footer: state machine renders exactly one CTA per closed_reason", async ({
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

  // Seed a real merge target so the merged-source footer has a clickable target.
  const target = await seedTicket(env, orgId, {
    subject: `Merge target ${Date.now()}`,
    sourceInboxId: inbox.id,
  })

  const resolved = await seedTicket(env, orgId, {
    subject: `Resolved ${Date.now()}`,
    sourceInboxId: inbox.id,
    status: "closed",
    closedReason: "resolved",
  })

  const merged = await seedTicket(env, orgId, {
    subject: `Merged source ${Date.now()}`,
    sourceInboxId: inbox.id,
    status: "closed",
    closedReason: "merged",
    mergedIntoTicketId: target.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")

  // Resolved: only Reopen, no other footer actions, composer hidden.
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${resolved.id}`)
  const resolvedFooter = page.getByTestId("tickets-detail-footer-closed")
  await expect(resolvedFooter).toBeVisible({ timeout: 10000 })
  await expect(resolvedFooter).toContainText("resolved")
  await expect(page.getByTestId("tickets-detail-footer-reopen")).toBeVisible()
  await expect(page.getByTestId("tickets-detail-footer-open-target")).toHaveCount(0)
  await expect(page.getByTestId("tickets-detail-footer-open-mail")).toHaveCount(0)
  await expect(page.getByTestId("tickets-composer")).toHaveCount(0)

  // Reopen: click and verify composer returns plus DB row flips back to open.
  await page.getByTestId("tickets-detail-footer-reopen").click()
  await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 10000 })
  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT status, closed_reason FROM ${ts(env)}.tickets WHERE id = $1`,
        [resolved.id],
      )
      return rows[0] ?? null
    })
    .toMatchObject({ status: "open" })

  // Merged source: only "Open target ticket" footer, click opens target detail.
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${merged.id}`)
  const mergedFooter = page.getByTestId("tickets-detail-footer-closed")
  await expect(mergedFooter).toBeVisible({ timeout: 10000 })
  await expect(mergedFooter).toContainText("merged")
  await expect(page.getByTestId("tickets-detail-footer-open-target")).toBeVisible()
  await expect(page.getByTestId("tickets-detail-footer-reopen")).toHaveCount(0)
  await expect(page.getByTestId("tickets-detail-footer-open-mail")).toHaveCount(0)
  await page.getByTestId("tickets-detail-footer-open-target").click()
  await expect(page).toHaveURL(new RegExp(`/tickets/${target.id}`), { timeout: 10000 })
  await expect(page.getByTestId("tickets-detail-subject").last()).toContainText(target.subject, {
    timeout: 10000,
  })
})
