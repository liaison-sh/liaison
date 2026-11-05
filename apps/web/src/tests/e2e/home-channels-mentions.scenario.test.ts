// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Home: agent channel and mention flows (P4b-T29).
//
// Drives the REAL UI of a deployed Liaison against a staging box, not the
// per-worker local stack every other scenario spawns: STAGING_BASE_URL points
// the browser at the box, STAGING_QA_EMAIL / STAGING_QA_PASSWORD name the
// QA-seeded user (scripts/seed-qa.ts). Without STAGING_BASE_URL the whole file
// skips, so a local suite run never fails for want of a box.
//
// Box setup this scenario expects (operator side, never in the tree): the QA
// seed, the four role agents, the home channels seeded, the QA user NOT yet a member
// of the channel, and exactly one auto-eligible row in kernel.model_pricing
// (claude-haiku-4-5), which is how every agent turn here runs on haiku. Two
// model turns are spent: one channel mention and one DM.
//
// The steps are separate serial tests so one failing product behaviour reports
// itself and the later steps still run.
import { type Browser, expect, type Page, test } from "@playwright/test"

const BASE_URL = process.env.STAGING_BASE_URL ?? ""
const EMAIL = process.env.STAGING_QA_EMAIL ?? "amina@resonantaudiolabs.example"
const PASSWORD = process.env.STAGING_QA_PASSWORD ?? "QaPass1!"
const CHANNEL = process.env.STAGING_CHANNEL_HANDLE ?? "support"
const AGENT_HANDLE = process.env.STAGING_AGENT_HANDLE ?? "@support"
const AGENT_NAME = process.env.STAGING_AGENT_NAME ?? "Support"
/** An agent NOT seated in the channel, so mentioning it must auto-add it. */
const OUTSIDE_AGENT_HANDLE = process.env.STAGING_OUTSIDE_AGENT_HANDLE ?? "@finance"
const OUTSIDE_AGENT_NAME = process.env.STAGING_OUTSIDE_AGENT_NAME ?? "Finance"
/** Bounded wait proving the negative: an unrelated message fires no turn. */
const NO_TURN_WINDOW_MS = 30_000
const TURN_TIMEOUT_MS = 120_000

test.describe("Home: agent channel and mention flows", () => {
  test.skip(!BASE_URL, "STAGING_BASE_URL not set - this scenario needs a deployed box")
  test.describe.configure({ mode: "serial", timeout: 180_000 })

  let page: Page
  let agentsBefore = 0

  const composer = () => page.getByRole("textbox", { name: "Write a message" })
  const agentMessages = () => page.locator('[data-message-author="agent"]')
  const channelsGroup = () => page.locator('[data-testid="thread-group"][data-group="Channels"]')
  const dmGroup = () => page.locator('[data-testid="thread-group"][data-group="Direct messages"]')

  /** Sign in through the real password form, the same surface the local suite uses. */
  async function signIn() {
    await page.goto(`${BASE_URL}/login`)
    const passwordToggle = page.getByRole("button", { name: /sign in with a password/i })
    await passwordToggle.waitFor({ state: "visible", timeout: 60_000 })
    await passwordToggle.click()
    await page.getByLabel("Password").waitFor({ state: "visible", timeout: 15_000 })
    await page.getByLabel("Email").fill(EMAIL)
    await page.getByLabel("Password").fill(PASSWORD)
    await page.getByRole("button", { name: /^sign in$/i }).click()
    await page.waitForSelector("[data-shell]", { timeout: 60_000 })
  }

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    page = await browser.newPage()
    await signIn()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("the QA user signs in and the sidebar splits Channels and Direct messages", async () => {
    await expect(channelsGroup()).toBeVisible({ timeout: 30_000 })
    await expect(dmGroup()).toBeVisible({ timeout: 30_000 })
  })

  test("the channel is discoverable under a folded sub-section, and the row joins and opens it", async () => {
    // Card 31: the channels a member can join are a collapsed sub-section at
    // the foot of Channels, and each one is an ordinary row that joins and
    // opens on click. The topic, member count and agent roster live in the
    // thread header the row lands on.
    const toggle = page.getByTestId("thread-group-toggle-joinableChannels")
    await expect(toggle).toBeVisible({ timeout: 30_000 })
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()

    const unjoined = page
      .locator('[data-testid="unjoined-channel"]')
      .filter({ hasText: CHANNEL })
      .first()
    await expect(unjoined).toBeVisible({ timeout: 30_000 })

    await unjoined.click()

    const joinedRow = channelsGroup()
      .locator('[data-testid="thread-item"]')
      .filter({ hasText: CHANNEL })
      .first()
    await expect(joinedRow).toBeVisible({ timeout: 30_000 })
    await joinedRow.click()
    await expect(composer()).toBeVisible({ timeout: 30_000 })

    // The open channel carries an agent seat (the glyph avatar in the stack).
    await expect(
      page
        .getByRole("group", { name: /participants/ })
        .locator("[data-agent-glyph]")
        .first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  test("an unrelated channel message fires no agent turn", async () => {
    agentsBefore = await agentMessages().count()
    const text = `logistics note ${Date.now()}`
    await composer().click()
    await page.keyboard.type(text)
    await page.keyboard.press("Enter")
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(NO_TURN_WINDOW_MS)
    expect(await agentMessages().count()).toBe(agentsBefore)
  })

  test("mentioning a non-member agent posts the auto-add system line", async () => {
    agentsBefore = await agentMessages().count()
    await composer().click()
    await page.keyboard.type(OUTSIDE_AGENT_HANDLE)
    const suggestion = page.getByTestId("mention-result-agent").first()
    await expect(suggestion).toBeVisible({ timeout: 15_000 })
    await suggestion.click()
    await page.keyboard.type(" say hi in one short sentence")
    await page.keyboard.press("Enter")

    await expect(page.getByText(/added .*\(mentioned\)/).first()).toBeVisible({ timeout: 30_000 })
  })

  test("the mentioned agent answers and the reply is attributed to it", async () => {
    await expect
      .poll(async () => await agentMessages().count(), { timeout: TURN_TIMEOUT_MS })
      .toBeGreaterThan(agentsBefore)
    const reply = agentMessages().last()
    await expect(reply.getByText("Agent").first()).toBeVisible()
    await expect(reply).toContainText(OUTSIDE_AGENT_NAME)
  })

  test("a DM with the channel agent answers too", async () => {
    // No UI entry point starts a DM with a role agent (the only caller of
    // POST /threads/dm is the withheld-capability card), so the DM is opened
    // over the real API from the logged-in page itself, then driven in the UI.
    const dm = await page.evaluate(
      async ({ email, password, handle }) => {
        // A second password login rotates the browser's own session out, so
        // the page signs in again below before it is driven any further.
        const login = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        })
        const token = (await login.json()).data.accessToken
        const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" }
        const dir = await fetch("/api/agents", { headers: auth })
        const agents = (await dir.json()).data as Array<{ id: string; handle: string }>
        const agent = agents.find((a) => a.handle === handle)
        if (!agent) return { status: 0, found: false }
        const res = await fetch("/api/threads/dm", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ agentId: agent.id }),
        })
        return { status: res.status, found: true }
      },
      { email: EMAIL, password: PASSWORD, handle: AGENT_HANDLE },
    )
    expect(dm.found, `no ${AGENT_HANDLE} in the agent directory`).toBe(true)
    expect([200, 201]).toContain(dm.status)

    await signIn()
    const dmRow = dmGroup()
      .locator('[data-testid="thread-item"]')
      .filter({ hasText: AGENT_NAME })
      .first()
    await expect(dmRow).toBeVisible({ timeout: 30_000 })
    await dmRow.click()
    await expect(composer()).toBeVisible({ timeout: 30_000 })

    const before = await agentMessages().count()
    await composer().click()
    await page.keyboard.type("one word answer please: ok?")
    await page.keyboard.press("Enter")
    await expect
      .poll(async () => await agentMessages().count(), { timeout: TURN_TIMEOUT_MS })
      .toBeGreaterThan(before)
  })
})
