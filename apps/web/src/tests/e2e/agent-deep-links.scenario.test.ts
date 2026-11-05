// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c FX-F2 — an agent page sub route deep link in a REAL browser.
 *
 * The unit tests hand the page a resolved routePath and a resolved agent
 * listing, so they never saw the defect: on a cold load the listing arrives
 * after mount, every tab whose visibility depends on it counts as absent for
 * the first frames, and the page knocked the deep link back to Overview and
 * rewrote `/agents/:handle/memory` to the bare page. Only a browser, loading
 * the URL cold, reproduces that ordering — hence this scenario.
 *
 * Four links, each loaded cold (the tab store is cleared first, so nothing is
 * inherited from the previous one): a direct sub route, the legacy list screen
 * that redirects to it, a direct sub route carrying `?selected=`, and the
 * legacy detail link that redirects to that.
 */
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

/** The skill the deep links name. It has to BELONG to the agent whose page is
 *  opened: the Skills tab lists an agent's own rows, which is exactly what the
 *  legacy `/agent/skill/:id` redirect resolves the owner for. */
const SKILL_NAME = "fx-f2-deep-link-skill"

/** Load a link the way a shipped bookmark does: with no tabs already open. */
async function coldLoad(page: Page, url: string): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("liaison:tabs"))
  await page.goto(url)
  await expect(page.getByTestId("agent-profile")).toBeVisible({ timeout: 20000 })
}

/** The page settles asynchronously (listing, then the page read, then the URL
 *  effect). Assert the tab AFTER both have landed, which is what the header's
 *  handle appearing marks. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByTestId("agent-page-handle")).not.toBeEmpty({ timeout: 20000 })
  await page.waitForTimeout(1500)
}

// Restore what this file seeded: the skills table is shared with every later
// file in the reused Playwright worker.
test.afterAll(async ({ env }) => {
  await env.db.sql.unsafe(`DELETE FROM "${env.schemaPrefix}kernel".skills WHERE name = $1`, [
    SKILL_NAME,
  ])
})

test("a deep link to an agent page tab opens that tab and item", async ({
  page,
  env,
  world,
  qa,
}) => {
  const base = `http://localhost:${env.ports[1]}`
  const ks = `${env.schemaPrefix}kernel`
  const sql = env.db.sql

  const [own] = (await sql.unsafe(
    `SELECT id FROM "${ks}".agents
      WHERE org_id = $1 AND owner_user_id = $2 AND kind = 'personal' AND archived_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [world.org.id, qa.admin.id],
  )) as unknown as Array<{ id: string }>
  if (!own) throw new Error("the signed in user has no personal agent in this worker's schema")

  const [seeded] = (await sql.unsafe(
    `INSERT INTO "${ks}".skills
       (org_id, author_user_id, owner_agent_id, name, description, body,
        required_scopes, enabled, created_by_user_id, created_by_actor_type)
     VALUES ($1, $2, $3, $4, 'Deep link target for FX-F2.', 'step one',
             '{}', true, $2, 'user')
     RETURNING id`,
    [world.org.id, qa.admin.id, own.id, SKILL_NAME],
  )) as unknown as Array<{ id: string }>
  const skillId = seeded!.id

  await loginAs(page, env, qa.admin.email, "12345678")

  // 1. A direct load of a sub route lands on that tab, not on Overview.
  await coldLoad(page, `${base}/agents/self/memory`)
  await settle(page)
  await expect(page.getByTestId("agent-profile-tab-memory")).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByTestId("agent-page-panel-memory")).toBeVisible()
  expect(new URL(page.url()).pathname).toMatch(/^\/agents\/[^/]+\/memory$/)

  // 2. The retired flat screen redirects onto the same tab.
  await coldLoad(page, `${base}/agent/memories`)
  await settle(page)
  await expect(page.getByTestId("agent-profile-tab-memory")).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByTestId("agent-page-panel-memory")).toBeVisible()
  // A redirect can await the directory, so it names the agent the way a person
  // does rather than falling back to `self` (P4c FX-F4).
  expect(new URL(page.url()).pathname).toMatch(/^\/agents\/@[^/]+\/memory$/)

  // 3. `?selected=` rides the same route and opens the row it names.
  await coldLoad(page, `${base}/agents/self/skills?selected=${skillId}`)
  await settle(page)
  await expect(page.getByTestId("agent-page-tab-skills")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("skill-detail")).toContainText(SKILL_NAME, {
    timeout: 20000,
  })
  expect(new URL(page.url()).searchParams.get("selected")).toBe(skillId)

  // 4. The retired detail link becomes that same selected deep link.
  await coldLoad(page, `${base}/agent/skill/${skillId}`)
  await settle(page)
  await expect(page.getByTestId("agent-page-tab-skills")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("skill-detail")).toContainText(SKILL_NAME, {
    timeout: 20000,
  })
  const final = new URL(page.url())
  // The owning agent, by handle: the redirect awaits the directory too.
  expect(final.pathname).toMatch(/^\/agents\/@[^/]+\/skills$/)
  expect(final.searchParams.get("selected")).toBe(skillId)
})

/**
 * P4c FX-F4. The blank-body defect the test above could only report as "the
 * page never appeared": a tab opened under `self` (the only spelling available
 * before the agent directory has loaded) was re-keyed onto the handle by tab
 * rehydration, which orphaned its first-activation latch, so the shell drew the
 * right tab, the right label and the right sidebar over an EMPTY body for ever.
 * Only a real browser reproduces it: the ordering that breaks it is the cold
 * one (open the tab, load the directory, rehydrate), and every unit test hands
 * the store an id that never moves.
 */
test("a cold session's first navigation to /agents/self/skills renders the Skills tab", async ({
  page,
  env,
  world,
  qa,
}) => {
  const base = `http://localhost:${env.ports[1]}`
  // `world` is what seeds the org this user signs into.
  expect(world.org.id).toBeTruthy()
  await loginAs(page, env, qa.admin.email, "12345678")

  await coldLoad(page, `${base}/agents/self/skills`)
  await settle(page)

  // The BODY, not just the tab strip: this is the node that went missing.
  await expect(page.getByTestId("agent-profile-name")).not.toBeEmpty()
  await expect(page.getByTestId("agent-page-tab-skills")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("agent-page-panel-skills")).toBeVisible()
  // A directly typed `self` stays `self` (the page answers to it); what must
  // never happen again is the tab settling on it with nothing underneath.
  expect(new URL(page.url()).pathname).toMatch(/^\/agents\/[^/]+\/skills$/)
})
