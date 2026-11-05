// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Locator, Page } from "@playwright/test"

/**
 * Shell regions whose pixels depend on what other tests in the same worker left
 * behind, masked in visual baselines so a golden records the surface under test
 * and not the worker's history.
 *
 * The org-wide unread count grows with every thread an earlier test created: it
 * shows on the chat dock's Chats pill (whose width follows the count) and as the
 * badge on the activity bar's Home button.
 */
export function volatileShellMasks(page: Page): Locator[] {
  return [page.locator("[data-chat-dock] > div").first(), page.getByTestId("activity-home")]
}
