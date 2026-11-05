// SPDX-License-Identifier: FSL-1.1-ALv2
// Entity preview -> Open. Clicking an entity mention in a thread opens a preview
// card that shows the entity's info AND an Open action that actually navigates
// to the entity (its own tab). This replaced the earlier Copy/Export JSON
// actions, which had no real use for a support operator ("I can copy the link
// but I can't open the ticket"). Here we drive the real flow end to end: a
// contact mention -> preview -> Open -> the contact detail tab renders.

import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import type { WorkerEnvWithDrive } from "./fixtures/test"
import { expect, loginAs, test } from "./fixtures/test"

/**
 * Navigate to a thread and wait for its message to render, resilient to the
 * shared-fixture race: every phase13 test logs in as the SAME `admin@test.
 * com` on the SAME worker schema, and under `workers:2` two run concurrently.
 * `createSession` enforces a per-user session cap (evicts oldest), so a
 * sibling test's login burst can evict THIS page's session mid-flight — the
 * app then bounces to `/login` and `message-row` never appears. On that
 * bounce we re-login and retry (the session-cap eviction is inherent to the
 * fixture's single-shared-user design, not a product bug). The assertion
 * target (the real thread message renders) is unchanged — only transient
 * session eviction is absorbed.
 */
async function gotoThreadResilient(
  page: Page,
  env: WorkerEnvWithDrive,
  email: string,
  threadId: string,
): Promise<void> {
  const url = `http://localhost:${env.ports[1]}/threads/${threadId}`
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(url)
    try {
      await expect(page.getByTestId("message-row").first()).toBeVisible({
        timeout: 20000,
      })
      return
    } catch (err) {
      // Session evicted by a concurrent same-user login ⇒ bounced to /login.
      // Re-authenticate and retry. Anything else is a real failure.
      if (!page.url().includes("/login") || attempt === 2) throw err
      await loginAs(page, env, email, "12345678")
    }
  }
}

test("entity preview Open button navigates to the entity's tab", async ({ page, env, qa }) => {
  // Reachability: a thread whose message mentions a seeded contact renders an
  // entity-preview for that contact.
  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      participantIds: [qa.admin.id],
      title: "Entity preview open probe thread",
      initialMessage: {
        content: `Ping @[Hans Weber](kernel:contact:${qa.contacts.hansPrimary.id}).`,
      },
    },
  })
  expect(threadRes.status, JSON.stringify(threadRes.body)).toBe(200)
  const threadId = threadRes.body.data.id as string

  await loginAs(page, env, qa.admin.email, "12345678")
  await gotoThreadResilient(page, env, qa.admin.email, threadId)

  const mentionPreview = page.locator('[data-testid="entity-preview"]').filter({
    has: page.locator(`[data-mention-ref="kernel:contact:${qa.contacts.hansPrimary.id}"]`),
  })
  await expect(mentionPreview).toBeVisible({ timeout: 20000 })
  await mentionPreview.click()
  await page.mouse.move(0, 0)

  // 1. The clicked (pinned) preview shows the entity's info AND an Open action.
  const previewContent = page.getByTestId("entity-preview-content")
  await expect(previewContent).toBeVisible({ timeout: 10000 })
  await expect(previewContent).toContainText("Hans Weber")
  const openBtn = page.getByTestId("entity-preview-open")
  await expect(openBtn).toBeVisible({ timeout: 10000 })

  // 2. Clicking Open actually navigates to the contact — its detail tab renders.
  await openBtn.click()
  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })
  await expect(page).toHaveURL(new RegExp(`/contacts/${qa.contacts.hansPrimary.id}`))
})
