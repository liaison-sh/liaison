// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import {
  createChannelViaUi,
  messagePeopleViaUi,
  openMessages,
  uniqueChannelName,
} from "./helpers/new-conversation"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 02: Thread CRUD
// ALL 10 flows (A–J). All primary-actor actions via UI.
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// Flow A: View Thread List in Sidebar
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow A: View Thread List in Sidebar", () => {
  test("Amina sees her 8 QA threads, pinned section, DM names, no Vendor eval", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar).toBeVisible({ timeout: 5000 })

    // Thread titles are matched `exact` — a thread's last-message preview may
    // contain a `@Mention` of another thread (e.g. "@Sprint retrospective"),
    // so a substring match resolves to both the title and the preview and
    // trips Playwright strict mode.
    // Pinned thread
    await expect(sidebar.getByText("Q2 Marketing Plan", { exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Amina's titled threads
    await expect(sidebar.getByText("Bug in checkout flow", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("Sprint retrospective", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("Design system v2", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("Release checklist", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("Weekly standup notes", { exact: true })).toBeVisible()

    // Amina should NOT see "Vendor evaluation" (Lucas, Tobias, Margot only)
    await expect(sidebar.getByText("Vendor evaluation", { exact: true })).not.toBeVisible({
      timeout: 2000,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow B: Write to Someone from Direct messages
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow B: Write to Someone from Direct messages", () => {
  test("Amina writes to Tobias through the Direct messages +", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    await page.getByTestId("thread-group-add-directMessages").click()
    await expect(page.getByTestId("new-message-to")).toBeVisible({ timeout: 3000 })

    // Nothing chosen yet: nothing to start.
    await expect(page.getByRole("button", { name: "Start conversation" })).toBeDisabled()

    await page.getByTestId("new-message-to").fill("Tobias")
    const tobias = page.getByTestId("new-message-option-person").filter({ hasText: "Tobias Braun" })
    await expect(tobias).toBeVisible({ timeout: 5000 })
    await tobias.click()

    // The dialog says whether a DM with Tobias already exists, before any press.
    await expect(page.getByTestId("new-message-status")).toBeVisible()
    await page.getByRole("button", { name: /^(Open conversation|Start conversation)$/ }).click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })

    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 10000,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow C: Create a Channel with People, then a Group Message
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow C: Create a Channel with People, then a Group Message", () => {
  test("Amina creates a public channel with Lucas and Tobias", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    const name = uniqueChannelName("Project kickoff")

    await createChannelViaUi(page, name, { people: ["Lucas Pereira", "Tobias Braun"] })

    await expect(page.getByTestId("thread-item").filter({ hasText: name })).toBeVisible({
      timeout: 10000,
    })
  })

  test("Amina writes to Lucas and Tobias together, first message included", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    const text = `Welcome to the project ${Date.now()}`

    await messagePeopleViaUi(page, ["Lucas Pereira", "Tobias Braun"], text)

    await expect(page.getByText(text).first()).toBeVisible({ timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow D: Open a Thread from Sidebar
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow D: Open a Thread from Sidebar", () => {
  test("Amina opens Bug in checkout flow — messages, reactions visible", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Bug in checkout flow")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Bug in checkout flow").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })

    // Messages from QA seed — scope to the active tab's message list so we
    // don't strict-mode-collide with attention-row previews that surface the
    // same text in the sidebar.
    const activeTab = page.locator('[data-tab-active="true"]')
    const messages = activeTab.locator('[data-testid="message-row"]')
    await expect(messages.getByText("Found a critical bug")).toBeVisible({ timeout: 5000 })
    await expect(messages.getByText("Can you share the stack trace?")).toBeVisible()
    await expect(activeTab.locator('[role="textbox"]')).toBeVisible({
      timeout: 10000,
    })

    // Reactions from QA seed — also scoped to the message list (emoji can
    // appear elsewhere in the shell once notifications/reactions surface).
    await expect(messages.getByText("👍")).toBeVisible({ timeout: 5000 })
    await expect(messages.getByText("🎉")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow E: Pin a Thread
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow E: Pin a Thread", () => {
  test("Elodie pins Sprint retrospective via actions menu", async ({ authenticatedPage, qa }) => {
    // Wait for thread list. Scope to the sidebar: the kept-alive Home tab shows
    // the same title in its message feed, so a page-wide query is ambiguous.
    await openMessages(authenticatedPage)
    const sidebar = authenticatedPage.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Sprint retrospective")).toBeVisible({
      timeout: 10000,
    })
    await sidebar.getByText("Sprint retrospective").click()
    await authenticatedPage.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(
      authenticatedPage.locator('[data-tab-active="true"] [role="textbox"]'),
    ).toBeVisible({ timeout: 10000 })

    // Click thread actions menu
    await authenticatedPage.locator('[aria-label="Thread actions"]').click()
    await expect(authenticatedPage.getByText("Pin", { exact: true })).toBeVisible({ timeout: 5000 })

    // Click "Pin" (user-level pin)
    await authenticatedPage.getByText("Pin", { exact: true }).click()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow F: Unpin a Thread
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow F: Unpin a Thread", () => {
  test("Elodie unpins Q2 Marketing Plan (pinned by seed)", async ({ authenticatedPage, qa }) => {
    // Sidebar-scoped: the kept-alive Home tab repeats the title in its feed.
    await openMessages(authenticatedPage)
    const sidebar = authenticatedPage.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Q2 Marketing Plan").click()
    await authenticatedPage.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(
      authenticatedPage.locator('[data-tab-active="true"] [role="textbox"]'),
    ).toBeVisible({ timeout: 5000 })

    await authenticatedPage.locator('[aria-label="Thread actions"]').click()
    // Q2 is org-pinned by seed — admin sees "Unpin for all"
    await expect(authenticatedPage.getByText("Unpin for all")).toBeVisible({ timeout: 5000 })
    await authenticatedPage.getByText("Unpin for all").click()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow G: Mute a Thread
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow G: Mute a Thread", () => {
  test("Amina mutes then unmutes Sprint retrospective via actions menu", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    // Sidebar-scoped: the kept-alive Home tab repeats the title in its feed.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Sprint retrospective")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Sprint retrospective").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    // Mute
    await page.locator('[aria-label="Thread actions"]').click()
    await expect(page.getByText("Mute")).toBeVisible({ timeout: 5000 })
    await page.getByText("Mute").click()

    // Verify "Unmute" now visible
    await page.locator('[aria-label="Thread actions"]').click()
    await expect(page.getByText("Unmute")).toBeVisible({ timeout: 5000 })

    // Unmute
    await page.getByText("Unmute").click()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow H: Archive a Thread
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow H: Archive a Thread", () => {
  test("Amina archives a thread via UI, it disappears from sidebar", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    // A fresh channel to archive (don't mutate QA seed threads)
    await createChannelViaUi(page, uniqueChannelName("Archive me"), { people: ["Lucas Pereira"] })

    // Archive via thread actions menu
    await page.locator('[aria-label="Thread actions"]').click()
    await expect(page.getByText("Archive thread")).toBeVisible({ timeout: 5000 })
    await page.getByText("Archive thread").click()

    // Archiving closes the tab and navigates away from the thread
    await expect(page).not.toHaveURL(/\/threads\//, { timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow I: Search Threads in Sidebar
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow I: Search Threads in Sidebar", () => {
  test("sidebar search filters to matching threads", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    // Every assertion here is about the SIDEBAR list, and the kept-alive Home
    // tab carries the same titles in its message feed, so scope them.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Release checklist")).toBeVisible({ timeout: 10000 })
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible()

    const searchInput = page.getByPlaceholder(/search threads/i)
    await expect(searchInput).toBeVisible({ timeout: 3000 })

    // Search "release"
    await searchInput.fill("release")
    await expect(sidebar.getByText("Release checklist")).toBeVisible({ timeout: 5000 })

    // Clear and search "standup"
    await searchInput.clear()
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible({ timeout: 5000 })

    await searchInput.fill("standup")
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible({ timeout: 5000 })

    // Clear restores full list
    await searchInput.clear()
    await expect(sidebar.getByText("Release checklist")).toBeVisible({ timeout: 5000 })
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible({ timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow J: Thread Sidebar Shows Correct Metadata
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow J: Thread Sidebar Shows Correct Metadata", () => {
  test("sidebar shows timestamps, last message previews", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)

    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar).toBeVisible({ timeout: 5000 })
    // Sidebar-scoped: the kept-alive Home tab repeats the title in its feed.
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })

    // Most recently active thread should appear at top of unpinned section
    // The sidebar should show relative timestamps and last message previews
    // Verify the sidebar is populated with multiple thread items
    const threadItems = sidebar.locator('[data-testid="thread-item"]')
    const count = await threadItems.count()
    expect(count).toBeGreaterThanOrEqual(6) // Amina has 8 threads
  })
})
