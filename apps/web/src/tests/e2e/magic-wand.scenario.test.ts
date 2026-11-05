// SPDX-License-Identifier: FSL-1.1-ALv2
// magic-wand — MW1: the real situation. Sloppy ticket reply → click the wand →
// real cheap-LLM correction in place → single Ctrl/Cmd-Z reverts it. Skips
// gracefully when GOOGLE_API_KEY is absent (mirrors the agent S8 google canary),
// and runs only when PLAYWRIGHT_LIVE_LLM=1 asks for live-LLM journeys.
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { LIVE_LLM, LIVE_LLM_SKIP_REASON } from "./helpers/live-llm"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"

test("[MW1] magic wand corrects a sloppy ticket reply in the real UI", async ({
  page,
  env,
  qa,
  world,
}) => {
  test.skip(!LIVE_LLM, LIVE_LLM_SKIP_REASON)
  test.skip(!process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY not set — real-LLM journey skipped")

  const orgId = world.org.id
  const stamp = Date.now()

  // Seed BEFORE login so the proofread auto-model resolves on first call.
  await seedModelPricingAndCredits(env, orgId, { included: "50.00000000" })
  await grantTicketsScopes(env, orgId, qa.admin.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:approve",
  ])
  const inbox = await seedInbox(env, orgId, {
    name: `Wand inbox ${stamp}`,
    emailAddress: `wand-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Wand ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 10_000 })

  const sloppy = "i recieve teh colorfull lettre yesterdey"
  const body = page.getByTestId("tickets-composer-body")
  await body.fill(sloppy)

  await page.getByTestId("magic-wand").click()
  // The button disables while running, then re-enables when the correction lands.
  await expect(page.getByTestId("magic-wand")).toBeDisabled()
  await expect(page.getByTestId("magic-wand")).toBeEnabled({ timeout: 30_000 })

  const corrected = await body.innerText()
  expect(corrected).not.toBe(sloppy)
  expect(corrected.toLowerCase()).not.toContain("recieve")
  expect(corrected.toLowerCase()).not.toContain("teh ")

  // Real-browser native undo restores the original text in one step. The wand
  // writes via execCommand("insertText"), which lands on the native undo stack.
  await body.click()
  await page.keyboard.press("ControlOrMeta+z")
  await expect(body).toHaveText(sloppy)
})
