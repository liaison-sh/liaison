// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T13: the work surfaces at 390x844. Tickets and Approvals are where a
// phone user actually decides things, and until this batch both painted the
// desktop markup: a ticket row with nine pills and no swipe, a detail screen
// whose only reply affordance was a desktop composer, and an approval card that
// hid its three verbs behind a "more" trigger.
//
// It runs ONLY in the `iphone` project (see playwright.config.ts).
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/seed"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

/** A leftward drag across a row, as pointer events: the same stream a finger
 *  produces, which is what `SwipeRow` listens to. */
async function swipeLeft(page: import("@playwright/test").Page, selector: string) {
  const row = page.locator(selector)
  const box = await row.boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  const y = box.y + box.height / 2
  const startX = box.x + box.width - 20
  await page.mouse.move(startX, y)
  await page.mouse.down()
  for (const dx of [20, 60, 100, 130]) {
    await page.mouse.move(startX - dx, y)
  }
  await page.mouse.up()
}

test.describe("work surfaces at phone width", () => {
  test("tickets list, ticket detail and approvals are usable with a thumb", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    const orgId = world.org.id
    const inbox = await seedInbox(env, orgId, {
      name: "Phone Support",
      emailAddress: `phone-support-${Date.now()}@e2e.test`,
      isDefault: true,
    })
    const first = await seedTicket(env, orgId, {
      subject: "Pedal is not detected after the update",
      sourceInboxId: inbox.id,
      status: "open",
    })
    await seedTicket(env, orgId, {
      subject: "Refund for the second unit",
      sourceInboxId: inbox.id,
      status: "awaiting_customer",
    })
    await seedTicketMessages(env, orgId, first.id, [
      {
        kind: "inbound",
        fromEmail: "amina@example.com",
        fromName: "Amina",
        textBody: "My pedal stopped responding this morning.",
      },
    ])

    await page.reload()
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    // (a) Work -> Tickets: the screen's own title, the saved-view chips and
    //     rows that carry their state as pills.
    await page.getByTestId("phone-tab-work").tap()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await page.getByTestId("work-row-tickets").tap()
    await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("tickets-phone-header")).toContainText("Tickets")
    const chips = page.getByTestId("tickets-chip-row")
    await expect(chips).toBeVisible()
    await expect(page.getByTestId("tickets-chip-all-open")).toBeVisible()
    await expect(page.getByTestId("tickets-chip-needs-attention")).toBeVisible()

    const card = page.getByTestId(`tickets-card-${first.id}`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText("Pedal is not detected")
    // At least one state pill, derived from the seeded ticket's own data:
    // nobody has answered it and the customer wrote last.
    await expect(page.getByTestId(`tickets-card-pills-${first.id}`)).toContainText("Waiting on us")

    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-tickets.png`, fullPage: false })

    // (b) A swipe reveals Assign and Close on the row it was made on.
    const rail = page.locator(`[data-testid="tickets-swipe-${first.id}"]`)
    await swipeLeft(page, `[data-testid="tickets-swipe-${first.id}"]`)
    await expect(rail).toHaveAttribute("data-swipe-open", "true")
    await expect(rail.getByTestId("swipe-action-assign")).toBeVisible()
    await expect(rail.getByTestId("swipe-action-close")).toBeVisible()

    // (c) Select turns the rows into checkboxes.
    await page.getByTestId("tickets-select-toggle").tap()
    await expect(page.getByTestId(`tickets-card-checkbox-${first.id}`)).toBeVisible()
    await page.getByTestId("tickets-select-toggle").tap()
    await expect(page.getByTestId(`tickets-card-checkbox-${first.id}`)).toHaveCount(0)

    // (c2) The large title is the way into the navigator: hiding the phone top
    //      bar took its opener with it, and the chip row carries only the
    //      smart filters, so per-inbox counts and saved views had no way in.
    await page.getByTestId("tickets-phone-title").tap()
    const ticketsNav = page.locator("[data-overlay-sheet][data-variant='bottom']")
    await expect(ticketsNav).toBeVisible({ timeout: 15_000 })
    await expect(ticketsNav.getByTestId("tickets-sidebar")).toBeVisible({ timeout: 15_000 })
    await expect(ticketsNav.getByTestId("tickets-sidebar-inbox-all")).toBeVisible()
    await page.getByTestId("overlay-sheet-close").tap()
    await expect(ticketsNav).toBeHidden({ timeout: 15_000 })

    // (d) The ticket screen: its own nav bar, the actions sheet and the pinned
    //     action bar, then back to the list.
    await page.getByTestId(`tickets-card-subject-${first.id}`).tap()
    await expect(page.getByTestId("ticket-phone-header")).toBeVisible({ timeout: 15_000 })
    // G1: exactly one header bar, not the plain top bar stacked above
    // TicketPhoneHeader's own (the doubled-header regression this fix closes).
    await expect(page.getByTestId("ticket-phone-header")).toHaveCount(1)
    await expect(page.getByTestId("phone-top-bar-title")).toHaveCount(0)
    // K1: exactly one back control on screen (TicketPhoneHeader's own): the
    // shell's generic bar used to also render "< Tickets" beside it.
    await expect(page.getByTestId("ticket-phone-back")).toHaveCount(1)
    await expect(page.getByTestId("main-panel-back")).toHaveCount(0)
    await expect(page.getByTestId("ticket-action-bar")).toBeVisible()
    await expect(page.getByTestId("ticket-action-reply")).toBeVisible()
    // The conversation itself painted under the header, not an empty band.
    await expect(page.getByTestId("tickets-detail-stream")).toContainText(
      "stopped responding this morning",
      { timeout: 15_000 },
    )
    // 44px is the floor for anything a finger has to hit.
    const replyBox = await page.getByTestId("ticket-action-reply").boundingBox()
    expect(replyBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2fx-ticket.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m2fx2-ticket.png`, fullPage: true })

    await page.getByTestId("ticket-phone-more").tap()
    await expect(page.getByTestId("ticket-more-sheet")).toBeVisible()
    for (const id of ["ticket-more-assign", "ticket-more-category", "ticket-more-close"]) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await page.getByTestId("overlay-sheet-close").tap()
    await expect(page.getByTestId("ticket-more-sheet")).toHaveCount(0)

    await page.getByTestId("ticket-phone-back").tap()
    await expect(page.getByTestId("tickets-phone-header")).toBeVisible({ timeout: 15_000 })

    await expectNoHorizontalClipping(page)
  })

  // The approvals queue is decidable only by someone holding the request's own
  // deciding scope, so this half runs as a purpose-built approver rather than
  // the QA admin (the same actor `approvals-visual.scenario.test.ts` builds).
  test("the approvals queue decides with three verbs on screen", async ({ page, env, world }) => {
    const actor = await createApprovalActor(world, {
      name: "Phone Queue Approver",
      scopes: ["test:gated:write", "test:approve"],
    })
    await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Phone approvals queue card",
    })

    await loginAs(page, env, actor.email, actor.password)
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    // G3: Approvals is reached through Work now, not a typed URL — it used to
    // be registered as a phone tab type with no navigation surface leading to
    // it at all.
    await page.getByTestId("phone-tab-work").tap()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await expect(page.getByTestId("work-row-approvals")).toBeVisible()
    await expect(page.getByTestId("work-row-count-approvals")).toBeVisible()
    await page.getByTestId("work-row-approvals").tap()

    await expect(page.getByTestId("approvals-screen")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("approvals-summary")).toBeVisible()
    const approvalCard = page.getByTestId("approval-card").first()
    await expect(approvalCard).toBeVisible({ timeout: 15_000 })
    await expect(approvalCard.getByTestId("approval-card-deadline")).toBeVisible()
    // The first line does not wrap: the kind on the left and the deadline chip
    // on the right sit on the SAME line, which is what dropping the request id
    // from the phone card bought. Geometry, not DOM order.
    const kindBox = await approvalCard.getByTestId("approval-card-kind").boundingBox()
    const deadlineBox = await approvalCard.getByTestId("approval-card-deadline").boundingBox()
    expect(kindBox).not.toBeNull()
    expect(deadlineBox).not.toBeNull()
    expect(Math.abs(kindBox!.y - deadlineBox!.y)).toBeLessThanOrEqual(2)
    await expect(approvalCard.getByTestId("approval-card-action-deny")).toBeVisible()
    await expect(approvalCard.getByTestId("approval-card-action-approve")).toBeVisible()
    // K2: the shell's generic bar used to show ABOVE this screen's own large
    // title; it hides entirely now, matching Chats and Work.
    await expect(page.getByTestId("phone-top-bar-title")).toHaveCount(0)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2fx-approvals.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m2fx2-approvals.png`, fullPage: true })

    await approvalCard.getByTestId("approval-card-action-deny").tap()
    await expect(page.getByTestId("approval-deny-sheet")).toBeVisible()
    await expect(page.getByTestId("approval-card-deny-reason")).toBeVisible()
    await expectNoHorizontalClipping(page)
  })
})
