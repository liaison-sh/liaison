// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { seedSharedInboxClaimCase } from "./helpers/mail-fixtures"

async function freshLoginToken(serverUrl: string, email: string, password: string) {
  const res = await api(serverUrl, "/api/auth/login", { body: { email, password } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data.accessToken as string
}

test("Mail: 'Assigned to me' filters and counts", async ({ page, env, world, qa }) => {
  // Two distinct shared accounts so each gets one conversation; assign one to Amina, one to Lucas.
  const sharedAmina = await seedSharedInboxClaimCase(env, world.admin.id, world.org.id, [
    qa.amina.id,
    qa.lucas.id,
  ])
  const sharedLucas = await seedSharedInboxClaimCase(env, world.admin.id, world.org.id, [
    qa.amina.id,
    qa.lucas.id,
  ])

  // Refresh tokens so the just-granted mail:inbox dimensions show up in RLS.
  const aminaToken = await freshLoginToken(env.serverUrl, qa.amina.email, "QaPass1!")
  const lucasToken = await freshLoginToken(env.serverUrl, qa.lucas.email, "QaPass1!")

  const aminaClaim = await api(
    env.serverUrl,
    `/api/mail/conversations/${sharedAmina.conversationId}`,
    {
      method: "PATCH",
      token: aminaToken,
      body: { assignedTo: qa.amina.id },
    },
  )
  expect(aminaClaim.status, JSON.stringify(aminaClaim.body)).toBe(200)
  const lucasClaim = await api(
    env.serverUrl,
    `/api/mail/conversations/${sharedLucas.conversationId}`,
    {
      method: "PATCH",
      token: lucasToken,
      body: { assignedTo: qa.lucas.id },
    },
  )
  expect(lucasClaim.status, JSON.stringify(lucasClaim.body)).toBe(200)

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.getByTestId("activity-mail").click()
  await expect(page.getByTestId("mail-inbox")).toBeVisible({ timeout: 10000 })
  await page.getByTestId("mail-sidebar-assigned-to-me").click()

  const aminaRow = page.locator(
    `[data-testid="conversation-row"][data-conversation-id="${sharedAmina.conversationId}"]`,
  )
  const lucasRow = page.locator(
    `[data-testid="conversation-row"][data-conversation-id="${sharedLucas.conversationId}"]`,
  )

  await expect(aminaRow).toBeVisible({ timeout: 10000 })
  await expect(lucasRow).toHaveCount(0)

  // Claim pill is hidden for rows already assigned to current user
  await expect(aminaRow.getByTestId("conversation-claim")).toHaveCount(0)

  // Sidebar count should reflect Amina's unread assigned rows (≥ 1).
  const sidebarItem = page.getByTestId("mail-sidebar-assigned-to-me")
  await expect(sidebarItem).toContainText("1")
})
