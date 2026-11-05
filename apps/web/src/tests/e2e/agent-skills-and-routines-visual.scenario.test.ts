// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent App: Visuals — dark-mode pixel-diff baselines for the Skills + Routines
 * surfaces. Captured in dark mode (like the rest of the app's screenshots) and
 * against the enriched QA seed (the standard seed tier's agent-app part, `seedQaAgentApp`) so every shot renders
 * populated UI. Covers tab switching, the create surfaces + schedule picker, and
 * RoutineDetail edit mode.
 *
 * Describe title is metachar-free per the Strobe regex memory rule.
 * Run with `--update-snapshots` to refresh the goldens after intentional UI changes.
 */

import {
  activeTabScope,
  forceDarkMode,
  loginAsAdmin,
  openAgentApp,
  openAgentTabByHandle,
  openOwnAgentTab,
} from "./agent-bootstrap"
import { expect, test } from "./fixtures/test"
import { dropRoutineRuns, seedModelPricingAndCredits, seedRoutineRuns } from "./helpers/agent-seed"
import { ROLE_AGENT_HANDLE } from "./helpers/agent-test-fixtures"

const SHOT = { maxDiffPixelRatio: 0.02 } as const

/** The floating chat dock overlaps every main-panel surface that reaches the
 *  bottom of the window (it sits flush in the corner and the page keeps its
 *  full height) and carries a live unread count, which is nobody's baseline:
 *  mask it out of those shots. */
const dockMask = (page: import("@playwright/test").Page) => ({
  ...SHOT,
  mask: [page.locator("[data-chat-dock]")],
})

test.describe("Agent App: Visuals", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  // ─── Sample 1: agent sidebar ──────────────────────────────────────────────
  test("agent-sidebar-default", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentApp(page)
    const sidebar = page.getByTestId("agent-sidebar")
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveScreenshot("agent-sidebar-default.png", SHOT)
  })

  // ─── Sample 2: skills list — the viewer's own agent ───────────────────────
  test("skills-list-personal-populated", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "skills")
    const list = page.getByTestId("skills-list")
    await expect(list).toBeVisible()
    // The "draft-customer-reply" skill is committed by the per-worker `qa`
    // fixture before this test runs (no race) and SkillsList fetches once on
    // mount — so this only ever waits on wall-clock: login + goto + first-hit
    // Vite compile + the GET, which can exceed 10s under 2-worker contention.
    await expect(page.getByTestId("skill-row-draft-customer-reply")).toBeVisible({
      timeout: 30_000,
    })
    await expect(list).toHaveScreenshot("skills-list-personal-populated.png", SHOT)
  })

  // ─── Sample 3: skills list — a shared skill on its owning role agent ──────
  // There is no provenance sub-tab to shoot any more: a shared skill belongs to
  // a ROLE agent and is seen on that agent's page.
  test("skills-list-org-populated", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentTabByHandle(page, ROLE_AGENT_HANDLE, "skills")
    // The viewer's own agent page is open behind this one and stays mounted,
    // so the shot names the tab in front of the user.
    const list = activeTabScope(page).getByTestId("skills-list")
    await expect(list).toBeVisible()
    await expect(list.getByTestId("skill-row-triage-bug-report")).toBeVisible({
      timeout: 30_000,
    })
    await expect(list).toHaveScreenshot("skills-list-org-populated.png", SHOT)
  })

  // Sample 4 (the built-in provenance tab) is GONE with the surface it shot:
  // an agent-scoped Skills rail lists the agent's OWN skills and has no
  // built-in group to photograph (agent-skills.scenario asserts a built-in's
  // presence against the registry for the same reason).

  // ─── Sample 5: skill detail ───────────────────────────────────────────────
  test("skill-detail-personal", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "skills")
    await page.getByTestId("skill-row-draft-customer-reply").click({ timeout: 30_000 })
    const detail = page.getByTestId("skill-detail")
    await expect(detail).toBeVisible({ timeout: 10_000 })
    // Wait for the detail's content to settle (heading reflects the loaded skill).
    await expect(detail.locator("h1")).toContainText("draft-customer-reply", {
      timeout: 10_000,
    })
    await expect(detail).toHaveScreenshot("skill-detail-personal.png", dockMask(page))
  })

  // ─── Sample 6: skill create surface (a tab, not a modal) ──────────────────
  test("skill-create-surface", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "skills")
    await page.getByTestId("skills-new-skill").click({ timeout: 30_000 })
    // The agent page has its own create form beside the list (T36); the flat
    // screen's `skill-create` surface is retired with the screen.
    const surface = page.getByTestId("agent-skill-create")
    await expect(surface).toBeVisible()
    await expect(surface).toHaveScreenshot("skill-create-surface.png", dockMask(page))
  })

  // ─── Sample 7: routines list — the viewer's own agent ─────────────────────
  test("routines-list-mine-populated", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    const list = page.getByTestId("routines-list")
    await expect(list).toBeVisible()
    await expect(page.getByTestId("routine-row-daily-thread-digest")).toBeVisible({
      timeout: 10_000,
    })
    await expect(list).toHaveScreenshot("routines-list-mine-populated.png", SHOT)
  })

  // ─── Sample 8: routines list — a shared routine, on its owner's page ──────
  test("routines-list-shared-populated", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    const list = page.getByTestId("routines-list")
    await expect(list).toBeVisible()
    await expect(page.getByTestId("routine-row-weekly-pipeline-review")).toBeVisible({
      timeout: 10_000,
    })
    await expect(list).toHaveScreenshot("routines-list-shared-populated.png", SHOT)
  })

  // ─── Sample 9: routine create surface — recurring (schedule picker) ───────
  test("routine-create-surface-recurring", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    await page.getByTestId("routines-new-routine").click()
    const surface = page.getByTestId("routine-create")
    await expect(surface).toBeVisible()
    await page.getByTestId("schedule-preset-weekdays").click()
    await expect(surface).toHaveScreenshot("routine-create-surface-recurring.png", dockMask(page))
  })

  // ─── Sample 10: routine create surface — scheduled (datetime picker) ──────
  test("routine-create-surface-scheduled", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    await page.getByTestId("routines-new-routine").click()
    const surface = page.getByTestId("routine-create")
    await expect(surface).toBeVisible()
    await page.getByTestId("routine-kind-scheduled").click()
    await expect(page.getByTestId("schedule-datetime")).toBeVisible()
    await expect(surface).toHaveScreenshot("routine-create-surface-scheduled.png", dockMask(page))
  })

  // ─── Sample 11: routine detail ────────────────────────────────────────────
  test("routine-detail", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await seedRoutineRuns(env, world.org.id, "daily-thread-digest")
    try {
      await loginAsAdmin(page, env)
      await page.goto(`http://localhost:${env.ports[1]}/`)
      await openOwnAgentTab(page, "routines")
      await page.getByTestId("routine-open-daily-thread-digest").click()
      const detail = page.getByTestId("routine-detail")
      await expect(detail).toBeVisible({ timeout: 10_000 })
      // The Runs tab is what the pane opens on, newest first: the seeded manual
      // run heads the list, and the run without a recorded trigger reads the
      // routine's own kind.
      const rows = page.getByTestId("routine-run-history").locator("li")
      await expect(rows.first()).toContainText("Manual run")
      await expect(rows.last()).toContainText("Scheduled")
      await expect(detail).toHaveScreenshot("routine-detail.png", dockMask(page))
      await page.getByTestId("routine-tab-settings").click()
      await expect(page.getByTestId("routine-prompt")).toBeVisible()
      await expect(detail).toHaveScreenshot("routine-detail-settings.png", dockMask(page))
    } finally {
      await dropRoutineRuns(env, world.org.id, "daily-thread-digest")
    }
  })

  // ─── Sample 12: routine detail — edit mode ────────────────────────────────
  test("routine-detail-edit", async ({ page, env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "routines")
    await page.getByTestId("routine-open-daily-thread-digest").click()
    const detail = page.getByTestId("routine-detail")
    await expect(detail).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("routine-edit").click()
    await expect(page.getByTestId("routine-edit-form")).toBeVisible()
    await expect(detail).toHaveScreenshot("routine-detail-edit.png", dockMask(page))
  })
})
