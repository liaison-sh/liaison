// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-B T9. The phone thread, in a real browser at 390x844 with touch: the
// composer collapsed to `+`, the mic and send, the actions sheet with Attach
// first, its Dictate turning the control line into the recorder (discard, the
// timer and waveform in a pill, stop), a message actually sent, and the Chats
// root's four filter chips. Chromium's fake microphone stands in for one; the
// take is discarded, so nothing is transcribed.
//
// `test.use` is declared here rather than left to a project entry, so the file
// runs at phone size under the default project too.
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
})

const NAV = { timeout: 30_000 } as const
const SEE = { timeout: 20_000 } as const

/** The shell registers its keydown listener in onMount; `[data-shell]` paints
 *  before that, so a shortcut sent in the gap is silently dropped. */
async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("[data-shell][data-shell-ready='true']")).toBeVisible(NAV)
}

/** The phone thread screen. Since F3 a conversation is a ROUTE inside the main
 *  panel, not a full-screen sheet over it. */
function threadScreen(page: Page): Locator {
  return page.getByTestId("main-panel")
}

/** The Chats root, one seat away from anywhere. */
async function openChats(page: Page): Promise<void> {
  await page.getByTestId("phone-tab-chats").click(NAV)
  await expect(page.getByTestId("chats-screen")).toBeVisible(SEE)
}

test("threads.phone-composer-and-chats-root", async ({ page, env }) => {
  await loginAs(page, env, "admin@test.com", "12345678")
  await shellReady(page)

  // ── 1. A DM, opened the way the product opens one: the personal agent chat.
  //      At phone tier that lands on the thread ROUTE (F3), with the top bar as
  //      its nav bar (F4).
  await page.keyboard.press("ControlOrMeta+Period")
  const sheet = threadScreen(page)
  await expect(page).toHaveURL(/\/threads\//, NAV)
  await expect(page.getByTestId("phone-thread-header")).toBeVisible(SEE)
  const editor = sheet.getByTestId("compose-editor")
  await expect(editor).toBeVisible(SEE)

  // ── 2. Two lines: the field, then a `+`, the mic and a send button. ──────
  const controls = sheet.getByTestId("compose-controls-row")
  await expect(controls).toBeVisible(SEE)
  const order = await sheet.getByTestId("compose-row-phone").evaluate((row) => {
    const field = row.querySelector('[data-testid="compose-editor"]')
    const bar = row.querySelector('[data-testid="compose-controls-row"]')
    return Boolean(
      field && bar && field.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
  expect(order).toBe(true)
  await expect(sheet.getByTestId("composer-plus")).toBeVisible(SEE)
  await expect(sheet.getByTestId("compose-send")).toBeVisible(SEE)
  // The wand and emoji live in the `+` sheet; the mic (where dictation runs:
  // the run's Google key gives the org a transcription model) sits
  // immediately left of send.
  await expect(sheet.getByTestId("magic-wand")).toHaveCount(0)
  const mic = sheet.getByTestId("voice-dictation-button")
  await expect(mic).toBeVisible(SEE)
  expect(
    await mic.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid") ?? null),
  ).toBe("compose-send")
  await expect(sheet.getByTestId("compose-emoji")).toHaveCount(0)
  await expect(sheet.getByTestId("attachment-upload-button")).toBeHidden()

  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m1b-1.png`, fullPage: true })

  // ── 3. The `+` sheet lists Attach first. ─────────────────────────────────
  await sheet.getByTestId("composer-plus").click(NAV)
  const actionSheet = page.locator('[data-overlay-sheet][data-variant="bottom"]').first()
  await expect(actionSheet).toBeVisible(SEE)
  const attach = actionSheet.getByTestId("composer-sheet-attach")
  await expect(attach).toBeVisible(SEE)
  const rowTestIds = await actionSheet
    .locator("[data-testid^='composer-sheet-']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))
  expect(rowTestIds[0]).toBe("composer-sheet-attach")
  // The wand has its row, and so has the mic: the run's Google key gives the
  // org Gemini's audio input as its transcription model.
  expect(rowTestIds).toEqual(
    expect.arrayContaining(["composer-sheet-wand", "composer-sheet-dictation"]),
  )
  await expectNoHorizontalClipping(page)
  // Every row's glyph and label start at the same x (Attach sat 14px left).
  const starts = await actionSheet
    .locator(
      "[data-testid='composer-sheet-attach'],[data-testid='composer-sheet-wand'],[data-testid='composer-sheet-dictation'],[data-testid='composer-sheet-emoji']",
    )
    .evaluateAll((rows) =>
      rows.map((row) => {
        const glyph = row.querySelector("svg")!.getBoundingClientRect()
        const range = document.createRange()
        const text = [...row.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
        )!
        range.selectNodeContents(text)
        return {
          glyph: Math.round(glyph.left + glyph.width / 2),
          label: Math.round(range.getBoundingClientRect().left),
        }
      }),
    )
  expect(starts).toHaveLength(4)
  for (const s of starts) {
    expect(Math.abs(s.glyph - starts[0]!.glyph), JSON.stringify(starts)).toBeLessThanOrEqual(1)
    expect(Math.abs(s.label - starts[0]!.label), JSON.stringify(starts)).toBeLessThanOrEqual(1)
  }

  // ── 3b. Dictate closes the sheet and the control line becomes the recorder.
  let uploads = 0
  const count = (req: { method: () => string; url: () => string }) => {
    if (req.method() === "POST" && req.url().includes("/api/assist/transcribe")) uploads += 1
  }
  page.on("request", count)
  await actionSheet.getByTestId("composer-sheet-dictation").click(NAV)
  await expect(actionSheet).toHaveCount(0)
  const recorder = controls.getByTestId("voice-dictation-recorder")
  await expect(recorder).toHaveAttribute("data-state", "recording", SEE)
  await expect(sheet.getByTestId("compose-send")).toBeHidden()
  const parts = await recorder
    .locator(
      "[data-testid='voice-dictation-discard'],[data-testid='voice-dictation-elapsed'],[data-testid='voice-dictation-waveform'],[data-testid='voice-dictation-stop']",
    )
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))
  expect(parts).toEqual([
    "voice-dictation-discard",
    "voice-dictation-elapsed",
    "voice-dictation-waveform",
    "voice-dictation-stop",
  ])
  await expect(recorder.getByTestId("voice-dictation-stop")).toBeFocused()
  await page.waitForTimeout(1_500)
  await expectNoHorizontalClipping(page)
  const card = recorder.locator("xpath=ancestor::*[@data-composer-dock][1]")
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme)
    await page.waitForTimeout(400)
    await card.screenshot({ path: `${SHOT_DIR}/recorder-thread-phone-${theme}.png` })
  }
  // Discard: the line comes back and nothing was uploaded.
  await recorder.getByTestId("voice-dictation-discard").click(NAV)
  await expect(recorder).toHaveCount(0)
  await expect(sheet.getByTestId("compose-send")).toBeVisible(SEE)
  page.off("request", count)
  expect(uploads).toBe(0)

  // ── 4. A message the viewer actually sends, and actually reads back. ──────
  const body = `phone hello ${Date.now()}`
  await editor.click(NAV)
  await page.keyboard.type(body)
  await page.keyboard.press("Enter")
  await expect(sheet.getByTestId("message-row").filter({ hasText: body })).toBeVisible(SEE)

  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m1b-2.png`, fullPage: true })

  // ── 5. The Chats root: sectioned, Channels and Direct messages. ──────────
  await openChats(page)
  for (const section of ["channels", "directMessages"]) {
    await expect(page.getByTestId(`chats-section-toggle-${section}`).first()).toBeVisible(SEE)
  }
  await expect(page.getByTestId("chats-title").first()).toHaveText("Chats", SEE)
  // The tab bar is still under the thumb: Chats is a root, not an overlay.
  await expect(page.getByTestId("phone-tab-bar")).toBeVisible(SEE)

  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m1b-3.png`, fullPage: true })

  // ── 6. A row pushes the thread, and Back returns to Chats. ────────────────
  await page.getByTestId("chats-personal-agent-row").click(NAV)
  await expect(page).toHaveURL(/\/threads\//, NAV)
  await expect(page.getByTestId("phone-thread-title")).toBeVisible(SEE)
  await expectNoHorizontalClipping(page)
  await page.getByTestId("phone-thread-back").click(NAV)
  await expect(page).toHaveURL(/\/chats$/, NAV)
  await expectNoHorizontalClipping(page)
})
