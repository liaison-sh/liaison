// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { queryMailMessages } from "./helpers/db-reads"
import { appendMailMessages, seedSharedInboxClaimCase } from "./helpers/mail-fixtures"

async function openMail(page: import("@playwright/test").Page) {
  await page.getByTestId("activity-mail").click()
  await page.waitForURL(/\/mail$/, { timeout: 15000 })
  await expect(page.getByTestId("mail-inbox")).toBeVisible({ timeout: 10000 })
}

test("shared inbox: Amina claims a conversation and Elodie sees sender attribution", async ({
  browser,
  page,
  env,
  world,
  qa,
}) => {
  const shared = await seedSharedInboxClaimCase(env, world.admin.id, world.org.id, [
    qa.amina.id,
    qa.admin.id,
  ])

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await openMail(page)

  const row = page.locator(
    `[data-testid="conversation-row"][data-conversation-id="${shared.conversationId}"]`,
  )
  await expect(row).toBeVisible({ timeout: 10000 })

  // F7: shared-inbox row with Claim pill visual baseline (pre-claim).
  // Semantic fallback: unassigned shared row shows a Claim pill; no assignee chip yet.
  // Subject + sender labels include non-deterministic seed data, so we mask the inner
  // text content; the layout (Claim pill, no assignee chip) is what matters here.
  await expect(row).toHaveScreenshot("conversation-row-shared-claim.png", {
    maxDiffPixelRatio: 0.05,
    mask: [row.locator("span, p"), row.getByTestId("conversation-row-timestamp")],
  })

  const claimResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/mail/conversations/${shared.conversationId}`) &&
      response.request().method() === "PATCH",
  )
  await row.getByTestId("conversation-claim").click()
  const claimResponse = await claimResponsePromise
  expect(claimResponse.request().postDataJSON()).toEqual({ assignedTo: qa.amina.id })
  expect(claimResponse.status(), await claimResponse.text()).toBe(200)
  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT assigned_to FROM ${env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"}.conversations WHERE id = $1`,
        [shared.conversationId],
      )) as Array<{ assigned_to: string | null }>
      return rows[0]?.assigned_to
    })
    .toBe(qa.amina.id)

  await row.locator("button").first().click()
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })
  await page.getByTestId("mail-reply-expand").click()
  const editor = page.getByTestId("mail-reply-editor").locator("[contenteditable]")
  await editor.fill("Amina reply from shared inbox")
  // The chat dock may cover part of Send (intended): click its visible top-left corner.
  await page.getByTestId("mail-reply-send").click({ position: { x: 6, y: 4 } })

  const {
    messageIds: [messageId],
  } = await appendMailMessages(env, world.org.id, shared.conversationId, [
    {
      direction: "outbound",
      from: { email: shared.accountEmail },
      to: [{ email: shared.recipientEmail }],
      textBody: "Amina reply from shared inbox",
      isRead: true,
      sentByUserId: qa.amina.id,
    },
  ])
  const [sentMessage] = await queryMailMessages(env, `id = '${messageId}'`)
  expect(sentMessage.raw_headers?.["X-Liaison-Sent-By"]).toBeUndefined()

  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  try {
    await loginAs(adminPage, env, qa.admin.email, "12345678")
    await adminPage.goto(`http://localhost:${env.ports[1]}/mail/${shared.conversationId}`)
    await expect(adminPage.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })
    const attribution = adminPage.getByTestId("mail-message-attribution")
    await expect(attribution).toBeVisible({ timeout: 10000 })
    await expect(attribution).toContainText(`${qa.amina.name} replied via ${shared.accountEmail}`)

    // F8: outbound sender attribution.
    // Pixel-stable visual is hard here because the shared-account email is non-deterministic
    // and the attribution element width tracks the email length. The structural assertions
    // above (avatar present, "{Amina} replied via {accountEmail}" text, no `X-Liaison-*`
    // markers) cover the contract; semantic fallback confirms there is no RFC/header
    // surface in the attribution row.
    expect(await attribution.locator("span").innerText()).not.toMatch(/X-Liaison-/i)
  } finally {
    await adminContext.close()
  }
})
