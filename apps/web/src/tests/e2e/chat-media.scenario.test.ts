// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Chat media on the desktop (1440x900): a mention chip is a word in its
// sentence, a staged photo is a real thumbnail above the field, and a sent
// photo is the picture itself. Its phone twin is chat-media.phone.scenario.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { scenePng, seedMentionThread, settle } from "./helpers/chat-media"

const SEE = { timeout: 20_000 } as const

async function openThread(page: Page, port: number, threadId: string): Promise<void> {
  await page.goto(`http://localhost:${port}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible(SEE)
}

test("chat-media.mention-chip-inline", async ({ page, env, qa }) => {
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
  for (const h of lineHeights) expect(h).toBeLessThan(26)

  await settle(page)
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot("mention-chip-desktop.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.locator("time, [data-time]")],
  })
})

test("chat-media.image-staged-and-sent", async ({ page, env, qa }) => {
  const threadId = await seedMentionThread(env, qa)
  await loginAs(page, env, "admin@test.com", "12345678")
  await openThread(page, env.ports[1]!, threadId)

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("composer-plus").first().click(),
  ])
  await chooser.setFiles([
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
  // The strip sits ABOVE the message field, inside the card.
  const stripBox = await strip.boundingBox()
  const fieldBox = await page.getByTestId("compose-editor").boundingBox()
  expect((stripBox?.y ?? 0) + (stripBox?.height ?? 0)).toBeLessThanOrEqual((fieldBox?.y ?? 0) + 1)
  // The 64px square tile (the <img> fills it inside its 1px border).
  const thumb = await strip
    .locator('[data-kind="image"] img')
    .evaluate((i) => i.parentElement?.getBoundingClientRect().toJSON())
  expect(Math.round(thumb?.width ?? 0)).toBe(64)
  expect(
    await strip
      .locator('[data-kind="image"] img')
      .evaluate((i) => (i as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(1)

  await settle(page)
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot(
    "composer-staged-desktop.png",
    { maxDiffPixelRatio: 0.05, mask: [page.locator("time, [data-time]")] },
  )

  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Here is the storefront photo and the report.")
  await page.getByTestId("compose-send").click()

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Here is the storefront photo" })
    .first()
  const image = sent.getByTestId(/^attachment-thumbnail-/)
  await expect(image).toBeVisible(SEE)
  await expect
    .poll(() => image.evaluate((i) => (i as HTMLImageElement).naturalWidth), SEE)
    .toBeGreaterThan(1)
  const imgBox = await image.boundingBox()
  expect(imgBox?.width ?? 999).toBeLessThanOrEqual(321)
  expect(imgBox?.height ?? 999).toBeLessThanOrEqual(241)
  await expect(sent.getByTestId(/^attachment-card-/)).toContainText("quarterly-report.pdf")

  await settle(page)
  await expect(page.getByTestId("tab-content-area")).toHaveScreenshot(
    "thread-sent-image-desktop.png",
    { maxDiffPixelRatio: 0.05, mask: [page.locator("time, [data-time]")] },
  )
})
