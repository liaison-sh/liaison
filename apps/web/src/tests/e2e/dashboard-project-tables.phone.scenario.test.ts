// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table backed by a project and the Project overview dashboard at 390x844: the grid scrolls
// inside its own box and the page never scrolls sideways. Runs ONLY in the `iphone` project
// (playwright.config.ts).
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes } from "./helpers/projects-seed"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

test("a project-backed table and the overview dashboard fit a phone", async ({
  page,
  env,
  world,
  qa,
}) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  const token = qa.admin.token
  const made = await api(env.serverUrl, "/api/apps/tools/projects:createProject", {
    method: "POST",
    token,
    body: {
      params: {
        name: `Phone Returns ${Date.now()}`,
        statuses: [{ label: "Todo" }, { label: "Doing" }, { label: "Done", terminal: true }],
      },
    },
  })
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  const project = made.body.data as { id: string; statuses: Array<{ id: string; label: string }> }
  for (const title of ["A return with a fairly long title to wrap", "RMA-2"]) {
    const t = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
      token,
      body: { title, statusId: project.statuses[0]?.id },
    })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
  }
  const table = await api(env.serverUrl, "/api/dashboards/tables", {
    method: "POST",
    token,
    body: {
      name: "Phone returns board",
      columns: [{ key: "note", label: "Note", type: "text" }],
      backing: {
        app: "projects",
        entity: "task",
        parentId: project.id,
        fields: ["title", "status", "assignee", "due", "priority"],
      },
    },
  })
  expect(table.status, JSON.stringify(table.body)).toBe(201)
  const tableId = (table.body.data as { id: string }).id

  await page.goto(`http://localhost:${env.ports[1]}/dashboard-table/${tableId}`)
  await expect(page.getByTestId("table-page-grid-from-record-status")).toBeVisible({
    timeout: 30_000,
  })
  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/p3-phone-backed-table.png`, fullPage: false })

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
      title: "Phone project overview",
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
        ],
      },
    },
  })
  expect([200, 201], JSON.stringify(dash.body)).toContain(dash.status)
  const dashId = (dash.body.data ?? dash.body).id as string
  await page.goto(`http://localhost:${env.ports[1]}/dashboard/${dashId}`)
  await expect(page.getByTestId("dashboard-block-status")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  })
  await expectNoHorizontalClipping(page)
  await page.screenshot({ path: `${SHOT_DIR}/p3-phone-overview.png`, fullPage: false })
})
