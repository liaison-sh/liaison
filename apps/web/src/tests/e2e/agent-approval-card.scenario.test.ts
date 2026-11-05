// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"

/** decision-queue.ts UNDO_WINDOW_MS: a decision is posted once this window has passed. */
const UNDO_WINDOW_MS = 5_000

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

const SELF_APPROVER_SCOPES = ["test:gated:write", "test:approve"]

function activeTabLocator(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
}

async function openCard(
  page: import("@playwright/test").Page,
  approvalRequestId: string,
): Promise<import("@playwright/test").Locator> {
  const tab = activeTabLocator(page)
  await tab.getByTestId("message-row-tools-toggle").first().click()
  const card = tab.locator(`[data-testid="approval-card"][data-request-id="${approvalRequestId}"]`)
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

test("agent approval card approve transitions live via WS update", async ({ page, env, world }) => {
  const actor = await createApprovalActor(world, {
    name: "Agent Approver",
    scopes: SELF_APPROVER_SCOPES,
  })
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: actor.id,
    participantUserIds: [actor.id],
    approverUserIds: [actor.id],
    title: "Agent approval approve E2E",
    toolCallMessage: true,
  })

  await loginAs(page, env, actor.email, actor.password)
  await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

  const card = await openCard(page, seeded.approvalRequestId)
  await expect(card.getByTestId("approval-card-action-approve")).toBeVisible()
  await card.getByTestId("approval-card-action-approve").click()
  // Approve waits out the Undo window before it is sent (decision-queue.ts):
  // the card hides at once and the toast counts the window down. It comes
  // back once the decision is posted, and the WS update carries it to
  // Approved without a reload. The executing state between the two is too
  // brief to pin once the decision is sent after the window.
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId("decision-toast-countdown")).toBeVisible()
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: UNDO_WINDOW_MS + 15000,
  })
  await expect(card.getByTestId("approval-card-action-approve")).toHaveCount(0)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT status FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
        [seeded.approvalRequestId],
      )) as Array<{ status: string }>
      return rows[0]?.status
    })
    .toBe("approved")
})

test("agent approval card deny submits a reason and reflects denied state", async ({
  page,
  env,
  world,
}) => {
  const actor = await createApprovalActor(world, {
    name: "Agent Denier",
    scopes: SELF_APPROVER_SCOPES,
  })
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: actor.id,
    participantUserIds: [actor.id],
    approverUserIds: [actor.id],
    title: "Agent approval deny E2E",
    toolCallMessage: true,
  })

  await loginAs(page, env, actor.email, actor.password)
  await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

  const card = await openCard(page, seeded.approvalRequestId)
  await card.getByTestId("approval-card-action-deny").click()

  const reasonInput = card.getByTestId("approval-card-deny-reason")
  await expect(reasonInput).toBeVisible()
  // The reason is optional: submit is enabled even before anything is typed.
  await expect(card.getByTestId("approval-card-action-deny-submit")).toBeEnabled()

  await reasonInput.fill("Needs revision")
  await card.getByTestId("approval-card-action-deny-submit").click()

  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Denied", {
    timeout: 15000,
  })

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT status, reason FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
        [seeded.approvalRequestId],
      )) as Array<{ status: string; reason: string | null }>
      return `${rows[0]?.status}:${rows[0]?.reason}`
    })
    .toBe("denied:Needs revision")
})

test("agent approval card edit save approve persists edited payload before handler", async ({
  page,
  env,
  world,
}) => {
  const actor = await createApprovalActor(world, {
    name: "Agent Editor",
    scopes: SELF_APPROVER_SCOPES,
  })
  const seeded = await seedGatedApproval(env, world.org.id, {
    requesterUserId: actor.id,
    participantUserIds: [actor.id],
    approverUserIds: [actor.id],
    title: "Agent approval edit E2E",
    toolCallMessage: true,
  })

  await loginAs(page, env, actor.email, actor.password)
  await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

  const card = await openCard(page, seeded.approvalRequestId)
  await card.getByTestId("approval-card-action-edit").click()

  const messageInput = card.getByTestId("approval-card-field-message")
  await expect(messageInput).toBeVisible()
  await expect(messageInput).toHaveValue("Please approve this response.")

  await messageInput.fill("Edited body from browser E2E")
  await card.getByTestId("approval-card-action-save").click()

  // Save exits edit mode, returning to pending; the Approve button reappears.
  // The card shows the saved version from the save's own answer, without
  // waiting for the live update, and never reads as changed by someone else.
  await expect(card.getByTestId("approval-card-action-approve")).toBeVisible({ timeout: 10000 })
  await expect(card).toContainText("Edited body from browser E2E")
  await expect(card.getByTestId("approval-card-changed-notice")).toHaveCount(0)
  const decided = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      res.url().endsWith(`/approvals/${seeded.approvalRequestId}/decide`),
    { timeout: UNDO_WINDOW_MS + 15000 },
  )
  await card.getByTestId("approval-card-action-approve").click()
  // Queued behind the Undo window: the card hides at once, and the approve is
  // posted once the window has passed.
  await expect(card).toHaveCount(0)
  expect((await decided).ok()).toBe(true)
  await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
    timeout: UNDO_WINDOW_MS + 15000,
  })

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT current_payload->>'message' AS message FROM ${ks(env.schemaPrefix)}.approval_requests WHERE id = $1`,
        [seeded.approvalRequestId],
      )) as Array<{ message: string | null }>
      return rows[0]?.message
    })
    .toBe("Edited body from browser E2E")

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT external_ref FROM ${ks(env.schemaPrefix)}.approved_handler_executions WHERE approval_request_id = $1`,
        [seeded.approvalRequestId],
      )) as Array<{ external_ref: { synthetic?: boolean } | null }>
      return rows[0]?.external_ref?.synthetic
    })
    .toBe(true)
})
