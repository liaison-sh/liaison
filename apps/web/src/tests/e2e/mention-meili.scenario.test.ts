// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 PW-2] Meili-backed mention autocomplete — full UI assertion per
// `15-phase-10-e2e-plan.md` §[P10-PW-2]. The composer's `@` trigger resolves
// both user and thread mentions via `/api/mentions` (Meili-backed); inserted
// pills carry a structured `data-mention-ref`; and the sent message preserves
// both pills. Uses `@` for both targets because the QA seed creates threads
// (not standalone manifest entities), and the `@` trigger has no type filter.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { openMessages } from "./helpers/new-conversation"

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  })
  await page.waitForTimeout(ms)
}

test("mention.meili-user-and-entity-suggestions", async ({ page, env, qa }) => {
  // 1. Wait for the Meili indexer to surface Amina and the Sprint thread.
  //    Indexer is async (user:registered / thread:create → outbox → durable
  //    consumer → BullMQ → Meili addDocuments). Bounded poll, 30 s budget.
  const headers = { Authorization: `Bearer ${qa.admin.token}` }
  const deadline = Date.now() + 30_000
  let aminaId: string | null = null
  let threadHit: { id: string; label: string } | null = null
  while (Date.now() < deadline && (!aminaId || !threadHit)) {
    const res = await fetch(`${env.serverUrl}/api/mentions?q=am&limit=10`, { headers }).catch(
      () => null,
    )
    if (res?.status === 200) {
      const body = (await res.json().catch(() => null)) as { data?: any[] } | null
      const amina = body?.data?.find(
        (r) => r?.type === "user" && /amina/i.test(String(r?.label ?? "")),
      )
      if (amina?.id) aminaId = String(amina.id)
    }
    if (!threadHit) {
      const res2 = await fetch(`${env.serverUrl}/api/mentions?q=Sprint&limit=10`, {
        headers,
      }).catch(() => null)
      if (res2?.status === 200) {
        const body = (await res2.json().catch(() => null)) as { data?: any[] } | null
        const hit = body?.data?.find(
          (r) => r?.type === "thread" && /sprint/i.test(String(r?.label ?? "")),
        )
        if (hit?.id) threadHit = { id: String(hit.id), label: String(hit.label) }
      }
    }
    if (!aminaId || !threadHit) await new Promise((r) => setTimeout(r, 250))
  }
  expect(aminaId, "Meili must surface Amina via /api/mentions").not.toBeNull()
  expect(threadHit, "Meili must surface a Sprint thread via /api/mentions").not.toBeNull()

  await loginAs(page, env, "admin@test.com", "12345678")

  // 2. Open a thread Elodie participates in.
  // Threads are listed under Messages since D21, not in Home's sidebar.
  await openMessages(page)
  const sidebarThread = page.getByTestId("thread-item").first()
  await expect(sidebarThread).toBeVisible({ timeout: 10_000 })
  await sidebarThread.click()

  const composer = page.getByTestId("compose-editor")
  await expect(composer).toBeVisible({ timeout: 10_000 })
  await composer.click()

  // 3. Type a specific `@amina` query. Broad prefixes like `@al` are
  // suite-state dependent once other tests create additional matching users.
  await page.keyboard.type("@amina", { delay: 50 })
  const popup = page.getByTestId("mention-autocomplete")
  await expect(popup).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("mention-autocomplete-unavailable")).toHaveCount(0)
  await expect(popup.getByText(/Amina/).first()).toBeVisible({ timeout: 5_000 })

  // [V9] Mention popup open — captured with the user suggestion list visible.
  await settle(page)
  // The popup opens ABOVE the composer card, never over the line being typed.
  const popupBox = await popup.boundingBox()
  const fieldBox = await composer.boundingBox()
  expect(popupBox && fieldBox).toBeTruthy()
  expect((popupBox?.y ?? 0) + (popupBox?.height ?? 0)).toBeLessThanOrEqual(fieldBox?.y ?? 0)
  await expect(popup).toHaveScreenshot("mention-popup-user.png", {
    maxDiffPixelRatio: 0.05,
  })

  // 4. Insert Amina via Enter. Pill carries the structured `user:<uuid>` ref.
  await page.keyboard.press("Enter")
  await expect(popup).toBeHidden({ timeout: 3_000 })
  const aminaRef = await composer
    .locator("[data-mention-ref]")
    .first()
    .getAttribute("data-mention-ref")
  expect(aminaRef, "Amina pill must carry the structured user ref").toMatch(
    new RegExp(`user:${aminaId}`),
  )

  // 5. Continue typing a channel reference via `#` (`@` completes people and
  //    agents only). Cursor sits after the pill + trailing space, so a fresh
  //    `#Sprint` token triggers a new search.
  await page.keyboard.type("#Sprint", { delay: 50 })
  await expect(popup).toBeVisible({ timeout: 10_000 })
  await expect(popup.getByText(new RegExp(threadHit!.label, "i")).first()).toBeVisible({
    timeout: 5_000,
  })

  // 6. Insert the thread mention. Two pills now live in the editor.
  await page.keyboard.press("Enter")
  await expect(popup).toBeHidden({ timeout: 3_000 })
  await expect(composer.locator("[data-mention-ref]")).toHaveCount(2)

  // 7. Send the message. The rendered message keeps both mention pills.
  await page.getByTestId("compose-send").click()
  const tabContent = page.locator("[data-testid='tab-content-area']")
  const lastMessage = tabContent.getByTestId("message-row").last()
  await expect(lastMessage).toBeVisible({ timeout: 10_000 })
  await expect(lastMessage.locator("[data-mention-ref]")).toHaveCount(2)

  // 8. Negative: an unknown prefix produces no result rows. Popup either hides
  //    (zero-result branch) or stays open with no result/test ids.
  await composer.click()
  await page.keyboard.type("@zzz_nomatch", { delay: 50 })
  await page.waitForTimeout(800)
  const popupCount = await popup.count()
  if (popupCount > 0) {
    await expect(popup.locator("[data-testid^='mention-result-']")).toHaveCount(0)
  }
})
