// SPDX-License-Identifier: FSL-1.1-ALv2
// The "?" in the activity bar opens the user docs in the Help tab (modules/help),
// read from the copy the web build ships, and searching them opens a page in place.
import { expect, test } from "./fixtures/test"

test("? opens the docs in a tab, and search finds a page", async ({ authenticatedPage, env }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/`)
  await page.getByTestId("help-button").click()

  const article = page.getByTestId("help-page")
  await expect(article).toHaveAttribute("data-url", "", { timeout: 15_000 })
  // An ordinary deployment lists no guided tours: "?" is the docs, not a menu.
  await expect(page.getByTestId("help-menu")).toHaveCount(0)

  await page.getByTestId("help-search").fill("connect gmail")
  const first = page.getByTestId("help-result").first()
  await expect(first).toBeVisible()
  const url = await first.getAttribute("data-url")
  await first.click()
  await expect(article).toHaveAttribute("data-url", url ?? "")
  await expect(page).toHaveURL(/\/help$/)
})
