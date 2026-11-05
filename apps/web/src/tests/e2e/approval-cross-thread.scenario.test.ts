// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("an approval lives on its originating thread, with no discussion thread anywhere", async ({
  browser,
  env,
  world,
}) => {
  // Purpose-built users so the requester does NOT hold the approve scope and the
  // approver-only path is exercised through the real WS + UI surface.
  const requester = await createApprovalActor(world, {
    name: "CrossThread Requester",
    scopes: ["test:gated:write"],
  })
  const approver = await createApprovalActor(world, {
    name: "CrossThread Approver",
    scopes: ["test:gated:write", "test:approve"],
  })
  // No `crossThread` flag: an approval lives on the thread it was raised from,
  // for its whole life. There is no discussion thread for an approval any more.
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: requester.id,
    participantUserIds: [approver.id, requester.id],
    approverUserIds: [approver.id],
    title: "Cross-thread approval E2E",
    toolCallMessage: true,
    mention: true,
  })

  const requesterCtx = await browser.newContext()
  const approverCtx = await browser.newContext()
  const requesterPage = await requesterCtx.newPage()
  const approverPage = await approverCtx.newPage()
  try {
    await loginAs(requesterPage, env, requester.email, requester.password)
    await loginAs(approverPage, env, approver.email, approver.password)

    // Requester opens the originating thread and sees the inline card without Approve.
    await requesterPage.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const requesterTab = requesterPage.locator(
      '[data-testid="tab-content-area"] > [data-tab-active="true"]',
    )
    await requesterTab.getByTestId("message-row-tools-toggle").first().click()
    const requesterCard = requesterTab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(requesterCard).toBeVisible({ timeout: 10000 })
    await expect(requesterCard.getByTestId("approval-card-action-approve")).toHaveCount(0)
    await expect(requesterCard.getByTestId("approval-card-action-deny")).toBeVisible()
    await expect(requesterCard.getByTestId("approval-card-action-edit")).toBeVisible()

    // Approver opens the SAME originating thread — no separate approval thread
    // exists for them to be routed to.
    await approverPage.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const approverTab = approverPage.locator(
      '[data-testid="tab-content-area"] > [data-tab-active="true"]',
    )
    await approverTab.getByTestId("message-row-tools-toggle").first().click()
    const approverCard = approverTab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(approverCard.getByTestId("approval-card-action-approve")).toBeVisible({
      timeout: 60000,
    })

    // No approval-anchor thread was created for this request, and none can be:
    // the Discuss control is gone from the card entirely.
    const anchorRows = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks(env.schemaPrefix)}.threads
       WHERE org_id = $1 AND type = 'approval'
         AND created_from->>'entityId' = $2`,
      [world.org.id, seeded.approvalRequestId],
    )) as Array<{ id: string }>
    expect(anchorRows).toHaveLength(0)
    await expect(approverCard.getByTestId("approval-card-discuss")).toHaveCount(0)
    await expect(requesterCard.getByTestId("approval-card-discuss")).toHaveCount(0)

    // The approval's surface thread is, and stays, the originating thread.
    const [approvalRow] = (await env.db.sql.unsafe(
      `SELECT thread_id, originating_thread_id FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
      [seeded.approvalRequestId],
    )) as Array<{ thread_id: string; originating_thread_id: string }>
    expect(approvalRow.thread_id).toBe(seeded.threadId)
    expect(approvalRow.originating_thread_id).toBe(seeded.threadId)

    // Approve from the approver's own inline card on that same thread.
    await approverCard.getByTestId("approval-card-action-approve").click()
    await expect(approverCard.getByTestId("approval-card-status-badge")).toContainText("Approved", {
      timeout: 15000,
    })

    // Convergence: the requester's card transitions to Approved without a
    // reload.
    await expect(requesterCard.getByTestId("approval-card-status-badge")).toContainText(
      "Approved",
      { timeout: 15000 },
    )
    await expect(
      requesterTab.getByTestId("message-row-system-decision").filter({ hasText: approver.name }),
    ).toBeVisible({ timeout: 15000 })
  } finally {
    await requesterCtx.close()
    await approverCtx.close()
  }
})
