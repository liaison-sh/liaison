// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for the tour play loop's reads (helpers/tour-play.ts), forcing the
// ordering that made `tours-play-all` fail on slow runners: the tour completes
// while the loop is between two reads, so the panel is gone when it is read,
// and the completion card is on screen for less time than one blocked read.
// No product stack: the page is the smallest one with the tour's test ids.

import { expect, test } from "@playwright/test"
import { attributeNow, watchShown } from "./helpers/tour-play"

const PAGE = `<!doctype html><title>tour</title>
<section data-testid="tour-panel" data-tour-id="t" data-beat-id="last"></section>
<script>
window.complete = () => {
  document.querySelector('[data-testid="tour-panel"]').remove()
  const card = document.createElement("section")
  card.dataset.testid = "tour-completed"
  card.textContent = "Done"
  document.body.append(card)
  // Shorter than the action timeout a waiting read spends on the gone panel.
  setTimeout(() => card.remove(), 1500)
}
</script>`

test("a completion between two reads is seen, and the gone panel is read at once", async ({
  page,
}) => {
  test.setTimeout(30_000)
  await page.setContent(PAGE)
  const panel = page.getByTestId("tour-panel")
  const card = watchShown(page.getByTestId("tour-completed"), 20_000)
  expect(await attributeNow(panel, "data-beat-id")).toBe("last")
  expect(await attributeNow(panel, "data-play-all")).toBeNull()

  // The tour completes while the loop is busy (a person's step, a menu press).
  await page.evaluate("window.complete()")
  await page.waitForTimeout(3_000)

  const started = Date.now()
  expect(await attributeNow(panel, "data-beat-id"), "no panel, no attribute").toBeUndefined()
  expect(Date.now() - started, "the read waited for a panel that is gone").toBeLessThan(1_000)
  // The card already went away by itself, and it was still seen.
  await expect(page.getByTestId("tour-completed")).toHaveCount(0)
  expect(card.shown(), "the completion card shown during the busy step was missed").toBe(true)
})
