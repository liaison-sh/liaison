// SPDX-License-Identifier: FSL-1.1-ALv2
// A manager's views of a project, end to end: a person makes a table "From a project" in the
// Dashboards sidebar, edits a task's status in its grid (the task's status changes in Projects),
// and clicks a link cell, which opens the linked task. A Project overview dashboard (the docs
// recipe, docs/apps/projects.md) draws a bar of the tasks by status, and its drill opens a task.
// The overview draws the recipe's visual forms: the pipeline (one bar by status, in the
// statuses' colours, its legend carrying the counts), who has what (a row per person with their
// avatar) and time in status split by status. P3_SHOTS names a folder for the screenshots (else
// the test output); `themed` shoots dark and light.
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

/** The same view in both themes: the stored theme, then a reload so the charts repaint. */
async function themed(page: Page, info: TestInfo, name: string, ready: () => Promise<void>) {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("liaison:theme", t), theme)
    await page.reload()
    if (theme === "light") await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light")
    await ready()
    await shot(page, info, `${name}-${theme}`)
  }
  await page.evaluate(() => localStorage.setItem("liaison:theme", "dark"))
}

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
        statuses: [
          { label: "Todo", color: "#3b82f6" },
          { label: "Doing", color: "#8b5cf6" },
          { label: "Done", color: "#22c55e", terminal: true },
        ],
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
  // The backed grid in both themes: the header bands, the status pills in their colours.
  await expect(page.getByTestId(`${grid}-band-record`)).toContainText(project.name)
  await expect(page.getByTestId(`${grid}-pill-${rma1}-status`)).toHaveText("Doing")
  await themed(page, info, "p4a-backed-table", async () => {
    await expect(page.getByTestId(`${grid}-pill-${rma1}-status`)).toBeVisible({ timeout: 15_000 })
  })
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
  const { project, status, tasks } = await seedProject(env.serverUrl, token, ["RMA-7", "RMA-8"])
  // RMA-7 has a handler: who has what shows them with their avatar.
  const assigned = await api(env.serverUrl, `/api/projects/${project.id}/tasks/${tasks["RMA-7"]}`, {
    method: "PATCH",
    token,
    body: { assigneeId: qa.admin.id },
  })
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200)
  // One task past its due date (overdue) still in Doing; Todo then holds RMA-7 and RMA-8.
  const late = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
    token,
    body: { title: "RMA-9", statusId: status("Doing"), dueDate: "2020-01-01" },
  })
  expect(late.status, JSON.stringify(late.body)).toBe(200)
  const aggregate = (params: Record<string, unknown> = {}) => ({
    kind: "tool",
    tool: "projects:tasks_aggregate",
    params: { projectId: project.id, ...params },
  })
  const bar = {
    x: "groupLabel",
    y: "value",
    drillRows: "tasks",
    drillColumns: [
      { field: "title", label: "Title" },
      { field: "status", label: "Status" },
      { field: "assigneeName", label: "Handler" },
      { field: "dueDate", label: "Due" },
    ],
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
          {
            id: "status",
            type: "bar",
            title: "Pipeline",
            width: 2,
            source: aggregate(),
            map: { ...bar, colorField: "color", keepOrder: true, stackedSingle: true },
          },
          {
            id: "handler",
            type: "bar",
            title: "Who has what",
            source: aggregate({ groupBy: "assignee", series: "status" }),
            map: {
              ...bar,
              series: "seriesLabel",
              colorField: "seriesColor",
              personField: "userId",
              keepOrder: true,
              horizontal: true,
              stacked: true,
            },
          },
          {
            id: "aging",
            type: "bar",
            title: "Time in status",
            source: aggregate({ groupBy: "age_in_status", series: "status" }),
            map: {
              ...bar,
              series: "seriesLabel",
              colorField: "seriesColor",
              keepOrder: true,
              stacked: true,
            },
          },
          {
            id: "sla",
            type: "metric",
            title: "SLA missed",
            source: aggregate({
              groupBy: "sla",
              sla: { toStatusIds: [status("Done")], withinWorkingDays: 2 },
            }),
            map: {
              value: "value",
              agg: "sum",
              where: [{ field: "group", op: "in", value: ["missed", "open_late"] }],
            },
          },
          {
            id: "overdue",
            type: "table",
            title: "Overdue",
            source: {
              kind: "tool",
              tool: "projects:tasks_byProject",
              params: { projectId: project.id, due: "overdue" },
            },
            map: {
              columns: [
                { field: "title", label: "Task" },
                { field: "assigneeName", label: "Handler" },
                { field: "dueDate", label: "Due" },
              ],
              link: { entity: "task", idField: "id", app: "projects" },
            },
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
  await expect(page.getByTestId("dashboard-block-open")).toContainText("3")
  // All six blocks render: the two other bars, the SLA metric and the overdue list.
  for (const id of ["handler", "aging", "sla", "overdue"]) {
    await expect(page.getByTestId(`dashboard-block-${id}`)).toHaveAttribute("data-state", "ready", {
      timeout: 20_000,
    })
  }
  await expect(page.getByTestId("dashboard-block-overdue")).toContainText("RMA-9")
  await shot(page, info, "p3-05-overview")
  // The pipeline: Todo (2) then Doing (1), in the board's order and colours, counts in the legend.
  await expect(block.getByTestId("dashboard-pipeline-legend-0")).toHaveText("Todo2")
  await expect(block.getByTestId("dashboard-pipeline-legend-1")).toHaveText("Doing1")
  await expect(block.getByTestId("dashboard-pipeline-segment-0")).toHaveCSS(
    "background-color",
    "rgb(59, 130, 246)",
  )
  // Who has what: the admin's row with their avatar disc, the unassigned row last.
  const who = page.getByTestId("dashboard-block-handler")
  await expect(who.getByTestId("dashboard-people-row-0")).toContainText("Elodie")
  await themed(page, info, "p4a-overview", async () => {
    await expect(page.getByTestId("dashboard-block-status")).toHaveAttribute(
      "data-state",
      "ready",
      {
        timeout: 20_000,
      },
    )
    for (const id of ["open", "handler", "aging", "sla", "overdue"]) {
      await expect(page.getByTestId(`dashboard-block-${id}`)).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 20_000 },
      )
    }
  })

  // The Todo segment opens its two tasks; the first opens in Projects.
  await page
    .getByTestId("dashboard-block-status")
    .getByTestId("dashboard-pipeline-legend-0")
    .click()
  const drill = page.getByTestId("dashboard-drill-panel")
  await expect(drill).toBeVisible()
  await expect(drill).toContainText("RMA-7")
  await expect(drill).toContainText("RMA-8")
  // The recipe's drill columns, in people's words.
  for (const label of ["Title", "Status", "Handler", "Due"])
    await expect(drill).toContainText(label)
  await shot(page, info, "p3-06-drill-tasks")
  await page.getByTestId("dashboard-drill-open-0").click()
  await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(new RegExp(tasks["RMA-7"] as string))
  await shot(page, info, "p3-07-drill-task-opened")
})
