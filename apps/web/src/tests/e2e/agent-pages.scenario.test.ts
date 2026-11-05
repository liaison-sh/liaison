// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T40 — Validation 8 of the chat-dock spec, in a real browser.
 *
 * The oracles and the charter know the agent directory and the agent page from
 * the manifest; only a browser proves the WALK: that the seven tabs are really
 * there for an admin, that a plain member gets five with the other two ABSENT
 * from the DOM rather than merely hidden, that a skill edit and a routine run
 * actually land, that the retired `/agent/skills` link still arrives somewhere
 * useful, and that three different entry points reach ONE url.
 *
 * NO MODEL TURN. Every step here is navigation, permission gating or CRUD, so
 * nothing needs `agent-turn.ts`'s scripted-provider seam: the run-now step is
 * asserted on the persisted run row appearing, which the api writes before any
 * model is consulted. Keeping the scenario model-free is what lets it run in
 * the shared lane without a provider budget.
 *
 * SEEDED HERE, NOT REUSED: the shared QA seed's skills and routines carry a
 * NULL `owner_agent_id` (apps/api/src/seed/tiers/standard/rows.ts), and
 * both agent page tabs list "what does THIS agent own", so against the shared
 * seed alone both tabs render their empty state and the walk proves nothing.
 * The same reason web-15 seeds its own skill.
 */
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

/** Copy under test, mirrored from `apps/web/src/modules/agent/agents-copy.ts`.
 *  Kept literal on purpose: the charter's grouping rule is about the words the
 *  operator reads, so importing the constant would make the test agree with a
 *  rename that the charter has not agreed to. */
const YOUR_AGENT_HEADING = "Your agent"
const MESSAGE_ACTION = "Message"

const SKILL_NAME = "t40-walk-skill"
const ROUTINE_NAME = "t40-walk-routine"
/** The member case needs a NON personal agent: a member looking at another
 *  person's personal agent is denied Memory too, which is a different rule and
 *  a different tab count, and looking at their OWN makes them the owner and
 *  hands them all seven. A role agent is the five tab shape.
 *
 *  The `@` is load bearing: `AgentPage` normalizes a route entity id to an
 *  `@`-prefixed handle before matching the listing, so an agent row stored
 *  without one can never be resolved from its own url. */
const ROLE_HANDLE = "@t40-role"

/** Every tab of the page, in the strip's order. `memory` is the one tab whose
 *  testid kept its pre-rename spelling (`agent-profile-tab-memory`). */
const TAB_TESTID = {
  overview: "agent-page-tab-overview",
  skills: "agent-page-tab-skills",
  routines: "agent-page-tab-routines",
  memory: "agent-profile-tab-memory",
  knowledge: "agent-page-tab-knowledge",
  activity: "agent-page-tab-activity",
  settings: "agent-page-tab-settings",
} as const
type TabId = keyof typeof TAB_TESTID
const MEMBER_TABS: TabId[] = ["overview", "skills", "routines", "memory", "knowledge"]
const ADMIN_TABS: TabId[] = [...MEMBER_TABS, "activity", "settings"]

/** The shell keeps every opened tab mounted, hiding the inactive ones with
 *  `display: none`, so a bare `getByTestId` can match a screen the operator is
 *  not looking at. Every assertion here is therefore made against the VISIBLE
 *  instance, which is also the only one a charter judges. */
const onScreen = (page: Page, testid: string) =>
  page.locator(`[data-testid="${testid}"]`).locator("visible=true")

/** Load a link the way a shipped bookmark does: with no tabs already open.
 *  (The cold path is the one FX-F1/FX-F2 fixed; a warm tab store hides it.) */
async function coldLoad(page: Page, url: string): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("liaison:tabs"))
  await page.goto(url)
  await expect(onScreen(page, "agent-profile")).toBeVisible({ timeout: 30000 })
}

/** The page resolves asynchronously (listing, then the page read, then the URL
 *  effect). The header handle filling in is the marker that both have landed. */
async function settle(page: Page): Promise<void> {
  await expect(onScreen(page, "agent-page-handle")).not.toBeEmpty({ timeout: 30000 })
  await page.waitForTimeout(1500)
}

/** Open one tab and assert the page agrees: the control, the panel and the URL. */
async function walkTab(page: Page, tab: TabId): Promise<void> {
  const control = onScreen(page, TAB_TESTID[tab])
  await control.click({ timeout: 30000 })
  await expect(control).toHaveAttribute("aria-selected", "true", { timeout: 30000 })
  await expect(onScreen(page, `agent-page-panel-${tab}`)).toBeVisible({ timeout: 30000 })
  const path = new URL(page.url()).pathname
  // Overview is the base route, so it may render as either spelling.
  const want = tab === "overview" ? /^\/agents\/[^/]+(\/overview)?$/ : new RegExp(`/${tab}$`)
  expect(path).toMatch(want)
}

interface Seeded {
  ownAgentId: string
  ownHandle: string
  skillId: string
  routineId: string
}

type Unsafe = (q: string, p: string[]) => Promise<unknown>

async function seed(unsafe: Unsafe, ks: string, orgId: string, userId: string): Promise<Seeded> {
  const rows = async <T>(q: string, p: string[]) => (await unsafe(q, p)) as unknown as T[]

  const [own] = await rows<{ id: string; handle: string }>(
    `SELECT id, handle FROM "${ks}".agents
      WHERE org_id = $1 AND owner_user_id = $2 AND kind = 'personal' AND archived_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [orgId, userId],
  )
  if (!own) throw new Error("the admin has no personal agent in this worker's schema")

  const [role] = await rows<{ id: string }>(
    `INSERT INTO "${ks}".agents (org_id, kind, handle, display_name, system_prompt)
     VALUES ($1, 'role', $2, 'T40 Role Agent', 'A role agent the T40 walk reads.')
     ON CONFLICT (org_id, handle) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [orgId, ROLE_HANDLE],
  )
  if (!role) throw new Error("could not seed the role agent")

  // `required_scopes` stays empty, which is also the shared seed's shape: the
  // no-scope-name assertion below therefore judges the page's own chrome, not
  // a row this test stuffed with scopes.
  const [skill] = await rows<{ id: string }>(
    `INSERT INTO "${ks}".skills
       (org_id, author_user_id, owner_agent_id, name, description, body,
        required_scopes, enabled, created_by_user_id, created_by_actor_type)
     VALUES ($1, $2, $3, $4, 'The skill the T40 walk edits.', 'step one',
             '{}', true, $2, 'user')
     RETURNING id`,
    [orgId, userId, own.id, SKILL_NAME],
  )
  if (!skill) throw new Error("could not seed the skill")

  const [routine] = await rows<{ id: string }>(
    `INSERT INTO "${ks}".routines
       (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
        prompt, scopes, visibility, status, created_by_user_id, created_by_actor_type)
     VALUES ($1, $2, $3, $4, 'The routine the T40 walk runs.', 'recurring', '0 9 * * 1',
             'UTC', 'Say what changed since yesterday.', '{}', 'personal', 'active', $2, 'user')
     RETURNING id`,
    [orgId, userId, own.id, ROUTINE_NAME],
  )
  if (!routine) throw new Error("could not seed the routine")

  return {
    ownAgentId: own.id,
    ownHandle: own.handle,
    skillId: skill.id,
    routineId: routine.id,
  }
}

test.beforeAll(async ({ env, world, qa }) => {
  const unsafe: Unsafe = (q, p) => env.db.sql.unsafe(q, p)
  await seed(unsafe, `${env.schemaPrefix}kernel`, world.org.id, qa.admin.id)
})

// Restore what this file seeded: skills, routines and agents are shared with
// every later file in the reused Playwright worker.
test.afterAll(async ({ env, world }) => {
  const ks = `${env.schemaPrefix}kernel`
  await env.db.sql.unsafe(`DELETE FROM "${ks}".skills WHERE name = $1`, [SKILL_NAME])
  await env.db.sql.unsafe(`DELETE FROM "${ks}".routines WHERE name = $1`, [ROUTINE_NAME])
  await env.db.sql.unsafe(`DELETE FROM "${ks}".agents WHERE org_id = $1 AND handle = $2`, [
    world.org.id,
    ROLE_HANDLE,
  ])
})

test("an admin walks the directory and all seven tabs of an agent page", async ({
  page,
  env,
  world,
  qa,
}) => {
  const base = `http://localhost:${env.ports[1]}`
  const ks = `${env.schemaPrefix}kernel`
  const [own] = (await env.db.sql.unsafe(
    `SELECT id, handle FROM "${ks}".agents
      WHERE org_id = $1 AND owner_user_id = $2 AND kind = 'personal' AND archived_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [world.org.id, qa.admin.id],
  )) as unknown as Array<{ id: string; handle: string }>
  if (!own) throw new Error("the admin has no personal agent in this worker's schema")

  await loginAs(page, env, qa.admin.email, "12345678")

  // ── 1. The roster, which is the SIDEBAR, and what /agents opens ───────────
  await page.evaluate(() => localStorage.removeItem("liaison:tabs"))
  await page.goto(`${base}/agents`)
  // One roster, not two: `/agents` lands on the operator's OWN agent and the
  // sidebar is the only list of agents on the screen.
  await expect(onScreen(page, "agent-profile")).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId("agents-directory")).toHaveCount(0)
  const sidebar = onScreen(page, "agent-sidebar")
  await expect(sidebar).toContainText(YOUR_AGENT_HEADING)
  await expect(sidebar.locator("[data-agent-mine]")).toHaveCount(1)
  // Message lives on the agent header now, and only an admin is offered the
  // create control (charter: presence, never a disabled state).
  await expect(onScreen(page, "agent-page-message")).toContainText(MESSAGE_ACTION)
  await expect(page.getByTestId("agent-sidebar-new-agent")).toHaveCount(1)
  // The role agent this file seeded is a row of the same list.
  await expect(page.getByTestId(`agent-sidebar-row-${ROLE_HANDLE}`)).toBeVisible({
    timeout: 30000,
  })

  // ── 2. Entry point A: the sidebar row ─────────────────────────────────────
  await page.getByTestId(`agent-sidebar-row-${own.handle}`).click({ timeout: 30000 })
  await expect(onScreen(page, "agent-profile")).toBeVisible({ timeout: 30000 })
  await settle(page)
  const canonical = new URL(page.url()).pathname
  expect(canonical).toMatch(/^\/agents\/[^/]+(\/overview)?$/)

  // ── 3. Seven tabs, and the walk through every one of them ─────────────────
  const profile = onScreen(page, "agent-profile")
  await expect(profile.locator("[data-agent-tab]")).toHaveCount(ADMIN_TABS.length)
  for (const tab of ADMIN_TABS) await walkTab(page, tab)

  // ── 3b. Skills and Routines are two real panes, like Memory ───────────────
  // Geometry, not a class name: the tab must fill the panel and the detail must
  // occupy the rest of the width, which is exactly what an auto-height panel
  // collapsed into one narrow column with nothing beside it.
  for (const tab of ["skills", "routines"] as const) {
    await walkTab(page, tab)
    const panel = onScreen(page, `agent-page-panel-${tab}`)
    const detail = onScreen(page, `agent-${tab}-detail`)
    const panelBox = await panel.boundingBox()
    const detailBox = await detail.boundingBox()
    if (!panelBox || !detailBox) throw new Error(`${tab} panes have no geometry`)
    expect(panelBox.height, `the ${tab} panel collapsed`).toBeGreaterThan(200)
    expect(detailBox.width, `the ${tab} detail pane is not beside the list`).toBeGreaterThan(300)
    // And it is not empty on arrival: the first row is already selected.
    await expect(onScreen(page, `agent-${tab}-no-selection`)).toHaveCount(0)
  }

  // ── 3c. Memory is two panes as well ───────────────────────────────────────
  // The tree on the left, the open file beside it. Same geometry check, same
  // reason: the editor used to render UNDER the whole tree.
  await walkTab(page, "memory")
  {
    const panelBox = await onScreen(page, "agent-page-panel-memory").boundingBox()
    const listBox = await onScreen(page, "agent-memory-list").boundingBox()
    const detailBox = await onScreen(page, "agent-memory-detail").boundingBox()
    if (!panelBox || !listBox || !detailBox) throw new Error("memory panes have no geometry")
    expect(panelBox.height, "the memory panel collapsed").toBeGreaterThan(200)
    expect(detailBox.width, "the memory editor is not beside the tree").toBeGreaterThan(300)
    // Beside, not under: the editor starts where the tree ends.
    expect(detailBox.x, "the memory editor is stacked under the tree").toBeGreaterThanOrEqual(
      listBox.x + listBox.width - 1,
    )
  }

  // ── 4. A skill edit on the Skills tab, persisted across a reload ──────────
  const edited = `step one, then step two (t40 ${Date.now()})`
  await coldLoad(page, `${base}/agents/self/skills`)
  await settle(page)
  await walkTab(page, "skills")
  await onScreen(page, `skill-row-${SKILL_NAME}`).click({ timeout: 30000 })
  await expect(onScreen(page, "skill-detail")).toContainText(SKILL_NAME, { timeout: 30000 })
  await onScreen(page, "skill-edit").click({ timeout: 30000 })
  await expect(onScreen(page, "skill-edit-form")).toBeVisible({ timeout: 30000 })
  await onScreen(page, "skill-edit-body").fill(edited)
  await onScreen(page, "skill-edit-save").click({ timeout: 30000 })
  // The save's own confirmation is the form giving way to the rendered body.
  await expect(onScreen(page, "skill-edit-form")).toHaveCount(0, { timeout: 30000 })
  await expect(onScreen(page, "skill-detail-body")).toContainText("step two", { timeout: 30000 })
  // Assert the REAL write, not the optimistic one.
  const [stored] = (await env.db.sql.unsafe(
    `SELECT body FROM "${ks}".skills WHERE org_id = $1 AND name = $2`,
    [world.org.id, SKILL_NAME],
  )) as unknown as Array<{ body: string }>
  expect(stored?.body).toBe(edited)

  // ── 5. A routine run-now on the Routines tab ──────────────────────────────
  await coldLoad(page, `${base}/agents/self/routines`)
  await settle(page)
  await walkTab(page, "routines")
  await onScreen(page, `routine-open-${ROUTINE_NAME}`).click({ timeout: 30000 })
  await expect(onScreen(page, "routine-detail")).toBeVisible({ timeout: 30000 })
  // The honest signal is what the api did, not the button's own "Queuing..."
  // label, which is true before anything has been written. `run-now` enqueues
  // the same `kernel:routine-tick` job the cron path uses and answers
  // `queued: true`; the run ROW is the worker's to write once it has taken the
  // job, so the scenario asserts the accepted enqueue and then gives the
  // worker a bounded window to prove it landed.
  const [runNow] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/run-now") && r.request().method() === "POST", {
      timeout: 30000,
    }),
    onScreen(page, "routine-run-now").click({ timeout: 30000 }),
  ])
  // 202 Accepted, not 200: the route hands back the accepted enqueue, not a result.
  expect(runNow.status()).toBe(202)
  const queued = (await runNow.json()) as { data?: { queued?: boolean; requestUuid?: string } }
  expect(queued.data?.queued).toBe(true)
  expect(queued.data?.requestUuid).toBeTruthy()

  let runCount = 0
  for (let i = 0; i < 30 && runCount === 0; i++) {
    const rows = (await env.db.sql.unsafe(
      `SELECT r.id FROM "${ks}".routine_runs r
        JOIN "${ks}".routines t ON t.id = r.routine_id WHERE t.name = $1`,
      [ROUTINE_NAME],
    )) as unknown as Array<{ id: string }>
    runCount = rows.length
    if (runCount === 0) await page.waitForTimeout(3000)
  }
  expect(runCount, "the routine worker never recorded the manual run").toBeGreaterThan(0)

  // ── 6. The retired flat link still lands on the personal agent's Skills ───
  await coldLoad(page, `${base}/agent/skills`)
  await settle(page)
  await expect(onScreen(page, TAB_TESTID.skills)).toHaveAttribute("aria-selected", "true", {
    timeout: 30000,
  })
  expect(new URL(page.url()).pathname).toMatch(/^\/agents\/[^/]+\/skills$/)

  // ── 7. Entry point C reaches the SAME url as the card's Open ──────────────
  // It hangs off the agent's own DM, so the thread has to exist first.
  const dm = await api(env.serverUrl, "/api/threads/dm", {
    method: "POST",
    token: qa.admin.token,
    body: {},
  })
  const threadId = (dm.body as { data?: { id?: string } }).data?.id
  if (!threadId) throw new Error(`no personal agent DM thread: ${dm.status}`)

  // B is gone for this agent: the viewer's own agent heads Direct messages as
  // its own person row (HomeSidebar PersonalAgentRow), which opens the DM and
  // carries no profile control. The thread header (C) is its entry point.

  // C: a thread header participant row, from that same DM.
  await page.evaluate(() => localStorage.removeItem("liaison:tabs"))
  await page.goto(`${base}/threads/${threadId}`)
  await page.getByLabel("Thread actions").first().click({ timeout: 30000 })
  const participantRow = onScreen(page, `thread-header-agent-profile-${own.id}`)
  await expect(participantRow).toBeVisible({ timeout: 30000 })
  await participantRow.click({ timeout: 30000 })
  await expect(onScreen(page, "agent-profile")).toBeVisible({ timeout: 30000 })
  await settle(page)
  expect(new URL(page.url()).pathname).toBe(canonical)
})

test("a plain member sees five tabs, with Activity and Settings absent from the DOM", async ({
  page,
  env,
  qa,
}) => {
  const base = `http://localhost:${env.ports[1]}`

  await loginAs(page, env, qa.amina.email, "QaPass1!")

  await coldLoad(page, `${base}/agents/${ROLE_HANDLE}`)
  await settle(page)

  // Five tabs, and the two gated ones are ABSENT: `toHaveCount(0)` is the whole
  // point of the assertion. A disabled or CSS-hidden tab would still be found,
  // and `getByTestId` here is deliberately NOT visibility-scoped so a tab
  // parked behind `display: none` still counts as present.
  const profile = onScreen(page, "agent-profile")
  await expect(profile.locator("[data-agent-tab]")).toHaveCount(MEMBER_TABS.length)
  for (const tab of MEMBER_TABS) {
    await expect(profile.getByTestId(TAB_TESTID[tab])).toBeVisible({ timeout: 30000 })
  }
  await expect(page.getByTestId(TAB_TESTID.activity)).toHaveCount(0)
  await expect(page.getByTestId(TAB_TESTID.settings)).toHaveCount(0)
  await expect(page.getByTestId("agent-page-panel-activity")).toHaveCount(0)
  await expect(page.getByTestId("agent-page-panel-settings")).toHaveCount(0)

  // No scope name reaches the page, on any tab the member can open. The charter
  // rule is about what the operator READS, so this reads the rendered text.
  for (const tab of MEMBER_TABS) {
    await walkTab(page, tab)
    const text = await onScreen(page, "agent-profile").innerText()
    expect(text, `a scope name is rendered on the ${tab} tab`).not.toContain("kernel:")
  }

  // The member is not offered the create control on the roster either.
  await page.evaluate(() => localStorage.removeItem("liaison:tabs"))
  await page.goto(`${base}/agents`)
  await expect(onScreen(page, "agent-sidebar")).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId("agent-sidebar-new-agent")).toHaveCount(0)
})
