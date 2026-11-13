// SPDX-License-Identifier: FSL-1.1-ALv2
// A manager's views of a project, end to end: a person makes a table "From a project" in the
// Dashboards sidebar, edits a task's status in its grid (the task's status changes in Projects),
// and clicks a link cell, which opens the linked task. A Project overview dashboard (the docs
// recipe, docs/apps/projects.md) draws a bar of the tasks by status, and its drill opens a task.
// P3_SHOTS names a folder for the screenshots (else the test output).
import { join } from "node:path"
import { api } from "@liaison/test-helpers"
import type { Page, TestInfo } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes } from "./helpers/projects-seed"

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({
    path: process.env.P3_SHOTS
      ? join(process.env.P3_SHOTS, `${name}.png`)
      : info.outputPath(`${name}.png`),
    fullPage: false,
  })

interface Project {
  id: string
  name: string
  statuses: Array<{ id: string; label: string }>
}

/** A project with the statuses Todo, Doing, Done and the tasks named, all in Todo. */
async function seedProject(serverUrl: string, token: string, titles: string[]) {
  const made = await api(serverUrl, "/api/apps/tools/projects:createProject", {
    method: "POST",
    token,
    body: {
      params: {
        name: `E2E Returns ${Date.now()}`,
        statuses: [{ label: "Todo" }, { label: "Doing" }, { label: "Done", terminal: true }],
      },
    },
  })
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  const project = made.body.data as Project
  const status = (label: string) => project.statuses.find((s) => s.label === label)?.id as string
  const tasks: Record<string, string> = {}
  for (const title of titles) {
    const t = await api(serverUrl, `/api/projects/${project.id}/tasks`, {
      token,
      body: { title, statusId: status("Todo") },
    })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    tasks[title] = (t.body.data as { id: string }).id
  }
  return { project, status, tasks }
}

async function openDashboardsRail(page: Page, port: number) {
  await page.goto(`http://localhost:${port}/`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.getByTestId("activity-dashboards").click()
}

test("a table from a project: edit a task's status in the grid, open a linked task", async ({
  page,
  env,
  world,
  qa,
}, info) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  const token = qa.admin.token
  const { project, status, tasks } = await seedProject(env.serverUrl, token, ["RMA-1", "RMA-2"])

  await openDashboardsRail(page, env.ports[1])
  await page.getByTestId("dashboards-sidebar-new-table").click()
  await page.getByTestId("dashboards-sidebar-new-table-name").fill("E2E returns board")
  await page.getByTestId("dashboards-sidebar-new-table-from-project").check()
  await page.getByTestId("dashboards-sidebar-new-table-project").fill(project.name)
  await page.getByTestId(`dashboards-sidebar-new-table-project-option-${project.id}`).click()
  await expect(page.getByTestId("dashboards-sidebar-new-table-project-picked")).toHaveText(
    project.name,
  )
  await expect(page.getByTestId("dashboards-sidebar-new-table-field-status")).toBeChecked()
  await shot(page, info, "p3-01-create-from-project")
  await page.getByTestId("dashboards-sidebar-new-table-create").click()

  // The table opens on its grid: the project's tasks are its rows.
  await expect(page.getByTestId("table-page-title")).toHaveText("E2E returns board")
  await expect(page.getByTestId("table-page-backing")).toContainText(project.name)
  const grid = "table-page-grid"
  const rma1 = tasks["RMA-1"] as string
  await expect(page.getByTestId(`${grid}-cell-${rma1}-title`)).toHaveText("RMA-1", {
    timeout: 15_000,
  })
  await expect(page.getByTestId(`${grid}-from-record-status`)).toBeVisible()
  await expect(page.getByTestId(`${grid}-sort-status`)).toHaveAttribute(
    "title",
    `From ${project.name}: changing it changes the task.`,
  )

  // Edit RMA-1's status: Doing is the second status.
  await page.getByTestId(`${grid}-edit-${rma1}-status`).click()
  await page.getByTestId(`${grid}-editor-${rma1}-status-choice-1`).click()
  await expect(page.getByTestId(`${grid}-cell-${rma1}-status`)).toHaveText("Doing")
  const task = await api(env.serverUrl, `/api/projects/${project.id}/tasks/${rma1}`, { token })
  expect(task.status).toBe(200)
  expect((task.body.data as { statusId: string }).statusId).toBe(status("Doing"))
  await shot(page, info, "p3-02-status-edited")

  // A link column of the table's own, pointing RMA-1 at RMA-2: its cell opens the task.
  const tableId = (await page.url()).split("/").pop()?.split("?")[0] as string
  const info1 = await api(env.serverUrl, `/api/dashboards/tables/${tableId}`, { token })
  expect(info1.status).toBe(200)
  const altered = await api(env.serverUrl, `/api/dashboards/tables/${tableId}`, {
    method: "PATCH",
    token,
    body: {
      ifVersion: (info1.body.data as { version: number }).version,
      columns: {
        add: [
          {
            key: "related",
            label: "Related",
            type: "link",
            linkTo: { app: "projects", entityType: "task" },
          },
        ],
      },
    },
  })
  expect(altered.status, JSON.stringify(altered.body)).toBe(200)
  const linked = await api(env.serverUrl, `/api/dashboards/tables/${tableId}/rows`, {
    method: "POST",
    token,
    body: {
      ops: [
        {
          op: "update",
          id: rma1,
          ifVersion: 0,
          cells: {
            related: { app: "projects", entityType: "task", id: tasks["RMA-2"], label: "RMA-2" },
          },
        },
      ],
    },
  })
  expect(linked.status, JSON.stringify(linked.body)).toBe(200)
  const open = page.getByTestId(`${grid}-open-${rma1}-related`)
  await expect(open).toHaveText("RMA-2", { timeout: 15_000 })
  await expect(page.getByTestId(`${grid}-from-record-related`)).toHaveCount(0)
  await expect(page.getByTestId(`${grid}-delete-off-${rma1}`)).toBeVisible()
  await shot(page, info, "p3-03-link-cell")
  await open.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(new RegExp(tasks["RMA-2"] as string))
  await shot(page, info, "p3-04-linked-task-opened")
})

test("the Project overview dashboard draws tasks by status and its drill opens a task", async ({
  page,
  env,
  world,
  qa,
}, info) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  const token = qa.admin.token
  const { project, tasks } = await seedProject(env.serverUrl, token, ["RMA-7", "RMA-8"])
  const aggregate = (params: Record<string, unknown> = {}) => ({
    kind: "tool",
    tool: "projects:tasks_aggregate",
    params: { projectId: project.id, ...params },
  })
  const bar = {
    x: "groupLabel",
    y: "value",
    drillRows: "tasks",
    link: { entity: "task", idField: "id", app: "projects" },
  }
  const dash = await api(env.serverUrl, "/api/dashboards", {
    method: "POST",
    token,
    body: {
      title: "E2E project overview",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "open",
            type: "metric",
            title: "Open tasks",
            source: aggregate(),
            map: { value: "value", agg: "sum" },
          },
          { id: "status", type: "bar", title: "By status", source: aggregate(), map: bar },
          {
            id: "handler",
            type: "bar",
            title: "By handler",
            source: aggregate({ groupBy: "assignee" }),
            map: bar,
          },
          {
            id: "aging",
            type: "bar",
            title: "Time in status",
            source: aggregate({ groupBy: "age_in_status" }),
            map: bar,
          },
        ],
      },
    },
  })
  expect([200, 201], JSON.stringify(dash.body)).toContain(dash.status)
  const dashId = (dash.body.data ?? dash.body).id as string

  await openDashboardsRail(page, env.ports[1])
  await page.getByTestId(`dashboards-sidebar-row-${dashId}`).click()
  const block = page.getByTestId("dashboard-block-status")
  await expect(block).toHaveAttribute("data-state", "ready", { timeout: 20_000 })
  await expect(page.getByTestId("dashboard-block-open")).toContainText("2")
  await shot(page, info, "p3-05-overview")

  // The Todo bar opens its two tasks; the first opens in Projects.
  // The chart's picks are its keyboard path (one per bar): focus Todo's and press Enter.
  await block.locator('[data-testid^="dashboard-chart-pick-"]', { hasText: "Todo" }).focus()
  await page.keyboard.press("Enter")
  const drill = page.getByTestId("dashboard-drill-panel")
  await expect(drill).toBeVisible()
  await expect(drill).toContainText("RMA-7")
  await expect(drill).toContainText("RMA-8")
  await shot(page, info, "p3-06-drill-tasks")
  await page.getByTestId("dashboard-drill-open-0").click()
  await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(new RegExp(tasks["RMA-7"] as string))
  await shot(page, info, "p3-07-drill-task-opened")
})
