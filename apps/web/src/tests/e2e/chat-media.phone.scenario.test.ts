// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Chat media on the phone (390x844, touch), the tier the iPhone app runs:
// a mention chip used to grow into a two-line slab (the 44px touch floor on
// its preview anchor), and a picked photo showed as a blank "PNG" tile under
// the send button. Desktop twin: chat-media.scenario.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { scenePng, seedMentionThread, settle } from "./helpers/chat-media"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})

const SEE = { timeout: 20_000 } as const

async function openThread(page: Page, port: number, threadId: string): Promise<void> {
  await page.goto(`http://localhost:${port}/threads/${threadId}`)
  await expect(page.locator("[data-shell-tier='phone']")).toBeVisible(SEE)
  await expect(page.getByTestId("compose-editor")).toBeVisible(SEE)
}

test("chat-media.phone-mention-chip-inline", async ({ page, env, qa }) => {
  const threadId = await seedMentionThread(env, qa)
  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env.ports[1]!, threadId)

  const chip = page.locator(`[data-mention-ref="user:${qa.lucas.id}"]`).first()
  await expect(chip).toBeVisible(SEE)
  // A word on its line: every line box of the chip (a long name may wrap,
  // keeping the chip's look on each fragment) is as tall as the text.
  const lineHeights = await chip.evaluate((el) =>
    Array.from(el.getClientRects()).map((r) => r.height),
  )
  expect(lineHeights.length).toBeGreaterThan(0)
  for (const h of lineHeights) expect(h).toBeLessThan(28)
  // The anchor around it carries no 44px floor either.
  const anchorMinHeight = await chip.evaluate((el) => {
    const anchor = el.closest('[data-testid="entity-preview"]')
    return anchor ? getComputedStyle(anchor).minHeight : "missing"
  })
  expect(["0px", "auto"]).toContain(anchorMinHeight)

  await settle(page)
  await expect(page).toHaveScreenshot("mention-chip-phone.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.locator("time, [data-time]")],
  })
})

test("chat-media.phone-image-staged-and-sent", async ({ page, env, qa }) => {
  const threadId = await seedMentionThread(env, qa)
  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env.ports[1]!, threadId)

  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles([
      { name: "storefront.png", mimeType: "image/png", buffer: scenePng() },
      {
        name: "quarterly-report.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nreport\n"),
      },
    ])

  const strip = page.getByTestId("composer-attachment-strip")
  await expect(strip.locator('[data-kind="image"] img')).toBeVisible(SEE)
  await expect(strip.locator('[data-kind="file"]')).toContainText("quarterly-report.pdf", SEE)
  const stripBox = await strip.boundingBox()
  const fieldBox = await page.getByTestId("compose-editor").boundingBox()
  expect((stripBox?.y ?? 0) + (stripBox?.height ?? 0)).toBeLessThanOrEqual((fieldBox?.y ?? 0) + 1)
  // The 64px square tile (the <img> fills it inside its 1px border).
  const thumb = await strip
    .locator('[data-kind="image"] img')
    .evaluate((i) => i.parentElement?.getBoundingClientRect().toJSON())
  expect(Math.round(thumb?.width ?? 0)).toBe(64)
  expect(Math.round(thumb?.height ?? 0)).toBe(64)

  await settle(page)
  await expect(page).toHaveScreenshot("composer-staged-phone.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.locator("time, [data-time]")],
  })

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Storefront photo and the report.")
  await page.getByTestId("compose-send").click()

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Storefront photo and the report" })
    .first()
  const image = sent.getByTestId(/^attachment-thumbnail-/)
  await expect(image).toBeVisible(SEE)
  await expect
    .poll(() => image.evaluate((i) => (i as HTMLImageElement).naturalWidth), SEE)
    .toBeGreaterThan(1)
  const imgBox = await image.boundingBox()
  expect(imgBox?.width ?? 999).toBeLessThanOrEqual(390 * 0.75)
  expect(imgBox?.width ?? 0).toBeGreaterThan(150)
  await expect(sent.getByTestId(/^attachment-card-/)).toContainText("quarterly-report.pdf")

  await settle(page)
  await expect(page).toHaveScreenshot("thread-sent-image-phone.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.locator("time, [data-time]")],
  })
})
