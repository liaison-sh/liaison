// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first run, in a real browser against the real server and job worker:
// the first administrator of a brand-new workspace signs in, and their agent
// conversation (pinned for them) opens with the "Set up your space" card: the
// checklist, the embedded key card (no model key on this lane) and the demo
// offer, at desktop and phone width. The QA world's admin, in a workspace
// where people have already written, signs in and gets no card.
//
// This scenario's server runs with LIAISON_SETUP_KICKOFF on; every other
// scenario's server leaves it at its test default (off).
import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { createProfiledE2ETest, type ProfiledWorkerEnv } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedFactory } from "./helpers/seed"
import { SHOT_DIR } from "./helpers/shot-dir"

const test = createProfiledE2ETest({
  workerIdOffset: 50,
  portCount: 2,
  // No deployment model key either: a new workspace with no key of its own is
  // the case the embedded key card exists for.
  before: async () => ({
    env: {
      LIAISON_SETUP_KICKOFF: "true",
      LIAISON_ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      MISTRAL_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
    teardowns: [],
  }),
})

const PASSWORD = "FirstRun-2026!"

/** A brand-new workspace with one administrator and nothing written in it. */
async function newWorkspace(env: ProfiledWorkerEnv): Promise<{ email: string; orgId: string }> {
  const email = `first-admin-${randomUUID().slice(0, 8)}@acme.example`
  const org = await seedFactory<{ orgId: string }>(env, undefined, "org.second", {
    orgName: "Acme Audio",
    adminEmail: email,
    adminPassword: PASSWORD,
    adminName: "Nadia Owner",
  })
  return { email, orgId: org.orgId }
}

/** Open the person's agent conversation and wait for the card the job posts. */
async function openSetupConversation(page: Page, phone: boolean): Promise<void> {
  // The person's agent conversation: the agents group's row, or the DM row.
  const row = page
    .getByTestId("chats-personal-agent-row")
    .or(page.getByTestId("thread-item").filter({ hasText: "Personal agent" }))
    .or(page.getByTestId("chat-row").filter({ hasText: "Personal agent" }))
    .first()
  for (let attempt = 0; attempt < 6; attempt++) {
    if (phone) await page.getByTestId("phone-tab-chats").tap()
    else await page.getByTestId("activity-messages").click()
    await row.waitFor({ state: "visible", timeout: 30_000 })
    if (phone) await row.tap()
    else await row.click()
    const card = page.getByTestId("setup-kickoff-row")
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) return
    await page.reload()
    await page.waitForSelector("[data-shell]", { timeout: 60_000 })
  }
  await expect(page.getByTestId("setup-kickoff-row")).toBeVisible()
}

async function expectCard(page: Page): Promise<void> {
  const card = page.getByTestId("setup-kickoff-row")
  await expect(card).toContainText("Set up your space")
  await expect(page.getByTestId("setup-item-aiKey")).toHaveAttribute("data-done", "false")
  await expect(page.getByTestId("setup-item-import")).toContainText("optional")
  // No model key on this lane: the key card is part of the card.
  await expect(card.getByTestId("secret-request-form")).toBeVisible()
  const demo = page.getByTestId("setup-demo-link")
  await expect(demo).toHaveCount(1)
  await expect(demo).toHaveAttribute("href", "https://demo.liaison.sh")
  await expect(demo).toHaveAttribute("target", "_blank")
  // The conversation is pinned for this person (its header carries the mark).
  await expect(page.getByTestId("setup-kickoff-row")).toHaveCount(1)
}

test("a new workspace's first admin finds the setup card in their agent conversation", async ({
  page,
  env,
}) => {
  test.setTimeout(180_000)
  const { email } = await newWorkspace(env)
  await loginAs(page, env, email, PASSWORD)
  await openSetupConversation(page, false)
  await expectCard(page)
  await page.screenshot({ path: `${SHOT_DIR}/setup-first-run-1280.png` })
})

// `world` although the test signs in as its own workspace's admin: the world
// bootstraps the instance, and a bootstrap is refused once any workspace
// exists. Run first in a fresh worker (after a failure, or alone), this test
// created that workspace before the world, and the next test's world failed
// with "Invitation required".
test("at 390px the setup card fits the phone", async ({ browser, env, world: _world }) => {
  test.setTimeout(180_000)
  const { email } = await newWorkspace(env)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  try {
    await loginAs(page, env, email, PASSWORD)
    await openSetupConversation(page, true)
    await expectCard(page)
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `${SHOT_DIR}/setup-first-run-390.png` })
  } finally {
    await context.close()
  }
})

test("an established workspace gets no setup card", async ({ page, env }) => {
  test.setTimeout(120_000)
  // Older than the window: a workspace that works on mail and tickets alone
  // has written no chat message, and is still not new.
  const { email, orgId } = await newWorkspace(env)
  await env.db.sql.unsafe(
    `UPDATE "${env.schemaPrefix}kernel".organizations
     SET created_at = now() - interval '30 days' WHERE id = $1`,
    [orgId],
  )
  await loginAs(page, env, email, PASSWORD)
  await page.getByTestId("activity-messages").click()
  await page.waitForTimeout(5_000)
  await expect(page.getByTestId("setup-kickoff-row")).toHaveCount(0)
  const [row] = await env.db.sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${env.schemaPrefix}kernel".messages
     WHERE org_id = $1 AND metadata->>'type' = 'setup-kickoff'`,
    [orgId],
  )
  expect(row?.n).toBe(0)
})
