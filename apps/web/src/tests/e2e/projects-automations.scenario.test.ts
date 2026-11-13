// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.automations — a project's Automations tab end to end: the toolbar
// entry opens the tab, "New automation" offers the projects templates, one
// opens the flow editor prefilled for this project (its statuses resolved),
// saving creates the routine through the routines create path, the
// automation is listed, and opening it shows the routine on its Flow tab.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

test("projects.automations-from-template", async ({ page, env, qa, world }) => {
  test.setTimeout(120_000)
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  const seeded = await seedProjectWithTasks(env, qa.admin.token, {
    name: `Automations ${Date.now()}`,
    tasks: [{ title: "First task", statusLabel: "todo" }],
  })
  const projectId = seeded.id
  const done = seeded.statuses.find((s) => s.label === "done")
  expect(done).toBeDefined()

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/projects/${projectId}`)
  await page.waitForSelector("[data-testid='project-workspace']", { timeout: 15_000 })

  // 1. The toolbar entry opens the Automations tab (not a dialog).
  await page.getByTestId("project-workspace.open-automations").click()
  const view = page.getByTestId("project-automations")
  await expect(view).toBeVisible({ timeout: 10_000 })
  await expect(page).toHaveURL(new RegExp(`/projects/automations/${projectId}`))
  await expect(view.getByTestId("project-automations.empty")).toBeVisible({ timeout: 10_000 })
  await expect(view.getByTestId("project-automations.explainer")).toBeVisible()

  // 2. Templates, then the prefilled editor.
  await view.getByTestId("project-automations.new").click()
  await view.getByTestId("project-automations.template-notify-on-status").click()
  const editor = view.getByTestId("project-automations.editor")
  await expect(editor).toBeVisible()
  await expect(editor.getByTestId("routine-flow-trigger-text")).toHaveText(
    /^When a task in Automations \d+ moves to Done$/,
  )
  await expect(editor.getByTestId("routine-flow-step-tell-title")).toHaveText(
    "Notify the routine's owner",
  )
  // Edit the step's text in place.
  await editor.getByTestId("routine-flow-step-tell-edit").click()
  await editor.getByTestId("flow-step-tell-text").fill("Finished: {{task.title}}")

  // 3. Save: the routine is created with the project's flow and filter.
  await view.getByTestId("project-automations.save").click()
  await expect(view.getByTestId("project-automations.list")).toBeVisible({ timeout: 10_000 })
  const listed = await api(env.serverUrl, `/api/agent/routines?projectId=${projectId}`, {
    token: qa.admin.token,
  })
  const rows = listed.body.data as Array<{
    id: string
    name: string
    eventFilter: { projectId: string; toStatusId: string }
    flow: { steps: Array<{ args: { text: string } }> }
  }>
  expect(rows).toHaveLength(1)
  const routine = rows[0]!
  expect(routine.eventFilter).toMatchObject({ projectId, toStatusId: done!.id })
  expect(routine.flow.steps[0]?.args.text).toBe("Finished: {{task.title}}")

  // 4. Listed, on, and opening it shows the routine's Flow tab first.
  const row = view.getByTestId(`project-automations.row-${routine.id}`)
  await expect(row).toBeVisible()
  await expect(row.getByTestId(`project-automations.toggle-${routine.id}`)).toBeVisible()
  await row.getByTestId(`project-automations.open-${routine.id}`).click()
  const detail = page.getByTestId("routine-detail")
  await expect(detail).toBeVisible({ timeout: 10_000 })
  await expect(detail.getByTestId("routine-tab-flow")).toHaveAttribute("aria-selected", "true")
  await expect(
    detail.getByTestId("routine-flow-panel").getByTestId("routine-flow-trigger-text"),
  ).toHaveText(/moves to Done$/)
  await expect(
    detail.getByTestId("routine-flow-panel").getByTestId("routine-flow-step-tell-title"),
  ).toHaveText("Notify the routine's owner")
})
