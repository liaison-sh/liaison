// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.create-nest-view-persists — create a project via UI, nest two tasks
// via drag/drop, switch to Kanban, and verify view + tasks persist on reload.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes } from "./helpers/projects-seed"

test("projects.create-nest-view-persists", async ({ page, env, qa, world }) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")

  // 1. Open Projects via the activity bar.
  await page.getByTestId("activity-projects").waitFor({ state: "visible", timeout: 30_000 })
  await page.getByTestId("activity-projects").click()

  // 2. Create a project via the UI dialog.
  await page.getByTestId("projects-home.new-project").click()
  const projectName = `Created-${Date.now()}`
  await page.getByTestId("projects-home.new-project-name").fill(projectName)
  await page.getByTestId("projects-home.new-project-confirm").click()

  // Project workspace mounts; capture its id from the URL.
  await page.waitForSelector("[data-testid='project-workspace']", { timeout: 15_000 })
  const projectId = await page.evaluate(() => {
    const m = location.pathname.match(/\/projects\/([0-9a-f-]{36})/)
    return m?.[1] ?? null
  })
  expect(projectId).not.toBeNull()

  // 3. Inline-create two tasks via the list view.
  for (const title of ["Parent Task", "Child Task"]) {
    await page.getByTestId("project-list-view.inline-create").click()
    await page.getByTestId("project-list-view.inline-create").fill(title)
    await page.getByTestId("project-list-view.inline-create").press("Enter")
    await page.waitForFunction(
      (t) =>
        Array.from(document.querySelectorAll('[data-testid="project-list-view.row"]')).some((el) =>
          (el.textContent ?? "").includes(t),
        ),
      title,
      { timeout: 5_000 },
    )
  }

  // 4. Nest one task under the other via the production drag/drop UI.
  const tasks = (
    await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token: qa.admin.token })
  ).body.data.items as Array<{ id: string; title: string }>
  const parent = tasks.find((t) => t.title === "Parent Task")!
  const child = tasks.find((t) => t.title === "Child Task")!
  await page.dragAndDrop(`[data-task-id="${child.id}"]`, `[data-task-id="${parent.id}"]`)

  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, {
          token: qa.admin.token,
        })
        return (r.body.data.items as Array<{ id: string; parentTaskId: string | null }>).find(
          (t) => t.id === child.id,
        )?.parentTaskId
      },
      { timeout: 5_000 },
    )
    .toBe(parent.id)

  const childLocator = page.locator(`[data-task-id="${child.id}"]`)
  await expect(childLocator).toHaveAttribute("data-parent-task-id", parent.id)
  const childDepth = await childLocator.getAttribute("data-depth")
  expect(Number(childDepth)).toBeGreaterThan(1)

  // 5. Switch to Kanban; the URL must reflect the choice and the kanban board mounts.
  await page.getByTestId("project-view-kanban").click()
  await page.waitForSelector(
    "[data-testid='project-kanban-board'], [data-testid='status-grouped-vertical']",
    { timeout: 10_000 },
  )
  await page.waitForURL(/view=kanban/, { timeout: 5_000 })
  expect(new URL(page.url()).searchParams.get("view")).toBe("kanban")

  // 6. Reload persistence: view choice and task data survive a hard reload.
  await page.reload()
  await page.waitForURL(/view=kanban/, { timeout: 5_000 })
  expect(new URL(page.url()).searchParams.get("view")).toBe("kanban")
  await page.waitForSelector(
    "[data-testid='project-kanban-board'], [data-testid='status-grouped-vertical']",
    { timeout: 10_000 },
  )
  await expect(page.locator(`[data-task-id="${parent.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-task-id="${child.id}"]`)).toBeVisible()

  // The hierarchy should still be rendered after reload once the list view is reopened.
  await page.getByTestId("project-view-list").click()
  await expect(page.locator(`[data-task-id="${child.id}"]`)).toHaveAttribute(
    "data-parent-task-id",
    parent.id,
  )
})
