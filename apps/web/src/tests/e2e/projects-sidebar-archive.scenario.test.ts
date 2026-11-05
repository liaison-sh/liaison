// SPDX-License-Identifier: FSL-1.1-ALv2
// The Projects sidebar keeps the project list usable, and a project can be
// archived and restored from the UI.
//
//   1. Balance: on a laptop-height window, with several saved views and a
//      dozen projects, the project list keeps half of the sidebar body (before:
//      filters + saved views kept their full height and the list got what was
//      left), and the controls scroll on their own.
//   2. Archive: the workspace header archives the project behind a
//      confirmation; it leaves the sidebar list and shows under Archived.
//      Restore brings it back, name intact.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { clearAllProjects, grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

test.describe("projects sidebar balance + archive", () => {
  test("the project list keeps its share of a short sidebar; archive and restore round-trip", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await clearAllProjects(env, qa.admin.token)
    const token = qa.admin.token
    // Distinct first words: each derives its own project key (ALP, BRA, ...).
    const names = [
      "Alpha rollout",
      "Bravo migration",
      "Tobias audit",
      "Delta onboarding",
      "Echo pricing",
      "Foxtrot hiring",
      "Golf retail",
      "Hotel partners",
      "India launch",
      "Juliet support",
      "Kilo finance",
      "Lima events",
    ]
    const projects = []
    for (const name of names) projects.push(await seedProjectWithTasks(env, token, { name }))
    // Saved views on the home sidebar: each is a two-line row, the thing that
    // pushed the list off the bottom in production.
    for (const n of ["Mine this week", "Overdue", "Blocked", "Sales pipeline"]) {
      const r = await api(env.serverUrl, "/api/saved-views", {
        token,
        body: { app: "projects", viewId: "home", name: n, payload: {}, sharedWithOrg: true },
      })
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300)
    }

    await page.setViewportSize({ width: 1440, height: 760 })
    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-projects").click()
    const sidebar = page.getByTestId("projects-sidebar")
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => sidebar.locator('[data-testid^="projects-sidebar.row-"]').count(), {
        timeout: 10_000,
      })
      .toBe(12)
    await expect(sidebar.getByTestId("saved-views-list")).toContainText("Sales pipeline")

    // Measured in the browser. `list` is the scrolling viewport of the
    // project rows (the <ul> itself before the fix, its wrapper after), and
    // `body` the space between the search box and the footer.
    const g = await page.evaluate(() => {
      const q = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
      const h = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().height) : -1)
      const list = q("projects-sidebar.list")!
      const scroller = list.closest(".overflow-y-auto") as HTMLElement
      const controls = q("projects-sidebar.controls")
      return {
        sidebar: h(q("projects-sidebar")),
        body: h(q("projects-sidebar.body")),
        controls: h(controls),
        controlsScrolls: controls ? controls.scrollHeight > controls.clientHeight : false,
        list: h(scroller),
        listRowsVisible: Math.floor(h(scroller) / 32),
      }
    })
    console.log("[sidebar-geometry]", JSON.stringify(g))
    await page.screenshot({ path: "test-results/projects-sidebar-balanced.png" })
    // The controls never take more than half the body, and scroll on their own.
    expect(g.controls).toBeGreaterThan(0)
    expect(g.controls).toBeLessThanOrEqual(g.body / 2 + 1)
    expect(g.controlsScrolls).toBe(true)
    // The list viewport keeps the other half, minus its own heading.
    expect(g.list).toBeGreaterThanOrEqual(g.body / 2 - 48)

    // Archive the first project from its workspace.
    const target = projects[0]!
    await sidebar.getByTestId(`projects-sidebar.row-${target.id}`).click()
    await expect(page.getByTestId("project-workspace.title")).toContainText(names[0]!)
    // Archive lives in the header's project menu.
    await page.getByTestId("project-workspace.menu").click()
    await expect(page.getByTestId("project-workspace.menu-content")).toBeVisible()
    await page.getByTestId("project-workspace.archive").click()
    await page.getByTestId("project-workspace.archive-confirm").click()
    await expect(page.getByTestId("project-workspace.archived-banner")).toBeVisible()
    await expect(sidebar.getByTestId(`projects-sidebar.row-${target.id}`)).toHaveCount(0)
    const listed = await api(env.serverUrl, "/api/projects?limit=100", { token })
    expect(listed.body.data.items.map((p: { id: string }) => p.id)).not.toContain(target.id)

    await sidebar.getByTestId("projects-sidebar.archived-toggle").click()
    const archivedRow = sidebar.getByTestId(`projects-sidebar.archived-row-${target.id}`)
    await expect(archivedRow).toContainText(names[0]!)
    // The fold opens below the last project: it is scrolled into view.
    await expect(archivedRow).toBeInViewport()
    await page.screenshot({ path: "test-results/projects-sidebar-archived.png" })

    // Restore from the workspace: back in the list, name intact, out of the fold.
    await page.getByTestId("project-workspace.menu").click()
    await page.getByTestId("project-workspace.restore").click()
    await expect(page.getByTestId("project-workspace.archived-banner")).toHaveCount(0)
    await expect(sidebar.getByTestId(`projects-sidebar.row-${target.id}`)).toContainText(names[0]!)
    await expect(archivedRow).toHaveCount(0)
    const back = await api(env.serverUrl, "/api/projects?limit=100", { token })
    expect(back.body.data.items.map((p: { id: string }) => p.id)).toContain(target.id)
  })
})
