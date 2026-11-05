// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-merge — multi-select + Merge dialog flow.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC9][SC12] tickets-merge: submit merge through inbox UI", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const suffix = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${suffix}`,
    emailAddress: `support-${suffix}@e2e.test`,
    isDefault: true,
  })
  const source = await seedTicket(env, orgId, {
    subject: `Source ${suffix}`,
    sourceInboxId: inbox.id,
  })
  const target = await seedTicket(env, orgId, {
    subject: `Target ${suffix}`,
    sourceInboxId: inbox.id,
  })
  await seedTicketMessages(env, orgId, source.id, [
    { kind: "inbound", textBody: `source chronology ${suffix}`, sentAtOffsetSeconds: -240 },
  ])
  await seedTicketMessages(env, orgId, target.id, [
    { kind: "inbound", textBody: `target chronology ${suffix}`, sentAtOffsetSeconds: -120 },
  ])

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId(`tickets-list-row-${source.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${target.id}`)).toBeVisible({ timeout: 10000 })
  await page.getByTestId(`tickets-row-checkbox-${source.id}`).check()
  await page.getByTestId(`tickets-row-checkbox-${target.id}`).check()
  // Phase 9 replaced the inline merge toolbar with BulkActionToolbar; merge is
  // a manifest-declared bulk action that mounts MergeTicketsForm inline.
  await expect(page.getByTestId("bulk-action-merge")).toBeEnabled()
  await page.getByTestId("bulk-action-merge").click()
  await expect(page.getByTestId("tickets-merge-form")).toBeVisible()
  await page.getByTestId(`tickets-merge-target-${target.id}`).check()
  await page.getByTestId("tickets-merge-note").fill("Merged by E2E UI")
  await page.getByTestId("tickets-merge-form-submit").click()

  // Phase 9 bulk dispatch surfaces "{n} done · {m} failed" in `bulk-outcome`
  // instead of the old "Tickets merged" toast. Aggregate dispatch reports the
  // outcome per-item across the full selection (2 tickets selected → 2 done).
  await expect(page.getByTestId("bulk-outcome")).toContainText("2 done", { timeout: 10000 })
  await expect(page.getByTestId(`tickets-list-row-${source.id}`)).toHaveCount(0, { timeout: 10000 })

  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT status, closed_reason, merged_into_ticket_id FROM ${ts(env)}.tickets WHERE id = $1`,
        [source.id],
      )
      return rows[0] ?? null
    })
    .toMatchObject({ status: "closed", closed_reason: "merged", merged_into_ticket_id: target.id })

  const messages = (await env.db.sql.unsafe(
    `SELECT text_body FROM ${ts(env)}.messages WHERE ticket_id = $1 ORDER BY sent_at ASC, created_at ASC`,
    [target.id],
  )) as Array<{ text_body: string | null }>
  const textBodies = messages.map((m) => m.text_body).filter(Boolean)
  expect(textBodies).toEqual(
    expect.arrayContaining([`source chronology ${suffix}`, `target chronology ${suffix}`]),
  )

  await page.goto(`http://localhost:${env.ports[1]}/tickets?filter=closed`)
  await expect(page.getByTestId(`tickets-list-row-${source.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-row-merged-badge-${source.id}`)).toBeVisible()
})
