// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { attachMailToContact, resolveContact } from "./helpers/contacts-seed"
import { freshAccessToken } from "./helpers/fresh-token"
import { seedMailBaseline } from "./helpers/mail-fixtures"

test("EntityPreview: mail conversation backlink hover from contact detail", async ({
  page,
  env,
  world,
  qa,
}, testInfo) => {
  const baseline = await seedMailBaseline(env, qa.admin.id, world.org.id)
  const unique = `backlink-${testInfo.workerIndex}-${Date.now()}`
  // Permission_version drift from earlier tests in the same worker would 401
  // this seed via the cached `qa.admin.token`.
  const adminToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const contact = await resolveContact(env, adminToken, {
    email: `${unique}@e2e.test`,
    name: "Backlink Contact",
    company: "Backlink Co",
    externalId: { e2e: unique },
  })
  const subject = `Backlink Subject ${unique}`
  const { conversationId } = await attachMailToContact(
    env,
    world.org.id,
    contact.id,
    baseline.account.id,
    subject,
  )

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/contacts/${contact.id}`)
  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })

  const backlink = page.getByTestId(`contact-backlink-${conversationId}`)
  await expect(backlink).toBeVisible({ timeout: 10000 })
  await expect(backlink).toContainText(subject)

  const fetchPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/mail/conversations/${conversationId}`) &&
      response.url().includes("messageLimit=0"),
  )
  await backlink.hover()
  const fetchResponse = await fetchPromise
  expect(fetchResponse.status()).toBe(200)
  const fetchBody = await fetchResponse.json()
  expect(fetchBody.data?.conversation?.subject).toBe(subject)

  const previewContent = page.getByTestId("entity-preview-content")
  await expect(previewContent).toBeVisible({ timeout: 2500 })

  await page.mouse.move(0, 0)
  await expect(previewContent).toBeHidden({ timeout: 2000 })

  await backlink.click()
  await page.waitForURL(new RegExp(`/mail/${conversationId}`), {
    timeout: 10000,
  })
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })
})
