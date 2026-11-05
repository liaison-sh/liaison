// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-A T5: the phone shell, driven at 390x844 with touch. It covers the three
// things the tier had no navigation for before this batch: the five fixed
// seats, the Work screen that replaces the old overflow sheet, and the
// navigator that is the only way to a registry-declared app sidebar below
// 640px. It runs ONLY in the `iphone` project (see playwright.config.ts).
import { expect, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.describe("phone shell", () => {
  test("five seats, Work, the mail navigator and the Chats list", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    // An approval row on Home is the one that carries a Details control
    // (F2): deadline metric, Approve, Reject and Details all on one row,
    // which is exactly what overflowed the 390px viewport before the fix.
    const requester = await createApprovalActor(world, {
      name: "Phone Width Requester",
      scopes: ["test:gated:write"],
    })
    await seedGatedApproval(env, world.org.id, {
      requesterUserId: requester.id,
      participantUserIds: [world.admin.id],
      approverUserIds: [world.admin.id],
      title: "Phone Home approval row width",
    })
    // authenticatedPage already navigated before the seed above existed;
    // reload so Home's initial feed fetch picks up the new approval row.
    await page.reload()

    // (a) Home: the bar is five fixed seats, in order.
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")
    const bar = page.getByTestId("phone-tab-bar")
    await expect(bar).toBeVisible()
    const seatIds = await bar
      .locator("button")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))
    expect(seatIds).toEqual([
      "phone-tab-home",
      "phone-tab-chats",
      "phone-tab-work",
      "phone-tab-search",
      "phone-tab-you",
    ])
    // Home is a real screen: the greeting and the attention feed, not an
    // empty band between the two bars (F1).
    await expect(page.getByTestId("home-phone")).toBeVisible()
    await expect(page.getByTestId("home-greeting")).toBeVisible()

    // A jsdom test cannot measure real layout, so the "does not overflow the
    // viewport" assertion for the approval row's Details control (F2) lives
    // here, against the real rendered page. It must be non-vacuous: the
    // seeded approval above puts at least one `-details` control on Home.
    const detailsControls = page.locator('[data-testid$="-details"]')
    // The feed's initial fetch races the reload above: wait (with retry) for
    // the seeded approval's row to actually paint before reading a snapshot
    // count, rather than sampling `.count()` once against an empty feed.
    await expect(detailsControls.first()).toBeVisible({ timeout: 15000 })
    const detailsCount = await detailsControls.count()
    expect(detailsCount).toBeGreaterThan(0)
    await expectNoHorizontalClipping(page)

    await page.screenshot({ path: `${SHOT_DIR}/m1a-1.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m1fx-home.png`, fullPage: true })

    // (b) Work lists the modules the workspace carries, and the round Chats
    // opener that used to float over it is gone (F2).
    await page.getByTestId("phone-tab-work").click()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await expect(page.getByTestId("work-row-tickets")).toBeVisible()
    await expect(page.getByTestId("work-row-mail")).toBeVisible()
    await expect(page.getByTestId("chats-sheet-opener")).toHaveCount(0)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m1a-2.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m1fx-work.png`, fullPage: true })

    // (c) Mail: its registered sidebar is reachable, and only through the
    // navigator. K4: the mail list hides the shell's generic bar entirely (it
    // owns its own large folder title, like Chats/Work/Approvals), so the
    // navigator opener that used to sit in that bar is gone — the title
    // itself is the way in, exactly as it already worked before this batch.
    // Picking a folder closes the sheet on the result.
    await page.getByTestId("work-row-mail").click()
    const opener = page.getByTestId("mail-phone-title")
    await expect(opener).toBeVisible()
    await expect(page.locator("[data-overlay-sheet]")).toHaveCount(0)

    await opener.click()
    const sheet = page.locator('[data-overlay-sheet][data-variant="bottom"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId("mail-sidebar")).toBeVisible()
    await expect(sheet.getByTestId("mail-nav-sent")).toBeVisible()
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m1a-3.png`, fullPage: true })

    await sheet.getByTestId("mail-nav-sent").click()
    await expect(sheet).toHaveCount(0)

    // (c2) Picking the ALREADY-ACTIVE folder (we are on Sent right now) fires
    // no navigation at all — same tab, same route — so the sheet must still
    // close on the tap itself, not on a navigation that never happens (F1).
    await opener.click()
    await expect(sheet).toBeVisible()
    await sheet.getByTestId("mail-nav-sent").click()
    await expect(sheet).toHaveCount(0)

    // (d) Chats is a ROOT SCREEN (F3): the seat opens it as a tab, the tab bar
    // stays put, and there is no sheet header over the list's own title.
    await page.getByTestId("phone-tab-chats").click()
    const chats = page.getByTestId("chats-screen")
    await expect(chats).toBeVisible()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(page.locator('[data-overlay-sheet][data-variant="full"]')).toHaveCount(0)
    await expect(page.getByTestId("phone-tab-bar")).toBeVisible()
    await expect(chats.getByTestId("chats-title")).toBeVisible()
    const personalRow = chats.getByTestId("chats-personal-agent-row")
    await expect(personalRow).toBeVisible()
    // The Chats list is grouped (Unread, Channels, Direct messages): the
    // personal agent's row heads the group it is in, Direct messages unless
    // it has unread messages.
    const personalSection = personalRow.locator("xpath=ancestor::section[1]")
    await expect(personalSection).toHaveAttribute("data-section", /^(directMessages|unread)$/)
    const firstRowTestId = await personalSection
      .locator('[role="listitem"]')
      .first()
      .locator("button")
      .first()
      .getAttribute("data-testid")
    expect(firstRowTestId).toBe("chats-personal-agent-row")
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m1a-4.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m1fx-chats.png`, fullPage: true })

    // (e) Picking the personal agent pushes its thread; the top bar is that
    // conversation's nav bar (F4) and Back returns to Chats. K1: the bar's
    // back control is now owned entirely by ThreadPhoneHeader (the shell
    // renders none of its own once a tab type registers a header), so the
    // control and its "came from" label carry the thread's OWN testids.
    await personalRow.click()
    await expect(page).toHaveURL(/\/threads\//)
    await expect(page.getByTestId("phone-thread-header")).toBeVisible()
    await expect(page.getByTestId("phone-thread-actions")).toBeVisible()
    await expect(page.getByTestId("main-panel-back")).toHaveCount(0)
    await expect(page.getByTestId("phone-thread-back-label")).toHaveText("Chats")
    await expect(page.getByTestId("phone-tab-chats")).toHaveAttribute("aria-current", "page")
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m1fx-thread.png`, fullPage: true })

    await page.getByTestId("phone-thread-back").click()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(page.getByTestId("chats-screen")).toBeVisible()
    await expectNoHorizontalClipping(page)
  })
})
