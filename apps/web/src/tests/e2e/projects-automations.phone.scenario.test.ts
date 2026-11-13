// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's Automations and a routine's flow at 390 px (S12): the
// Automations tab opens from the project menu, its list, the template cards
// and the flow editor (an action form open) fit the width with no sideways
// scroll, and the routine's Flow tab does too. Screenshots land in SHOT_DIR.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

async function expectNoSidewaysScroll(page: import("@playwright/test").Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await expectNoHorizontalClipping(page)
}

test.describe("Project automations at phone width", () => {
  test.setTimeout(120_000)

  test("the automations list, the template editor and the flow tab fit 390 px", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `Phone automations ${Date.now()}`,
      tasks: [{ title: "A task", statusLabel: "todo" }],
    })
    const todo = seeded.statuses.find((s) => s.label === "todo")!
    const doing = seeded.statuses.find((s) => s.label === "in_progress")!
    // One automation already there, with a branch and a wait, so the list and
    // the flow tab have something long to lay out.
    const created = await api(env.serverUrl, "/api/agent/routines", {
      token: qa.admin.token,
      body: {
        name: `phone-flow-${Date.now()}`,
        description: "Assign new work and remind when it sits still",
        kind: "event",
        event: "projects:task:status_changed",
        prompt: "Assign the task, then remind its assignee if it does not move.",
        scopes: ["projects:tasks:read", "projects:tasks:write"],
        eventFilter: { projectId: seeded.id, fromStatusId: todo.id, toStatusId: doing.id },
        flow: {
          version: 1,
          steps: [
            { id: "assign", type: "action", action: "assign", args: { to: "{{owner}}" } },
            {
              id: "tell",
              type: "action",
              action: "notify",
              args: {
                to: ["{{task.assigneeId}}"],
                text: "A task is waiting for you, with a fairly long sentence to wrap: {{task.title}}",
              },
              if: { field: "assignee", op: "not_empty" },
            },
            {
              id: "wait",
              type: "wait",
              for: { amount: 2, unit: "working_days" },
              until: { op: "status_unchanged_since_trigger" },
              if: { field: "assignee", op: "not_empty" },
            },
          ],
        },
      },
    })
    expect(created.status).toBe(201)
    const routineId = (created.body.data as { id: string }).id

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-workspace")).toBeVisible({ timeout: 20_000 })

    // From the project menu (the toolbar keeps one row at this width).
    await page.getByTestId("project-workspace.menu").tap()
    await page.getByTestId("project-workspace.menu-automations").tap()
    const view = page.getByTestId("project-automations")
    await expect(view).toBeVisible({ timeout: 10_000 })
    await expect(view.getByTestId(`project-automations.row-${routineId}`)).toBeVisible({
      timeout: 10_000,
    })
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: `${SHOT_DIR}/automations-list-phone.png`, fullPage: true })

    // The template cards, then the editor with a step form open.
    await view.getByTestId("project-automations.new").tap()
    await view.getByTestId("project-automations.template-assign-on-status").tap()
    const editor = view.getByTestId("project-automations.editor")
    await expect(editor).toBeVisible()
    await editor.getByTestId("routine-flow-step-assign-edit").tap()
    await expect(editor.getByTestId("flow-step-assign-form")).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: `${SHOT_DIR}/automations-editor-phone.png`, fullPage: true })

    // The routine's own Flow tab.
    await view.getByTestId("project-automations.back").tap()
    await view.getByTestId(`project-automations.open-${routineId}`).tap()
    const detail = page.getByTestId("routine-detail")
    await expect(detail).toBeVisible({ timeout: 10_000 })
    await expect(detail.getByTestId("routine-flow-step-wait")).toBeVisible()
    await expect(detail.getByTestId("routine-flow-step-wait")).toHaveAttribute(
      "data-indented",
      "true",
    )
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: `${SHOT_DIR}/routine-flow-phone.png`, fullPage: true })
  })
})
