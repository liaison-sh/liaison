// SPDX-License-Identifier: FSL-1.1-ALv2
// Compound / sequenced gated operations — visual validation (S5).
//
// Captures component-scoped baselines of the bundle ApprovalCard so a
// regression in the stacked-steps rendering or the per-step editor is not
// masked by surrounding thread/sidebar churn. Two states: the default bundle
// card and the card with a step's inline editor open.
import { expect, loginAs, test } from "./fixtures/test"
import { createScenarioThread, formBundle, openBundleCard } from "./helpers/bundle-seed"

const QA_PASSWORD = "QaPass1!"
const TIME_MASK = /minutes? ago|just now|hours? ago|days? ago/
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.02 }

async function waitForFontsAndSettle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
}

test.describe("Compound approval — bundle card visuals", () => {
  test("bundle approval card — default and step-editing states", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // Amina (requester) cannot self-approve under the human-bypass model
    // — her `test:approve` is revoked in the QA seed. The bundle card's
    // "Approve sequence" button only renders for an eligible approver, so
    // drive the UI as Tobias (test:approve scope preserved). Amina still
    // forms the bundle so eligibleApprovers auto-adds Tobias to its audience.
    const amina = qa.amina
    const tobias = qa.tobias
    const threadId = await createScenarioThread(env, {
      ownerUserId: amina.id,
      orgId: world.org.id,
      title: "Compound approval S5",
      additionalParticipantUserIds: [tobias.id],
    })
    const bundle = await formBundle(env, {
      orgId: world.org.id,
      threadId,
      token: amina.token,
      requesterUserId: amina.id,
      seed: "alpha",
      label: "original",
    })

    await loginAs(page, env, tobias.email, QA_PASSWORD)
    const card = await openBundleCard(page, env, threadId, bundle.headId)

    // State 1 — default bundle card: head summary + one stacked step,
    // primary button labelled "Approve sequence".
    await expect(card.getByTestId("approval-bundle-steps")).toBeVisible()
    await expect(card.getByTestId("approval-card-action-approve")).toContainText("Approve sequence")
    await waitForFontsAndSettle(page)
    await expect(card).toHaveScreenshot("bundle-approval-card-default.png", {
      ...SCREENSHOT_OPTS,
      mask: [card.locator(`text=${TIME_MASK}`)],
    })

    // State 2 — step-editing: the deferred step's `label` editor open.
    const step = card.getByTestId("approval-bundle-step-1")
    await step.getByTestId("approval-bundle-step-1-edit").click()
    await expect(step.getByTestId("approval-bundle-step-1-field-label")).toBeVisible()
    await waitForFontsAndSettle(page)
    await expect(card).toHaveScreenshot("bundle-approval-card-step-editing.png", {
      ...SCREENSHOT_OPTS,
      mask: [card.locator(`text=${TIME_MASK}`)],
    })
  })
})
