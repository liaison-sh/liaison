// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tour card keeps Take me there, Play whole scenario, Pause and Skip in
 * its ⋯ menu (`tour-more`): a walk opens it, then presses the item.
 */
import type { Page } from "@playwright/test"

/** Opens the card's ⋯ menu and presses `testid` in it. */
export async function pressTourMenu(page: Page, testid: string): Promise<void> {
  await page.getByTestId("tour-more").click()
  await page.getByTestId(testid).click()
}
