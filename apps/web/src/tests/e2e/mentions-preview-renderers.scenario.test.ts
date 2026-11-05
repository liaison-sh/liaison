// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S13 Kernel mention preview renderers are registered.
// (e2e-plan §S13, spec §1.4 criterion 21, §3.4 mention pill rendering.)
//
// Seeds a thread containing both `kernel:user:<id>` and `kernel:thread:<id>`
// mention refs, then asserts hover-previews render content for each renderer.

import { api, login } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

test("kernel mention preview renderers cover user + thread refs", async ({ page, env, qa }) => {
  // Other tests in the same worker bump Elodie's permission_version (role
  // assigns/dimension grants). Reissue his token before the seed POST.
  const fresh = await login(env.serverUrl, qa.admin.email, "12345678")
  const adminToken = fresh.accessToken

  // Build a fresh thread Elodie owns; embed two kernel mentions in the
  // initial message so renderer wrap-on-mount executes once.
  const userRef = `kernel:user:${qa.amina.id}`
  // q2Marketing is owned by Elodie in the QA seed — bugCheckout is owned by
  // Amina and does not include Elodie as a participant, so RLS hides it.
  const threadRef = `kernel:thread:${qa.threads.q2Marketing.id}`
  // The marked extension uses @[label](ref) for ALL mentions; the prefix
  // glyph (# vs @) is derived from the ref's app:entityType at render time.
  const initial = `Looping in @[Amina](${userRef}) — see @[q2](${threadRef}) for context.`
  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: adminToken,
    body: {
      forceCreate: true,
      participantIds: [qa.admin.id],
      title: "S13 kernel previews",
      initialMessage: { content: initial },
    },
  })
  expect(threadRes.status, JSON.stringify(threadRes.body)).toBe(200)
  const threadId = threadRes.body.data.id as string

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)

  const userPreview = page
    .locator('[data-testid="entity-preview"]')
    .filter({ has: page.locator(`[data-mention-ref="${userRef}"]`) })
  await expect(userPreview).toBeVisible({ timeout: 15000 })
  await userPreview.hover()
  const previewContent = page.getByTestId("entity-preview-content")
  await expect(previewContent).toContainText("Amina", { timeout: 5000 })
  await page.keyboard.press("Escape")
  await expect(previewContent).toBeHidden({ timeout: 3000 })

  const threadPreview = page
    .locator('[data-testid="entity-preview"]')
    .filter({ has: page.locator(`[data-mention-ref="${threadRef}"]`) })
  await expect(threadPreview).toBeVisible({ timeout: 5000 })
  await threadPreview.hover()
  await expect(previewContent).toContainText("Q2 Marketing", { timeout: 5000 })
})
