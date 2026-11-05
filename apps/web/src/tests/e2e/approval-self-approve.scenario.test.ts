// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("approval self-approve smoke decides inline on the originating thread", async ({
  page,
  env,
  world,
}) => {
  const selfApprover = await createApprovalActor(world, {
    name: "Self Approver",
    scopes: ["test:gated:write", "test:approve"],
  })
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: selfApprover.id,
    participantUserIds: [selfApprover.id],
    approverUserIds: [selfApprover.id],
    title: "Self approval E2E",
    toolCallMessage: true,
  })

  await loginAs(page, env, selfApprover.email, selfApprover.password)
  await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

  // The card is rendered in multiple keep-alive tabs (Home, originating thread) at
  // once. Scope to the active tab so we click the visible instance.
  const activeTab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await activeTab.getByTestId("message-row-tools-toggle").first().click()

  const card = activeTab.locator(
    `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
  )
  await expect(card).toBeVisible({ timeout: 10000 })
  await expect(card.getByTestId("approval-card-action-approve")).toBeVisible()
  await expect(card.getByTestId("approval-card-action-deny")).toBeVisible()
  await expect(card.getByTestId("approval-card-action-edit")).toBeVisible()

  await card.getByTestId("approval-card-action-approve").click()
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: 15000,
  })

  // The self-approve path keeps the request on the originating thread (no auto-opened approval tab).
  await expect(page).toHaveURL(new RegExp(`/threads/${seeded.threadId}`))
  await expect(page.getByTestId("approval-thread-header")).toHaveCount(0)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT status, thread_id, originating_thread_id FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
        [seeded.approvalRequestId],
      )) as Array<{ status: string; thread_id: string; originating_thread_id: string }>
      const r = rows[0]
      return r ? `${r.status}:${r.thread_id === r.originating_thread_id}` : "missing"
    })
    .toBe("approved:true")
})
