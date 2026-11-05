// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Skill approval cards render a reviewable view instead of a raw payload dump:
 *   - update_skill -> a git-style body diff (removed red, added green).
 *   - create_skill -> the complete skill (name, visibility, description, body).
 * Functional (testid) assertions; the pixel baselines live in
 * approvals-visual.scenario.test.ts. Deterministic (seeded approvals, no
 * LLM turn). Metachar-free describe title so it survives unescaped `--grep`.
 */
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval, seedOrgSkill } from "./helpers/approvals-seed"

async function openCard(page: Page, approvalRequestId: string) {
  const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
  await tab.getByTestId("message-row-tools-toggle").first().click()
  const card = tab.locator(`[data-testid="approval-card"][data-request-id="${approvalRequestId}"]`)
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

test.describe("Skill approval cards", () => {
  test("update_skill renders a body diff (removed + added), not a raw payload dump", async ({
    page,
    env,
    world,
  }) => {
    const actor = await createApprovalActor(world, {
      name: "Skill Reviewer",
      // The diff view fetches the current skill to diff against.
      scopes: ["kernel:skills:read", "kernel:skills:write"],
    })
    const oldBody =
      "# Support voice\n\nKeep replies short.\n\n## Register\n- Two to five sentences per reply.\n- Stay warm."
    const newBody =
      "# Support voice\n\nKeep replies short and chill.\n\n## Register\n- Two to four sentences per reply.\n- Stay warm.\n- No filler closers."
    const skillId = await seedOrgSkill(env, world.org.id, "team-voice", oldBody)

    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      title: "Update skill E2E",
      toolCallMessage: true,
      toolName: "kernel:update_skill",
      params: { id: skillId, body: newBody },
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

    const card = await openCard(page, seeded.approvalRequestId)
    const diff = card.getByTestId("skill-approval-diff")
    await expect(diff).toBeVisible({ timeout: 10000 })
    await expect(diff).toContainText("Two to five sentences per reply.") // removed
    await expect(diff).toContainText("Two to four sentences per reply.") // added
    await expect(diff).toContainText("No filler closers.") // added
    await expect(card.getByTestId("skill-approval-added")).toHaveText("+3")
    await expect(card.getByTestId("skill-approval-removed")).toHaveText("-2")
    // The raw flattened payload AND the generic message block are suppressed for
    // skill kinds (the diff is the single source of truth, no duplicate dumps).
    await expect(card.getByTestId("approval-card-payload")).toHaveCount(0)
    await expect(card.getByTestId("approval-card-message")).toHaveCount(0)
  })

  test("create_skill renders the complete skill (name + full body)", async ({
    page,
    env,
    world,
  }) => {
    const actor = await createApprovalActor(world, {
      name: "Skill Creator",
      scopes: ["kernel:skills:write"],
    })
    const body = "# Greeting skill\nAlways say hello\nand be brief"

    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      title: "Create skill E2E",
      toolCallMessage: true,
      toolName: "kernel:create_skill",
      params: {
        name: "greeting-skill",
        description: "Says hello",
        visibility: "org",
        body,
      },
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

    const card = await openCard(page, seeded.approvalRequestId)
    await expect(card.getByTestId("skill-approval-create")).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId("skill-approval-name")).toHaveText("greeting-skill")
    const bodyBlock = card.getByTestId("skill-approval-body")
    await expect(bodyBlock).toContainText("# Greeting skill")
    await expect(bodyBlock).toContainText("and be brief")
    // No redundant generic "Message" block (SkillApprovalView owns the body).
    await expect(card.getByTestId("approval-card-message")).toHaveCount(0)
  })

  test("create_skill with a domain shows the Domain line on the card", async ({
    page,
    env,
    world,
  }) => {
    const actor = await createApprovalActor(world, {
      name: "Domain Creator",
      scopes: ["kernel:skills:write"],
    })
    const body = "# Shipping skill\nHelp with shipping"

    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      title: "Create skill with domain E2E",
      toolCallMessage: true,
      toolName: "kernel:create_skill",
      params: {
        name: "shipping-skill",
        description: "Handles shipping",
        visibility: "org",
        domain: "shipping",
        body,
      },
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)

    const card = await openCard(page, seeded.approvalRequestId)
    await expect(card.getByTestId("skill-approval-create")).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId("skill-approval-name")).toHaveText("shipping-skill")
    const domainLine = card.getByTestId("skill-approval-domain")
    await expect(domainLine).toBeVisible()
    await expect(domainLine).toContainText("Domain:")
    await expect(domainLine).toContainText("shipping")
  })
})
