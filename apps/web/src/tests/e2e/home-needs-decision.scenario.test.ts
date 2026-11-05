// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, expireApproval, seedGatedApproval } from "./helpers/approvals-seed"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("home needs decision shows live row, dot, and clears on approve", async ({
  page,
  env,
  world,
}) => {
  const requester = await createApprovalActor(world, {
    name: "Home Requester",
    scopes: ["test:gated:write"],
  })
  const approver = await createApprovalActor(world, {
    name: "Home Approver",
    scopes: ["test:gated:write", "test:approve"],
  })

  await loginAs(page, env, approver.email, approver.password)

  // Open Home and verify it starts empty + no activity-bar dot. Home lands on
  // the attention feed itself (no side pane any more).
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home")).toBeVisible()
  await expect(page.getByTestId("home-empty-state")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("activity-bar-home-dot")).toHaveCount(0)
  await expect(page.getByTestId("activity-bar-home-badge")).toHaveCount(0)

  // The gate announces the new request live, which drives Home.
  const firstCase = await seedGatedApproval(env, world.org.id, {
    requesterUserId: requester.id,
    participantUserIds: [approver.id, requester.id],
    approverUserIds: [approver.id],
    title: "Home decision E2E",
    toolCallMessage: true,
  })

  // Phase 8 reworked Home: the "Needs your decision" section is now a flat
  // attention feed where each item is an AttentionRow keyed by app/entity/id.
  // A decision asked of the viewer counts on the Home icon's badge (the quiet
  // dot is for anything else waiting there; HomeIconWithDot.tsx).
  const homeRowId = `attention-row-kernel-approval_request-${firstCase.approvalRequestId}`
  await expect(page.getByTestId("home-feed")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(homeRowId)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("activity-bar-home-badge")).toHaveText("1")

  // Approve from inside Home via the inline action button on the row. The row
  // hides at once; the decision is posted once the Undo window
  // (decision-queue.ts, 5 s) has passed.
  await page.getByTestId(`${homeRowId}-approve`).click()

  await expect(page.getByTestId("home-empty-state")).toBeVisible({ timeout: 15000 })
  // The decision no longer counts; the quiet dot stays for the conversation's
  // unread messages (the ask and the agent's turn) until it is opened below.
  await expect(page.getByTestId("activity-bar-home-badge")).toHaveCount(0)

  await expect
    .poll(
      async () => {
        const rows = (await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
          [firstCase.approvalRequestId],
        )) as Array<{ status: string }>
        return rows[0]?.status
      },
      { timeout: 20_000 },
    )
    .toBe("approved")

  // Approving inline never opens the originating thread, so it stays unread
  // server-side; the Messages card now folds unread threads into Home's
  // content (D7), so a later reload would resurrect it and keep Home out of
  // the empty state. Visit it once to mark it read, same as the expiry case
  // below.
  await page.goto(`http://localhost:${env.ports[1]}/threads/${firstCase.threadId}`)
  await expect(
    page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]'),
  ).toBeVisible({
    timeout: 10000,
  })

  // Back to Home, which lands on the feed: nothing waits any more.
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("activity-bar-home-dot")).toHaveCount(0)

  // Expiry subtest: another request, then the kernel's expiry job runs on it.
  const expiryCase = await seedGatedApproval(env, world.org.id, {
    requesterUserId: requester.id,
    participantUserIds: [approver.id, requester.id],
    approverUserIds: [approver.id],
    title: "Home expiry E2E",
    toolCallMessage: true,
  })
  const expiryRowId = `attention-row-kernel-approval_request-${expiryCase.approvalRequestId}`
  await expect(page.getByTestId(expiryRowId)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("activity-bar-home-badge")).toHaveText("1")

  // Open the originating thread first so we can assert the Expired badge renders on a card.
  await page.goto(`http://localhost:${env.ports[1]}/threads/${expiryCase.threadId}`)
  const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await tab.getByTestId("message-row-tools-toggle").first().click()
  const inlineCard = tab.locator(
    `[data-testid="approval-card"][data-request-id="${expiryCase.approvalRequestId}"]`,
  )
  await expect(inlineCard).toBeVisible({ timeout: 10000 })

  await expireApproval(env, world.org.id, expiryCase.approvalRequestId)

  await expect(inlineCard.getByTestId("approval-card-status-badge")).toContainText("Expired", {
    timeout: 15000,
  })

  // Re-open Home and confirm the row + dot have cleared after the terminal
  // update.
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home-empty-state")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("activity-bar-home-dot")).toHaveCount(0)
  await expect(page.getByTestId("activity-bar-home-badge")).toHaveCount(0)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
        [expiryCase.approvalRequestId],
      )) as Array<{ status: string }>
      return rows[0]?.status
    })
    .toBe("expired")
})
