// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Approval authority, browser-side: a CUSTOM-scope approval (approve_scope =
 * kernel:skills:approve) renders live Approve/Deny for the holder of that
 * scope — the exact card that rendered button-less in prod on 2026-08-06,
 * when the web recomputed the deciding scope as admin-grade kernel:approve
 * from the tool name. Also pins the provenance strip (governing-scope chip)
 * and the negative: a notified holder of ONLY kernel:approve gets a card with
 * no decision actions. The approve goes through the real backend decide and
 * lands in audit_log attributed to the actual decider.
 *
 * Functional (testid) assertions; deterministic seeded approval, no LLM turn.
 * Metachar-free describe title so it survives unescaped `--grep`.
 */
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"
import { ks } from "./helpers/db-reads"
import { grantUserDimension } from "./helpers/seed"

async function openCard(page: Page, approvalRequestId: string) {
  const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await tab.getByTestId("message-row-tools-toggle").first().click()
  const card = tab.locator(`[data-testid="approval-card"][data-request-id="${approvalRequestId}"]`)
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

test.describe("Approval authority visibility", () => {
  test("custom-scope approval is decidable by its scope holder, tracked in audit_log; kernel:approve alone gets no actions", async ({
    page,
    env,
    world,
  }) => {
    // The issuer holds the tool scope so the approved handler re-entry (which
    // runs as the requester) succeeds; NO approve scopes. A skill proposal is
    // decided by the custom `kernel:skills:approve`, within the skill's domain.
    const issuer = await createApprovalActor(world, {
      name: "Authority Issuer",
      scopes: ["kernel:skills:write"],
    })
    // The C-Level persona: the row's custom scope, nothing admin.
    const skillsApprover = await createApprovalActor(world, {
      name: "Authority Skills Approver",
      scopes: ["kernel:skills:approve"],
    })
    await grantUserDimension(env, world.org.id, skillsApprover.id, "kernel:skills_domain", ["*"])
    // Notified, but holding only the admin-grade generic scope.
    const genericAdmin = await createApprovalActor(world, {
      name: "Authority Generic Admin",
      scopes: ["kernel:approve"],
    })

    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: issuer.id,
      participantUserIds: [issuer.id, skillsApprover.id, genericAdmin.id],
      title: "Authority visibility E2E",
      toolName: "kernel:create_skill",
      params: {
        name: "authority-visibility-skill",
        description: "Custom-scope gated action",
        visibility: "org",
        domain: "support",
        body: "# Authority\nDecided by the skills approver.",
      },
    })

    // ── The generic admin FIRST (while the row is still pending): although
    // notified, they hold only kernel:approve — NOT the row's deciding scope —
    // so RLS refuses the row entirely: the inline card cannot even load, let
    // alone offer actions. (Stronger than a button-less card: the row does
    // not exist for them.)
    await loginAs(page, env, genericAdmin.email, genericAdmin.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const adminCard = await openCard(page, seeded.approvalRequestId)
    await expect(adminCard.getByTestId("approval-card-error")).toBeVisible({ timeout: 10000 })
    await expect(adminCard.getByTestId("approval-card-action-approve")).toHaveCount(0)
    await expect(adminCard.getByTestId("approval-card-action-deny")).toHaveCount(0)

    // ── The custom-scope holder: live Approve/Deny + the governing-scope chip.
    await loginAs(page, env, skillsApprover.email, skillsApprover.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const card = await openCard(page, seeded.approvalRequestId)

    const scopeChip = card.getByTestId("approval-card-scope")
    await expect(scopeChip).toBeVisible()
    await expect(scopeChip).toHaveText("needs Workspace approval")
    await expect(scopeChip).toHaveAttribute("data-scope", "kernel:skills:approve")

    const approveBtn = card.getByTestId("approval-card-action-approve")
    await expect(approveBtn).toBeVisible()
    await expect(card.getByTestId("approval-card-action-deny")).toBeVisible()

    const start = new Date().toISOString()
    await approveBtn.click()
    await expect(card.getByTestId("approval-card-status-badge")).toHaveText("Approved", {
      timeout: 15000,
    })
    // Provenance names the decider once decided (the viewer, here).
    await expect(card.getByTestId("approval-card-decided-by")).toContainText("Approved by you")

    // Audit: the decision reached audit_log through the real decide -> outbox
    // chain, attributed to the DECIDER (time-scoped poll; ~1s outbox worker).
    await expect
      .poll(
        async () => {
          const rows = await env.db.sql.unsafe(
            `SELECT actor_id FROM ${ks(env)}.audit_log
             WHERE org_id = $1 AND entity_type = 'approval_request'
               AND entity_id = $2 AND timestamp >= $3`,
            [world.org.id, seeded.approvalRequestId, start],
          )
          return rows.some(
            (r) => (r as unknown as { actor_id: string }).actor_id === skillsApprover.id,
          )
        },
        { timeout: 25000, intervals: [500, 1000, 1500, 2000] },
      )
      .toBe(true)
  })
})
