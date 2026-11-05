// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"
import { waitForMentionIndex } from "./helpers/wait-for-mention"

test("approval mention inserts a request pill and opens the discussion thread", async ({
  page,
  env,
  world,
}) => {
  const requester = await createApprovalActor(world, {
    name: "Mention Requester",
    scopes: ["test:gated:write"],
  })
  const viewer = await createApprovalActor(world, {
    name: "Mention Viewer",
    scopes: ["test:gated:write", "test:approve"],
  })
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: requester.id,
    participantUserIds: [viewer.id, requester.id],
    approverUserIds: [viewer.id],
    title: "Mention approval E2E",
    toolCallMessage: true,
    mention: true,
  })
  const rawRef = `kernel:approval_request:${seeded.approvalRequestId}`

  // Phase 10: mentions are Meili-backed. The approval_request document is
  // indexed asynchronously after seeding, so we must poll /api/mentions before
  // typing into the composer. Without this, the popup opens against an empty
  // index and the approval pill never appears.
  const indexed = await waitForMentionIndex({
    serverUrl: env.serverUrl,
    token: viewer.token,
    query: seeded.handle,
    type: "entity",
    predicate: (r) => String(r.id ?? "") === String(seeded.approvalRequestId),
  })
  expect(indexed, "Meili must surface the seeded approval request via /api/mentions").not.toBeNull()

  await loginAs(page, env, viewer.email, viewer.password)
  await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

  // Mention autocomplete can include pending approvals from earlier tests in
  // the same worker; pick this scenario's handle explicitly.
  const editor = page.getByTestId("compose-editor")
  await editor.click()
  // An approval request is an entity: `#` references it (`@` completes people
  // and agents only). Its chip keeps the handle's own `@` below.
  await page.keyboard.type(`#${seeded.handle}`)
  await expect(page.getByTestId("mention-autocomplete")).toBeVisible({ timeout: 10000 })
  const approvalResult = page
    .getByTestId("mention-result-approval_request")
    .filter({ hasText: seeded.handle })
    .first()
  await expect(approvalResult).toBeVisible({ timeout: 5000 })
  await approvalResult.click()

  await expect(editor.locator(`[data-mention-ref="${rawRef}"]`)).toBeVisible()
  await page.getByTestId("compose-send").click()

  const sentPill = page.locator(`[data-mention-ref="${rawRef}"]`).last()
  await expect(sentPill).toBeVisible({ timeout: 10000 })
  await expect(sentPill).toContainText(`@${seeded.handle}`)

  await sentPill.click()
  await expect(page).toHaveURL(new RegExp(`/threads/${seeded.threadId}`), {
    timeout: 10000,
  })
  // The pill opens the conversation the request was made in; its card is in
  // the agent's tool-call row there.
  const activeTab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await activeTab.getByTestId("message-row-tools-toggle").first().click()
  await expect(
    activeTab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    ),
  ).toBeVisible()
})
