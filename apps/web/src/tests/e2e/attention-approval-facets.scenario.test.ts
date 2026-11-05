// SPDX-License-Identifier: FSL-1.1-ALv2
// attention.approval-facets — the per-action filter over the Home approval rows.
//
// Approvals render as individual "needs you now" rows, so a busy queue is a
// mixed wall of them and clearing one action at a time meant picking rows out by
// eye. This scenario pins the whole contract on the real rendered feed:
//   * the facet bar appears only when 2+ distinct gated actions pend,
//   * the chips are DERIVED from what is pending (never a hardcoded app list),
//   * selecting one narrows the approval rows to that action,
//   * a non-approval urgent row is NEVER hidden by the filter,
//   * deciding the last approval of the selected action drops the selection
//     rather than stranding the operator on a filter for something gone.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import {
  grantPhase8AttentionScopes,
  resetAttentionForUser,
  seedApprovalsForFacets,
} from "./helpers/projects-seed"

test("attention.approval-facets", async ({ page, env, qa, world }) => {
  await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
  await resetAttentionForUser(env, world.org.id, qa.admin.token)

  // Two distinct gated actions, deliberately unbalanced (2 vs 1) so the ordering
  // rule (biggest pile first) is observable and not a coin flip.
  const seeded = await seedApprovalsForFacets(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    toolNames: ["test:gatedEcho", "test:gatedEcho", "test:gatedCreateItem"],
  })
  const echoIds = seeded["test:gatedEcho"]!
  const sendIds = seeded["test:gatedCreateItem"]!
  expect(echoIds).toHaveLength(2)
  expect(sendIds).toHaveLength(1)

  // The aggregator must carry `metadata.toolName` — the facet key. Without it
  // the chips cannot be built at all, so assert it at the API boundary before
  // touching the UI (a UI-only failure here would be ambiguous).
  const aggRes = await api(env.serverUrl, "/api/attention-items", { token: qa.admin.token })
  expect(aggRes.status).toBe(200)
  const items = (aggRes.body.data.items ?? aggRes.body.data) as Array<{
    kind: string
    metadata?: { toolName?: string }
  }>
  const pendingTools = items
    .filter((i) => i.kind === "approval_pending")
    .map((i) => i.metadata?.toolName)
  expect(pendingTools.filter((t) => t === "test:gatedEcho")).toHaveLength(2)
  expect(pendingTools.filter((t) => t === "test:gatedCreateItem")).toHaveLength(1)

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-home").click()
  await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })

  // 1. The bar is present with both actions faced up, biggest pile first.
  const bar = page.getByTestId("home-approval-facets")
  await expect(bar).toBeVisible()
  const echoChip = page.getByTestId("home-approval-facet-test:gatedEcho")
  const sendChip = page.getByTestId("home-approval-facet-test:gatedCreateItem")
  await expect(echoChip).toBeVisible()
  await expect(sendChip).toBeVisible()
  await expect(echoChip).toContainText("2")
  await expect(sendChip).toContainText("1")
  // Ordering: the 2-pile chip precedes the 1-pile chip in the DOM.
  const chipOrder = await bar
    .locator("[data-testid^='home-approval-facet-test:']")
    .allTextContents()
  expect(chipOrder[0]).toContain("2")

  // "All" starts selected and every approval row is mounted.
  await expect(page.getByTestId("home-approval-facet-all")).toHaveAttribute("data-active", "true")
  for (const id of [...echoIds, ...sendIds]) {
    await expect(
      page.locator(`[data-testid="attention-row-kernel-approval_request-${id}"]`),
    ).toBeVisible()
  }

  // 2. Selecting an action narrows the approval rows to that action.
  await echoChip.click()
  await expect(echoChip).toHaveAttribute("data-active", "true")
  for (const id of echoIds) {
    await expect(
      page.locator(`[data-testid="attention-row-kernel-approval_request-${id}"]`),
    ).toBeVisible()
  }
  await expect(
    page.locator(`[data-testid="attention-row-kernel-approval_request-${sendIds[0]}"]`),
  ).toHaveCount(0)

  // 3. Clicking the active chip again clears back to All.
  await echoChip.click()
  await expect(page.getByTestId("home-approval-facet-all")).toHaveAttribute("data-active", "true")
  await expect(
    page.locator(`[data-testid="attention-row-kernel-approval_request-${sendIds[0]}"]`),
  ).toBeVisible()

  // 4. Decide the ONLY gatedSend approval while it is the active filter. Its
  //    facet disappears, so the selection must fall back to All instead of
  //    leaving a list filtered by an action that no longer exists.
  await sendChip.click()
  await expect(sendChip).toHaveAttribute("data-active", "true")
  const sendRow = page.locator(
    `[data-testid="attention-row-kernel-approval_request-${sendIds[0]}"]`,
  )
  await sendRow
    .getByTestId(/approve$/)
    .first()
    .click()
  await expect(sendRow).toHaveCount(0, { timeout: 10_000 })

  // The DECISION is what matters here: the approval must leave the pending set,
  // which is what removes it from the feed and retires its facet. Whether the
  // gated tool then executes cleanly is the approval scenarios' business, not
  // this one's — asserting a terminal "approved" here would couple the facet
  // contract to whichever seeded tool's execution path we happened to pick.
  // The row hides at once; the decision is posted once the Undo window
  // (decision-queue.ts, 5 s) has passed.
  await expect
    .poll(
      async () => {
        const decided = await api(env.serverUrl, `/api/approvals/${sendIds[0]}`, {
          token: qa.admin.token,
        })
        expect(decided.status).toBe(200)
        return decided.body.data.status
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending")

  // The selection is KEPT once its last approval is decided (ticket-10225:
  // clearing a pile must not widen the view under the operator's cursor). Its
  // chip stays, at zero, the list says the filter is empty, and leaving it is
  // a deliberate click on All, after which the remaining rows are back.
  await expect(page.getByTestId("home-approval-facets")).toBeVisible()
  await expect(sendChip).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("home-facet-cleared")).toBeVisible()
  await page.getByTestId("home-approval-facet-all").click()
  // Back on All with one action left, the bar retires (a one-action picker
  // sorts nothing).
  await expect(page.getByTestId("home-approval-facets")).toHaveCount(0, { timeout: 10_000 })
  for (const id of echoIds) {
    await expect(
      page.locator(`[data-testid="attention-row-kernel-approval_request-${id}"]`),
    ).toBeVisible()
  }
})
