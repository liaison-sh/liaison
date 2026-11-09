// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Reads for a loop that plays a tour while the tour moves under it.
 *
 * The tour panel leaves the screen the moment its tour completes, and the
 * completion card that replaces it goes away by itself after a few seconds
 * (`COMPLETED_CARD_MS`, tour-store.ts) unless it offers a next step. A loop
 * that reads the panel with `locator.getAttribute` waits up to the action
 * timeout (10 s) for a panel that is gone: longer than the card stays, so the
 * loop never saw the card it was waiting for, or threw on the vanished panel.
 */
import type { Locator } from "@playwright/test"

/**
 * The attribute of the first element `locator` matches, read now: `undefined`
 * when nothing matches, `null` when the element has no such attribute. Never
 * waits for the element to appear.
 */
export async function attributeNow(
  locator: Locator,
  name: string,
): Promise<string | null | undefined> {
  return locator.evaluateAll(
    (elements, attribute) =>
      elements.length === 0 ? undefined : elements[0].getAttribute(attribute),
    name,
  )
}

/**
 * Watches for `locator` to become visible at any moment within `timeout`, in
 * the page, while the caller is busy elsewhere: `shown()` stays true once it
 * was, even after the element went away again.
 */
export function watchShown(locator: Locator, timeout: number): { shown: () => boolean } {
  let shown = false
  void locator
    .waitFor({ state: "visible", timeout })
    .then(() => {
      shown = true
    })
    .catch(() => {})
  return { shown: () => shown }
}
