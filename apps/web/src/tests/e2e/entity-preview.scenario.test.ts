// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

test("EntityPreview hover, pin, escape, and contact-row click behavior", async ({
  page,
  env,
  qa,
}) => {
  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      participantIds: [qa.admin.id],
      title: "Hans preview thread",
      initialMessage: {
        content: `Follow up with @[Hans Weber](kernel:contact:${qa.contacts.hansPrimary.id}).`,
      },
    },
  })
  expect(threadRes.status, JSON.stringify(threadRes.body)).toBe(200)
  const threadId = threadRes.body.data.id as string

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)

  const mentionPreview = page.locator('[data-testid="entity-preview"]').filter({
    has: page.locator(`[data-mention-ref="kernel:contact:${qa.contacts.hansPrimary.id}"]`),
  })
  await expect(mentionPreview).toBeVisible({ timeout: 10000 })
  await mentionPreview.hover()
  const previewContent = page.getByTestId("entity-preview-content")
  await expect(previewContent).toContainText("hans@acme.de", { timeout: 1500 })

  await mentionPreview.click()
  await page.mouse.move(0, 0)
  await expect(previewContent).toBeVisible()

  // F5: EntityPreview popup visual baseline.
  // Semantic fallback: popover shows contact identity and timeline context;
  // it must not look like a pinned modal or obscure the entire page.
  await expect(previewContent).toHaveScreenshot("entity-preview-contact.png", {
    maxDiffPixelRatio: 0.05,
    mask: [previewContent.locator("[data-relative-time], time, .text-text-tertiary")],
  })

  await page.keyboard.press("Escape")
  await expect(previewContent).toBeHidden({ timeout: 2000 })

  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 10000 })
  const contactsSearchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === "/api/contacts" && url.searchParams.get("query") === "Hans"
  })
  await page.getByTestId("contacts-search").fill("Hans")
  await contactsSearchResponse
  const contactRow = page.getByTestId(`contact-row-${qa.contacts.hansPrimary.id}`)
  await expect(contactRow).toBeVisible()
  const contactPreview = page.locator('[data-testid="entity-preview"]').filter({ has: contactRow })
  await expect(contactPreview).toBeVisible()
  await contactRow.hover()
  await expect(previewContent).toContainText("hans@acme.de", { timeout: 2500 })

  await contactRow.click()
  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })
  await page.mouse.move(0, 0)
  await expect(previewContent).toBeHidden({ timeout: 2000 })
})
