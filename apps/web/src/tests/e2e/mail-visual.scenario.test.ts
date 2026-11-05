// SPDX-License-Identifier: FSL-1.1-ALv2
import { test as base, expect, loginAs } from "./fixtures/test"
import {
  type MailBaselineSeed,
  seedMailBaseline,
  setMailProviderEnabled,
} from "./helpers/mail-fixtures"

/** Hides the dock's floating bar before a baseline of a main-panel surface.
 *  The surface keeps the room it leaves for the bar (pb-dock-clearance),
 *  which is what the baseline pins; the bar's pills are whatever the seed's
 *  people happened to send while the page loaded. */
async function hideDockBar(page: import("@playwright/test").Page): Promise<void> {
  await page.addStyleTag({ content: "[data-dock-bar] { visibility: hidden !important; }" })
}

// ─── Fixture extension (read-only baseline only) ───

interface MailWorkerFixtures {
  mail: MailBaselineSeed
}

const test = base.extend<{}, MailWorkerFixtures>({
  mail: [
    async ({ env, world }, use) => {
      const mail = await seedMailBaseline(env, world.admin.id, world.org.id)
      await use(mail)
    },
    { scope: "worker", timeout: 30000 },
  ],
})

// ─── Helper ───

async function openMail(page: import("@playwright/test").Page) {
  const mailEntry = page.getByTestId("activity-mail")
  await expect(mailEntry).toBeVisible({ timeout: 15000 })
  await mailEntry.click()
  await page.waitForURL(/\/mail$/, { timeout: 15000 })
  await expect(page.getByTestId("mail-inbox")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("conversation-row").first()).toBeVisible({ timeout: 10000 })
}

async function settle(page: import("@playwright/test").Page, ms = 500) {
  await page.waitForTimeout(ms)
}

// ─── Visual tests ───

test.describe("Mail visual regression", () => {
  test("mail inbox default", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)
    await settle(page)

    await expect(page.getByTestId("mail-inbox")).toHaveScreenshot("mail-inbox-default.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.getByTestId("conversation-row-timestamp")],
    })
  })

  test("mail sidebar", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)
    await settle(page)

    await expect(page.getByTestId("mail-sidebar")).toHaveScreenshot("mail-sidebar.png", {
      maxDiffPixelRatio: 0.05,
    })
  })

  test("mail conversation detail", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)

    // Open Conv B (read, stable)
    const convB = page.locator(`[data-conversation-id="${mail.conversations.readNormal.id}"]`)
    await convB.locator("button").first().click()
    await page.waitForURL(new RegExp(`/mail/${mail.conversations.readNormal.id}`), {
      timeout: 10000,
    })
    await expect(page.getByTestId("mail-conversation")).toBeVisible()
    await expect(page.getByTestId("mail-message").first()).toBeVisible({ timeout: 5000 })
    await settle(page)

    await hideDockBar(page)
    await expect(page.getByTestId("mail-conversation")).toHaveScreenshot(
      "mail-conversation-detail.png",
      {
        maxDiffPixelRatio: 0.05,
        mask: [page.locator(".text-xs.text-text-tertiary").filter({ hasText: /\d/ })],
      },
    )
  })

  test("mail remote-image blocked state", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)

    // Open Conv A (has HTML with remote image)
    const convA = page.locator(
      `[data-conversation-id="${mail.conversations.unreadStarredHtml.id}"]`,
    )
    await convA.locator("button").first().click()
    await page.waitForURL(new RegExp(`/mail/${mail.conversations.unreadStarredHtml.id}`), {
      timeout: 10000,
    })
    await expect(page.getByTestId("mail-image-banner").first()).toBeVisible({ timeout: 5000 })
    await settle(page)

    // Capture just the last message (with the image banner)
    const lastMessage = page.getByTestId("mail-message").last()
    await expect(lastMessage).toHaveScreenshot("mail-conversation-images-blocked.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.locator(".text-xs.text-text-tertiary").filter({ hasText: /\d/ })],
    })
  })

  // ff9ae2c1 (T12) deleted the discussion panel; "Add note" now opens the
  // personal agent DM as an expanded dock tab (discussWithPersonalAgent,
  // personal-dm-store.ts) — that dock tab is what this baseline captures.

  test("mail discuss dock tab", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)

    // Open Conv C (has linked thread)
    const convC = page.locator(`[data-conversation-id="${mail.conversations.withThread.id}"]`)
    await convC.locator("button").first().click()
    await page.waitForURL(new RegExp(`/mail/${mail.conversations.withThread.id}`), {
      timeout: 10000,
    })
    await page.getByTestId("mail-add-note").click()

    const dockTab = page.locator("[data-dock-tab]")
    await expect(dockTab).toBeVisible({ timeout: 10000 })
    await expect(dockTab).toHaveAttribute("data-expanded", "true")
    await expect(
      dockTab
        .getByTestId("message-row")
        // Mention chip, not "title: path" (personal-dm-store.ts).
        .filter({ hasText: /I want to discuss\s*#?Client Feedback/ }),
    ).toBeVisible({ timeout: 10000 })
    // The lane runs no model, so the personal agent's turn is refused (Auto
    // has no model to run): the window settles once that refusal is said, as
    // the conversation's one system line (turn-refusal.ts), with no Failed
    // block or state line beside it.
    const refusal = dockTab
      .getByTestId("message-row-system-line")
      .filter({ hasText: /Auto has no model to run/ })
    await expect(refusal).toHaveCount(1, { timeout: 15000 })
    await expect(dockTab.getByTestId("agent-stream-error")).toHaveCount(0)
    await expect(dockTab.getByTestId("agent-state")).toHaveCount(0)
    await settle(page)

    // The conversation's window floats above its bar item, outside the item's
    // own box: the window is what this baseline captures.
    await expect(dockTab.getByTestId("dock-window")).toHaveScreenshot("mail-discuss-dock-tab.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.locator(".text-xs.text-text-tertiary").filter({ hasText: /\d/ })],
    })
  })

  test("mail compose new", async ({ page, env, mail }) => {
    await loginAs(page, env, "admin@test.com", "12345678")
    await openMail(page)

    await page.getByTestId("mail-compose-btn").click()
    await page.waitForURL(/\/mail\/compose$/, { timeout: 10000 })
    await expect(page.getByTestId("mail-compose")).toBeVisible()
    await settle(page)

    await hideDockBar(page)
    await expect(page.getByTestId("mail-compose")).toHaveScreenshot("mail-compose-new.png", {
      maxDiffPixelRatio: 0.05,
    })
  })

  test("mail settings accounts", async ({ page, env, mail, world }) => {
    await setMailProviderEnabled(env, world.admin.token, false)
    await loginAs(page, env, "admin@test.com", "12345678")

    const settingsEntry = page.getByTestId("activity-settings")
    await expect(settingsEntry).toBeVisible({ timeout: 15000 })
    await settingsEntry.click()
    await page.getByTestId("settings-link-app:mail").click()
    await expect(page.getByTestId("mail-account-settings")).toBeVisible({ timeout: 10000 })
    await settle(page)

    // Badges and actions on a personal account row must never squeeze the
    // address itself out of sight: it is what tells two accounts apart.
    const addresses = page.getByTestId("mail-account-address")
    await expect(addresses.first()).toBeVisible()
    for (const address of await addresses.all()) {
      const text = (await address.textContent())?.trim() ?? ""
      const box = await address.boundingBox()
      expect(text.length, "account address text").toBeGreaterThan(0)
      expect(box?.width ?? 0, `rendered width of ${text}`).toBeGreaterThan(80)
    }

    // The personal account rows: the whole accounts block (encryption
    // settings, connect cards, organization mailboxes) is taller than the
    // viewport since the app's one settings page, and an element shot past the
    // scroller's edge comes out blank below it.
    const list = page.getByTestId("mail-account-list")
    await list.scrollIntoViewIfNeeded()
    await expect(list).toHaveScreenshot("mail-settings-accounts.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.getByTestId("mail-account-last-synced")],
    })
  })
})
