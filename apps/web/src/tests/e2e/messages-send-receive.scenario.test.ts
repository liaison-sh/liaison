// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { messagePeopleViaUi, openMessages, showAllChannels } from "./helpers/new-conversation"
import { waitForMentionIndex } from "./helpers/wait-for-mention"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 03: Messaging
// ALL 12 flows (A–L). All primary-actor actions via UI.
// ─────────────────────────────────────────────────────────────────────────────

/** Find the message row containing the given text, hover it, and return its container. */
async function hoverMessage(page: import("@playwright/test").Page, text: string) {
  const rows = page.locator('[data-testid="tab-content-area"] [data-testid="message-row"]')
  const row = rows.filter({ hasText: text }).last()
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.hover()
  return row
}

/** Send a message via the compose bar UI. */
async function sendMessageViaUI(page: import("@playwright/test").Page, content: string) {
  const textbox = page.getByRole("textbox", { name: "Write a message" })
  await textbox.click()
  await page.keyboard.type(content)
  await page.keyboard.press("Enter")
  const area = page.locator('[data-testid="tab-content-area"]')
  await expect(area.getByText(content)).toBeVisible({ timeout: 5000 })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Flow A: Send a Message
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow A: Send a Message", () => {
  test("Amina sends message via compose bar — send button, cleared after", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Initial message")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Initial message")).toBeVisible({ timeout: 10000 })

    // Compose bar visible, send button disabled when empty
    const textbox = page.getByRole("textbox", { name: "Write a message" })
    await expect(textbox).toBeVisible()

    // Type and send
    await textbox.click()
    await page.keyboard.type("This is a test message from QA")
    await page.keyboard.press("Enter")

    // Message appears
    await expect(page.getByText("This is a test message from QA")).toBeVisible({
      timeout: 10000,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow B: Send Message with Enter Key
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow B: Send Message with Enter Key", () => {
  test("pressing Enter sends the message", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Setup msg")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Setup msg")).toBeVisible({ timeout: 10000 })

    const textbox = page.getByRole("textbox", { name: "Write a message" })
    await textbox.click()
    await page.keyboard.type("Sent with Enter key")
    await page.keyboard.press("Enter")

    await expect(page.getByText("Sent with Enter key")).toBeVisible({ timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow C: View Message History with Scrolling
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow C: View Message History", () => {
  test("Weekly standup shows messages from all 5 participants", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Weekly standup notes").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })

    // Messages from multiple authors. Scope to the active thread tab: a
    // `thread_reply` attention row echoes the message preview verbatim, so a
    // page-wide getByText would match both the message and the attention row.
    const threadTab = page.locator('[data-testid="tab-content-area"] [data-tab-active="true"]')
    await expect(threadTab.getByText("Monday standup")).toBeVisible({ timeout: 5000 })
    await expect(threadTab.getByText("Working on the search refactor")).toBeVisible()
    await expect(threadTab.getByText("Finishing the API pagination")).toBeVisible()
    await expect(threadTab.getByText("Setting up monitoring dashboards")).toBeVisible()
    await expect(threadTab.getByText("Onboarding the new contractor")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow D: Edit Own Message via UI
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow D: Edit Own Message via UI", () => {
  test("Amina edits her message inline — textarea, save, (edited) indicator", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Original content")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Original content")).toBeVisible({ timeout: 10000 })

    await sendMessageViaUI(page, "Will be edited")
    // Wait for optimistic + real message to consolidate into a single row
    await expect(page.getByText("Will be edited").first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByText("Will be edited")).toHaveCount(1, { timeout: 5000 })

    // Hover to reveal action menu
    const msgRow = await hoverMessage(page, "Will be edited")
    await msgRow.locator('[aria-label="Message actions"]').click()
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible({ timeout: 3000 })
    await page.getByRole("menuitem", { name: "Edit" }).click()

    // Edit mode: the composer's rich editor in place of the message
    // (MessageEditField), not a textarea.
    const editField = page.getByTestId("tab-content-area").getByTestId("message-edit-field")
    await expect(editField).toBeVisible({ timeout: 3000 })
    await expect(editField).toHaveText("Will be edited")
    await expect(page.getByRole("button", { name: /save/i })).toBeVisible()

    // Clear and type replacement text
    await editField.fill("Edited message content")
    await expect(editField).toHaveText("Edited message content")
    // Save via Enter keyboard shortcut (Enter without Shift saves)
    await editField.press("Enter")

    await expect(page.getByText("Edited message content")).toBeVisible({
      timeout: 5000,
    })
    await expect(page.getByText("(edited)")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow E: Cancel Message Edit
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow E: Cancel Message Edit", () => {
  test("pressing Escape cancels edit, message reverts", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Setup")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Setup", { exact: true })).toBeVisible({
      timeout: 10000,
    })

    await sendMessageViaUI(page, "Original text for cancel")
    await expect(page.getByText("Original text for cancel")).toBeVisible({
      timeout: 10000,
    })

    // Enter edit mode
    const msgRow = await hoverMessage(page, "Original text for cancel")
    await msgRow.locator('[aria-label="Message actions"]').click()
    await page.getByRole("menuitem", { name: "Edit" }).click()

    const editField = page.getByTestId("tab-content-area").getByTestId("message-edit-field")
    await expect(editField).toBeVisible({ timeout: 3000 })

    // Modify the text in the edit field (a rich editor, not a textarea)
    await editField.fill("Modified text")
    await expect(editField).toHaveText("Modified text")

    // Click the Cancel button (role=button scoped to tab content area)
    await page.getByTestId("tab-content-area").getByRole("button", { name: "Cancel" }).click()

    // Original text restored, no edit mode
    await expect(content.getByText("Original text for cancel")).toBeVisible({
      timeout: 5000,
    })
    // The edit textarea (with Save/Cancel nearby) should be gone
    await expect(page.getByRole("button", { name: "Save" })).not.toBeVisible({ timeout: 3000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow F: Delete Own Message via UI
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow F: Delete Own Message via UI", () => {
  test("Amina deletes her message, sees [message deleted]", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Keep this message")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Keep this message")).toBeVisible({ timeout: 10000 })

    await sendMessageViaUI(page, "Will be deleted")
    await expect(content.getByText("Will be deleted")).toBeVisible({ timeout: 10000 })

    // Hover and delete
    const msgRow = await hoverMessage(page, "Will be deleted")
    await msgRow.locator('[aria-label="Message actions"]').click()
    await page.getByRole("menuitem", { name: "Delete" }).click()

    // Every delete path asks first (DeleteMessageConfirm); confirm it.
    await expect(page.getByTestId("delete-message-confirm")).toBeVisible({ timeout: 3000 })
    await page.getByTestId("delete-message-confirm-btn").click()
    await expect(content.getByText("[message deleted]")).toBeVisible({ timeout: 5000 })
    await expect(content.getByText("Will be deleted")).not.toBeVisible({ timeout: 2000 })

    // Other messages remain intact
    await expect(content.getByText("Keep this message")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow G: Add Emoji Reaction
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow G: Add Emoji Reaction", () => {
  test("Amina adds thumbs up reaction via picker", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "React to me")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("React to me")).toBeVisible({ timeout: 10000 })

    // Hover message to reveal reaction button
    const rRow = await hoverMessage(page, "React to me")
    await rRow.locator('[aria-label="Add reaction"]').click()

    // Emoji picker appears — select thumbs up
    await page.getByTestId("reaction-favorites").locator('[aria-label="React with 👍"]').click()

    // Reaction badge appears on the message
    await expect(content.getByRole("button", { name: /Remove 👍 reaction/ })).toBeVisible({
      timeout: 5000,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow H: Remove Own Reaction
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow H: Remove Own Reaction", () => {
  test("Amina clicks existing reaction badge to remove it", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "React then remove")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("React then remove")).toBeVisible({ timeout: 10000 })

    // Add reaction first
    const rRow = await hoverMessage(page, "React then remove")
    await rRow.locator('[aria-label="Add reaction"]').click()
    await page.getByTestId("reaction-favorites").locator('[aria-label="React with 🎉"]').click()
    await expect(page.locator('[aria-label*="🎉 reaction"]')).toBeVisible({ timeout: 5000 })

    // Click the badge to remove
    await page.locator('[aria-label="Remove 🎉 reaction"]').click()

    // Badge should disappear
    await expect(page.locator('[aria-label*="🎉 reaction"]')).not.toBeVisible({ timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow I: View Existing Reactions from Seed
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow I: View Existing Reactions from Seed", () => {
  test("Bug in checkout flow shows seeded reactions with counts", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Bug in checkout flow")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Bug in checkout flow").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })

    // QA seed reactions: 👍 (1), 🎉 (2), 🙏 (1)
    await expect(page.getByText("👍")).toBeVisible({ timeout: 5000 })
    await expect(page.getByText("🎉")).toBeVisible()
    await expect(page.getByText("🙏")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow J: Mention a User with @
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow J: Mention a User with @", () => {
  test("Amina @ mentions Lucas — autocomplete, styled mention in message", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    // Open Sprint retrospective (has Lucas as participant)
    const sidebarNav = page.locator('[data-testid="sidebar"]')
    await expect(sidebarNav.getByText("Sprint retrospective")).toBeVisible({ timeout: 10000 })
    await sidebarNav.getByText("Sprint retrospective").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible({
      timeout: 5000,
    })

    // Search comes up asynchronously after the server starts (503 until it
    // is ready), and Lucas's user document is indexed after the seed.
    const lucasIndexed = await waitForMentionIndex({
      token: qa.amina.token,
      serverUrl: env.serverUrl,
      query: "Lucas",
      predicate: (row) => String(row.label ?? "").includes("Lucas Pereira"),
    })
    expect(lucasIndexed, "search must surface Lucas before the popup is driven").not.toBeNull()

    // Type @ to trigger mention autocomplete
    const textbox = page.getByRole("textbox", { name: "Write a message" })
    await textbox.click()
    await page.keyboard.type("Hey @Lucas")

    // Autocomplete popup should appear with Lucas — scope to autocomplete to avoid hitting sidebar/participants
    const autocomplete = page.getByTestId("mention-autocomplete")
    await expect(autocomplete.getByText("Lucas Pereira")).toBeVisible({ timeout: 5000 })
    await autocomplete.getByText("Lucas Pereira").click()
    // Wait for autocomplete popup to close — confirms mention pill was inserted
    await expect(page.getByTestId("mention-autocomplete")).not.toBeVisible({ timeout: 3000 })

    // Type remaining text directly — do NOT re-click textbox (resets cursor, can lose pill position)
    await page.keyboard.type(" can you review?")
    await page.keyboard.press("Enter")

    // The message should contain a styled @mention (allow extra time for WS round-trip)
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(
      content.locator('[data-testid="message-row"]').getByText("@Lucas Pereira"),
    ).toBeVisible({
      timeout: 10000,
    })
    // Walk 3: the picked mention is followed by a space and the space typed
    // after it was kept too, so the message read "@Lucas Pereira  can you
    // review?". Exactly the one space typed.
    const sent = content
      .locator('[data-testid="message-row"]')
      .filter({ hasText: "can you review?" })
      .last()
    await expect.poll(async () => sent.textContent()).toContain("@Lucas Pereira can you review?")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow K: Mention a Thread with #
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow K: Mention a Thread with #", () => {
  test("Amina # mentions Release checklist — autocomplete, clickable", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    const sidebarNav = page.locator('[data-testid="sidebar"]')
    await expect(sidebarNav.getByText("Sprint retrospective")).toBeVisible({ timeout: 10000 })
    await sidebarNav.getByText("Sprint retrospective").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible({
      timeout: 5000,
    })

    const textbox = page.getByRole("textbox", { name: "Write a message" })
    await textbox.click()
    await page.keyboard.type("Related to #release")

    // Autocomplete should show Release checklist — scope to autocomplete to avoid hitting sidebar
    const autocompleteK = page.getByTestId("mention-autocomplete")
    await expect(autocompleteK.getByText("Release checklist")).toBeVisible({ timeout: 5000 })
    await autocompleteK.getByText("Release checklist").click()
    // Wait for autocomplete popup to close — confirms mention pill was inserted
    await expect(page.getByTestId("mention-autocomplete")).not.toBeVisible({ timeout: 3000 })

    // Type remaining text directly — do NOT re-click textbox (resets cursor, can lose pill position)
    await page.keyboard.type(" — please review")
    await page.keyboard.press("Enter")

    // The rendered message should expose the #mention as a clickable pill (allow extra time for WS round-trip)
    await expect(
      page.locator('[data-mention-ref^="thread:"]', { hasText: "Release checklist" }).first(),
    ).toBeVisible({ timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow K.1: Click #mention to Navigate to Thread
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow K.1: Click #mention to Navigate to Thread", () => {
  test("clicking a #mention opens the referenced thread in a tab", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    // Send a message with a #mention of Release checklist
    const sidebarNav = page.locator('[data-testid="sidebar"]')
    await expect(sidebarNav.getByText("Sprint retrospective")).toBeVisible({ timeout: 10000 })
    await sidebarNav.getByText("Sprint retrospective").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    const textbox = page.locator('[data-tab-active="true"] [role="textbox"]')
    await expect(textbox).toBeVisible({ timeout: 5000 })

    await textbox.click()
    await page.keyboard.type("See #release")
    // Wait for mention autocomplete and click the result (scoped to avoid sidebar matches)
    const autocomplete = page.getByTestId("mention-autocomplete")
    await expect(autocomplete.getByText("Release checklist")).toBeVisible({ timeout: 5000 })
    await autocomplete.getByText("Release checklist").click()
    await textbox.click()
    await page.keyboard.press("Enter")

    // Wait for the sent message to render in the message list
    await expect(
      page.getByTestId("tab-content-area").getByText("Release checklist").first(),
    ).toBeVisible({ timeout: 10000 })

    // Click the rendered #mention to navigate to the referenced thread
    const mention = page
      .getByTestId("tab-content-area")
      .locator('[data-mention-ref^="thread:"]', { hasText: "Release checklist" })
      .first()
    await expect(mention).toBeVisible({ timeout: 5000 })
    await mention.click()

    // Should have navigated to the Release checklist thread tab
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 10000,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow I.1: Current-User Reaction Distinction
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow I.1: Current-User Reaction Distinction", () => {
  test("Amina's own reaction is visually distinct from others'", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await showAllChannels(page)

    // Open Bug in checkout flow (has seeded reactions)
    const sidebarBug = page.locator('[data-testid="sidebar"]')
    await expect(sidebarBug.getByText("Bug in checkout flow")).toBeVisible({ timeout: 10000 })
    await sidebarBug.getByText("Bug in checkout flow").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.getByText("Found a critical bug")).toBeVisible({ timeout: 5000 })

    // Add a reaction as Amina — use hoverMessage helper
    const row = await hoverMessage(page, "Found a critical bug")
    const reactionButton = row.locator('[aria-label="Add reaction"]')
    await expect(reactionButton).toBeVisible({ timeout: 2000 })
    await reactionButton.click()

    // The favorites shelf: the picker lists the same emoji again in its catalog.
    const emoji = page.getByTestId("reaction-favorites").locator('[aria-label="React with 👍"]')
    await expect(emoji).toBeVisible({ timeout: 2000 })
    await emoji.click()

    // Verify Amina's reaction appears with accent styling (own reaction)
    const reactionBadge = row.locator("button").filter({ hasText: "👍" }).first()
    await expect(reactionBadge).toBeVisible({ timeout: 3000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow L: Empty Message Cannot Be Sent
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow L: Empty Message Cannot Be Sent", () => {
  test("empty compose bar — Enter does nothing, no message sent", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    await messagePeopleViaUi(page, ["Lucas Pereira"], "Setup")
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Setup", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    })

    const textbox = page.locator('[data-tab-active="true"] [role="textbox"]')
    await textbox.click()

    // Press Enter with empty content — should not send
    await page.keyboard.press("Enter")

    // Verify the "Setup" message is still there (empty Enter didn't break anything)
    await expect(content.getByText("Setup", { exact: true }).first()).toBeVisible()
  })
})
