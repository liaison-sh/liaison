// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T17. Mail at 390x844, in a real browser with touch. Until this batch
// the mail module carried no responsive class at all: the folder list lived in
// a sidebar column the phone tier does not paint, so a phone reader could see
// one folder and never leave it, and the conversation offered a desktop
// composer as its only reply affordance.
//
// It runs in the `iphone` project (see playwright.config.ts); `test.use` below
// keeps it at phone size under the default project too.
import { expect, loginAs, test } from "./fixtures/test"
import { seedMailBaseline } from "./helpers/mail-fixtures"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})

const NAV = { timeout: 30_000 } as const
const SEE = { timeout: 20_000 } as const

test("mail.phone-list-navigator-and-conversation", async ({ page, env, world }) => {
  const mail = await seedMailBaseline(env, world.admin.id, world.org.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  await expect(page.locator("[data-shell][data-shell-ready='true']")).toBeVisible(NAV)
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

  // ── 1. Work -> Mail. The screen's own large title names the FOLDER, with the
  //      account under it.
  await page.getByTestId("phone-tab-work").click(NAV)
  await expect(page.getByTestId("work-screen")).toBeVisible(SEE)
  await page.getByTestId("work-row-mail").click(NAV)
  await expect(page.getByTestId("mail-inbox")).toBeVisible(NAV)

  await expect(page.getByTestId("mail-phone-title")).toContainText("Inbox", SEE)
  // The line under the title names the account, or counts them when the QA
  // world has connected more than one: either way it is derived from the
  // account store, never left blank.
  await expect(page.getByTestId("mail-phone-account")).toHaveText(/@|accounts/, SEE)

  // ── 2. Rows carry sender, subject and preview, not just a subject line.
  const row = page.getByTestId("conversation-row").first()
  await expect(row).toBeVisible(SEE)
  await expect(page.getByTestId("mail-row-sender").first()).not.toBeEmpty()
  await expect(page.getByTestId("mail-row-subject").first()).not.toBeEmpty()
  await expect(page.getByTestId("mail-row-preview").first()).not.toBeEmpty()
  // The segmented filter is on screen and the unread seat carries its count.
  await expect(page.getByTestId("mail-filter-unread")).toBeVisible()
  await expect(page.getByTestId("mail-filter-all")).toBeVisible()
  await expect(page.getByTestId("mail-filter-starred")).toBeVisible()

  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m2-mail-list.png`, fullPage: false })
  await page.screenshot({ path: `${SHOT_DIR}/m2fx2-mail-list.png`, fullPage: false })

  // ── 3. The title is the way back into the folder list: the SAME sidebar the
  //      registry declares, in the navigator sheet.
  await page.getByTestId("mail-phone-title").click()
  const sheet = page.locator("[data-overlay-sheet][data-variant='bottom']")
  await expect(sheet).toBeVisible(SEE)
  await expect(sheet.getByTestId("mail-sidebar")).toBeVisible(SEE)
  await expect(sheet.getByTestId("mail-nav-inbox")).toBeVisible()
  await expect(sheet.getByTestId("mail-nav-starred")).toBeVisible()
  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m2-mail-navigator.png`, fullPage: false })

  // Picking a folder closes the sheet and retitles the screen.
  await sheet.getByTestId("mail-nav-starred").click()
  await expect(sheet).toBeHidden(SEE)
  await expect(page.getByTestId("mail-phone-title")).toContainText("Starred", SEE)

  // Back to the inbox, where the seeded conversations are.
  await page.getByTestId("mail-phone-title").click()
  await expect(sheet).toBeVisible(SEE)
  await sheet.getByTestId("mail-nav-inbox").click()
  await expect(sheet).toBeHidden(SEE)
  await expect(page.getByTestId("mail-phone-title")).toContainText("Inbox", SEE)

  // ── 4. A conversation: its own nav bar and the pinned action bar.
  const target = page.locator(`[data-conversation-id="${mail.conversations.withThread.id}"]`)
  await expect(target).toBeVisible(SEE)
  // A tap, not a mouse click: the row lives inside `SwipeRow`, which takes
  // explicit pointer capture on its content, and a captured MOUSE pointer
  // retargets the click to the capturing element, so the row's own handler
  // never sees it. A touch pointer releases its implicit capture at pointerup.
  await target.tap()
  await expect(page.getByTestId("mail-conversation")).toBeVisible(NAV)
  // K4: exactly ONE bar (MailConversationPhoneHeader, registered onto the
  // tab type) — the screen used to render an in-body bar of its own while
  // the same registered header (once wired) would have doubled it.
  await expect(page.getByTestId("mail-conversation-phone-header")).toHaveCount(1)
  await expect(page.getByTestId("phone-top-bar-title")).toHaveCount(0)
  await expect(page.getByTestId("mail-phone-subject")).toContainText("Client Feedback", SEE)

  const bar = page.getByTestId("mail-action-bar")
  await expect(bar).toBeVisible(SEE)
  for (const id of ["mail-action-reply", "mail-action-reply-all", "mail-action-forward"]) {
    await expect(bar.getByTestId(id)).toBeVisible()
    const box = await bar.getByTestId(id).boundingBox()
    // 44px is the floor for anything a finger has to hit.
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }

  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/m2-mail-conversation.png`, fullPage: false })
  await page.screenshot({ path: `${SHOT_DIR}/m2fx2-mail-conversation.png`, fullPage: false })

  // ── 5. The actions sheet, and Discuss: the injected message is unchanged and
  //      at phone width it lands on the DM's own ROUTE.
  await page.getByTestId("mail-phone-more").click()
  await expect(page.getByTestId("mail-more-sheet")).toBeVisible(SEE)
  for (const id of ["mail-more-archive", "mail-more-convert", "mail-more-discuss"]) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  await page.getByTestId("mail-more-discuss").click()

  await expect(page).toHaveURL(/\/threads\//, NAV)
  await expect(
    // The subject rides as a mention chip ("#Client Feedback"), so match the
    // sentence and the name, not the old "title: path" spelling.
    page.getByTestId("message-row").filter({ hasText: /I want to discuss\s*#?Client Feedback/ }),
  ).toBeVisible(NAV)
  await expectNoHorizontalClipping(page)

  // ── 6. Back to the mail list, through the seat that owns it.
  await page.getByTestId("phone-tab-work").click(NAV)
  await page.getByTestId("work-row-mail").click(NAV)
  await expect(page.getByTestId("mail-phone-title")).toBeVisible(NAV)
  await expectNoHorizontalClipping(page)
})
