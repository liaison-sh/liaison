// SPDX-License-Identifier: FSL-1.1-ALv2
// Starting conversations the way a member does: the "+" beside Channels
// creates a channel, the "+" beside Direct messages writes to somebody.
// Scenarios that only need a fresh room to act on create a CHANNEL with a
// unique name, so they never land in (and mutate) a seeded DM that the
// message dialog would rightly reopen.
import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { expect } from "../fixtures/test"

/**
 * Open Messages, where the conversation list lives. Since D21 Home's sidebar
 * lists what is asked of the viewer, not their threads, so a scenario that
 * reads or clicks threads in the sidebar goes here first.
 */
export async function openMessages(page: Page): Promise<void> {
  await page.getByTestId("activity-messages").click()
  await page.waitForURL(/\/chats/, { timeout: 10_000 })
}

/**
 * Unfold the Channels list. Past a few rows, read channels fold under
 * "N more channels" (unread, pinned and open ones always show), so whether a
 * seeded channel has its own row depends on what earlier tests read. A
 * scenario that finds a channel by its row calls this after `openMessages`.
 */
export async function showAllChannels(page: Page): Promise<void> {
  const sidebar = page.getByTestId("sidebar")
  await expect(sidebar.getByTestId("thread-item").first()).toBeVisible({ timeout: 10_000 })
  const toggle = sidebar.getByTestId("channels-more-toggle")
  if ((await toggle.count()) === 0) return
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

/** A channel name no seed or earlier run can already hold. */
export function uniqueChannelName(label: string): string {
  return `${label} ${randomUUID().slice(0, 6)}`
}

async function waitForOpenedThread(page: Page): Promise<void> {
  await page.waitForURL(/\/threads\//, { timeout: 10000 })
  await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
    timeout: 10000,
  })
}

/** Creates a channel through the Channels "+" and waits for it to open. */
export async function createChannelViaUi(
  page: Page,
  name: string,
  opts: { people?: string[]; private?: boolean } = {},
): Promise<void> {
  // The "+" lives on the Messages sidebar (D21).
  await openMessages(page)
  await page.getByTestId("thread-group-add-channels").click()
  await expect(page.getByText("Create a channel")).toBeVisible({ timeout: 5000 })
  await page.getByTestId("new-channel-name").fill(name)
  if (opts.private) await page.getByText("Private", { exact: true }).click()
  for (const person of opts.people ?? []) {
    await page.getByTestId("new-channel-people").fill(person.split(" ")[0])
    const row = page.getByTestId("new-channel-person-result").filter({ hasText: person })
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.click()
  }
  await page.getByRole("button", { name: "Create channel" }).click()
  await waitForOpenedThread(page)
}

/** Writes to people through the Direct messages "+": picks each person, adds
 *  the message if any, and presses the dialog's primary button (which reads
 *  Send, Open conversation or Start conversation depending on the case). */
export async function messagePeopleViaUi(
  page: Page,
  people: string[],
  message?: string,
): Promise<void> {
  // The "+" lives on the Messages sidebar (D21).
  await openMessages(page)
  await page.getByTestId("thread-group-add-directMessages").click()
  const to = page.getByTestId("new-message-to")
  await expect(to).toBeVisible({ timeout: 5000 })
  for (const person of people) {
    await to.fill(person.split(" ")[0])
    const row = page.getByTestId("new-message-option-person").filter({ hasText: person })
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.click()
  }
  if (message) await page.getByTestId("new-message-body").fill(message)
  await page.getByRole("button", { name: /^(Send|Open conversation|Start conversation)$/ }).click()
  await waitForOpenedThread(page)
}
