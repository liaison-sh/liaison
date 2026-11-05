// SPDX-License-Identifier: FSL-1.1-ALv2
// ─────────────────────────────────────────────────────────────────────────────
// Visual + semantic regression — ApprovalCard attachment provenance (C1)
//
// The one UI surface the generic agent file-attachment feature changed: the
// approval card now lists each outbound attachment's filename + origin, and
// prefixes ⚠ on any file pulled from a different conversation/ticket than the
// one being replied to (review fix B1). This test seeds an approval whose
// `summary.lines` carry three realistic provenance lines and verifies both the
// rendered DOM (the semantic check) and a cropped visual golden.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"

async function waitForFontsAndSettle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
}

const TIME_MASK = /minutes? ago|just now|hours? ago|days? ago/

test.describe("Approval Card — attachment provenance", () => {
  test("renders provenance lines and flags a cross-customer file with ⚠", async ({
    page,
    env,
    world,
  }) => {
    const actor = await createApprovalActor(world, {
      name: "Provenance Reviewer",
      scopes: ["test:gated:write", "test:approve"],
    })
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Attachment provenance review",
      toolCallMessage: true,
      lines: [
        "📎 return-label.pdf — from a ticket",
        "⚠ 📎 other-customer-invoice.pdf — from a ticket",
        "📎 Q3 Report.pdf — from Google Drive",
      ],
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    const card = tab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(card).toBeVisible({ timeout: 10000 })
    await waitForFontsAndSettle(page)

    // ── Semantic check: the rendered DOM lines ──────────────────────────────
    // The curated-summary lines render as <li> inside the card, but so does
    // the always-on "Exact payload" section (data-testid="approval-card-payload"),
    // which now renders one <li> per flattened payload field. XPath-exclude
    // any <li> that is a descendant of that section so this count reflects
    // only the curated summary lines.
    const payloadSection = card.locator('[data-testid="approval-card-payload"]')
    const lines = card.locator(
      'xpath=.//ul/li[not(ancestor::*[@data-testid="approval-card-payload"])]',
    )
    await expect(lines).toHaveCount(3)
    await expect(payloadSection).toBeVisible()

    const crossLine = lines.filter({ hasText: "other-customer-invoice.pdf" })
    const cleanLine = lines.filter({ hasText: "return-label.pdf" })
    const driveLine = lines.filter({ hasText: "Q3 Report.pdf" })

    // The cross-customer file is flagged; the others are not (review fix B1).
    await expect(crossLine).toContainText("⚠")
    await expect(cleanLine).not.toContainText("⚠")
    await expect(driveLine).not.toContainText("⚠")
    // The Drive-imported file is labelled by where it came from (review fix C2).
    await expect(driveLine).toContainText("Google Drive")
    // Negative assertion (anti rubber-stamp): the clean line really has no ⚠.
    await expect(cleanLine).toContainText("return-label.pdf")

    // ── Visual golden — cropped to the card, timestamps masked ──────────────
    await expect(card).toHaveScreenshot("approval-card-attachment-provenance.png", {
      maxDiffPixelRatio: 0.02,
      mask: [card.locator(`text=${TIME_MASK}`)],
    })
  })

  test("escapes crafted markup in an attachment filename — no element injected", async ({
    page,
    env,
    world,
  }) => {
    const actor = await createApprovalActor(world, {
      name: "XSS Probe Reviewer",
      scopes: ["test:gated:write", "test:approve"],
    })
    const craftedName = "<img src=x onerror=alert(1)>.pdf"
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Attachment markup escaping",
      toolCallMessage: true,
      lines: [`📎 ${craftedName} — from a ticket`],
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    const card = tab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(card).toBeVisible({ timeout: 10000 })

    // The crafted filename renders as literal text — never as an injected node.
    await expect(card.locator("ul > li").first()).toContainText(craftedName)
    expect(await card.locator("ul > li img").count()).toBe(0)
  })
})
