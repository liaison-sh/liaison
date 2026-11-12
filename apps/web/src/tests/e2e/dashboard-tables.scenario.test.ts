// SPDX-License-Identifier: FSL-1.1-ALv2
// Dashboard tables, end to end: a person creates a table from the Dashboards sidebar, adds its
// columns on Settings, adds and edits rows in the grid and undoes a change from History. A table
// made over the REST API and shared view-only with a second person reads but refuses their
// writes, and stays invisible to a third. An agent writes rows through the tool pipeline; a
// dashboard charts the table in a bar block beside the editable block, which shows another
// writer's row live. TABLES_E2E_SHOTS names a folder for the screenshots (else the test output).
import { join } from "node:path"
import { api, login } from "@liaison/test-helpers"
import type { Page, TestInfo } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({
    path: process.env.TABLES_E2E_SHOTS
      ? join(process.env.TABLES_E2E_SHOTS, `${name}.png`)
      : info.outputPath(`${name}.png`),
    fullPage: false,
  })

async function openDashboardsRail(page: Page, port: number) {
  await page.goto(`http://localhost:${port}/`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.getByTestId("activity-dashboards").click()
}

/** The id of the grid's first row whose cell `key` reads `text`. */
async function rowIdOf(page: Page, grid: string, key: string, text: string): Promise<string> {
  const cell = page.locator(`[data-testid^="${grid}-cell-"][data-testid$="-${key}"]`, {
    hasText: text,
  })
  await expect(cell.first()).toBeVisible({ timeout: 15_000 })
  const id = (await cell.first().getAttribute("data-testid")) ?? ""
  return id.slice(`${grid}-cell-`.length, -`-${key}`.length)
}

test("a person creates a table in the UI, fills it, edits a cell and undoes the edit", async ({
  authenticatedPage,
  env,
}, info) => {
  const page = authenticatedPage
  await openDashboardsRail(page, env.ports[1])

  await page.getByTestId("dashboards-sidebar-new-table").click()
  await page.getByTestId("dashboards-sidebar-new-table-name").fill("E2E repairs")
  await page.getByTestId("dashboards-sidebar-new-table-name").press("Enter")
  await expect(page.getByTestId("table-page-title")).toHaveText("E2E repairs")
  // A new table has no column: it opens on Settings.
  await expect(page.getByTestId("table-settings")).toBeVisible()

  for (const [label, type] of [
    ["Item", "text"],
    ["Units", "number"],
  ] as const) {
    await page.getByTestId("table-settings-new-label").fill(label)
    await page.getByTestId("table-settings-new-type").selectOption(type)
    await page.getByTestId("table-settings-add-column-save").click()
    await expect(page.getByTestId(`table-settings-column-${label.toLowerCase()}`)).toBeVisible()
  }
  await shot(page, info, "01-ui-create-table-settings")

  // The same name again is refused with its own message.
  await page.getByTestId("dashboards-sidebar-new-table").click()
  await page.getByTestId("dashboards-sidebar-new-table-name").fill("E2E repairs")
  await page.getByTestId("dashboards-sidebar-new-table-name").press("Enter")
  await expect(page.getByTestId("dashboards-sidebar-new-table-error")).toContainText("E2E repairs")
  await page.getByTestId("dashboards-sidebar-new-table-name").press("Escape")

  await page.getByTestId("table-page-tab-grid").click()
  const grid = "table-page-grid"
  await page.getByTestId(`${grid}-add`).first().click()
  await page.getByTestId(`${grid}-add-item`).fill("Stand bag")
  await page.getByTestId(`${grid}-add-units`).fill("12")
  await page.getByTestId(`${grid}-add-save`).click()
  const rowId = await rowIdOf(page, grid, "item", "Stand bag")
  await expect(page.getByTestId(`${grid}-cell-${rowId}-units`)).toHaveText("12")

  await page.getByTestId(`${grid}-edit-${rowId}-units`).click()
  const editor = page.getByTestId(`${grid}-editor-${rowId}-units`)
  await editor.fill("15")
  await editor.press("Enter")
  await expect(page.getByTestId(`${grid}-cell-${rowId}-units`)).toHaveText("15")
  await shot(page, info, "02-ui-rows-added-and-edited")

  await page.getByTestId("table-page-tab-history").click()
  const undo = page.locator('[data-testid^="table-page-history-undo-"]').first()
  await expect(undo).toBeVisible({ timeout: 15_000 })
  await undo.click()
  await page.getByTestId("table-page-tab-grid").click()
  await expect(page.getByTestId(`${grid}-cell-${rowId}-units`)).toHaveText("12")
  await shot(page, info, "03-ui-undo")
})

test("a REST table: viewer reads only, a non-grantee sees nothing, an agent writes, a bar block charts it", async ({
  authenticatedPage,
  browser,
  env,
  qa,
}, info) => {
  const page = authenticatedPage
  const { accessToken } = await login(env.serverUrl, "admin@test.com", "12345678")
  const as = (token: string, path: string, method = "GET", body?: unknown) =>
    api(env.serverUrl, path, { method, token, ...(body === undefined ? {} : { body }) })

  const created = await as(accessToken, "/api/dashboards/tables", "POST", {
    name: "E2E inbound batches",
    columns: [
      { key: "batch", label: "Batch", type: "text", required: true },
      { key: "status", label: "Status", type: "choice", choices: ["Planned", "In transit"] },
      { key: "units", label: "Units", type: "number" },
    ],
  })
  expect(created.status).toBe(201)
  const table = created.body.data as { id: string; droppedKeys: string[] }
  expect(table.droppedKeys).toEqual([])

  const shared = await as(accessToken, `/api/dashboards/tables/${table.id}/sharing`, "PUT", {
    users: [{ userId: qa.amina.id, role: "viewer" }],
  })
  expect(shared.status).toBe(200)

  // The agent tool pipeline (executeTool), as the admin.
  const wrote = await as(accessToken, "/api/apps/tools/kernel:tables_rows_write", "POST", {
    params: {
      tableId: table.id,
      ops: [
        { op: "add", cells: { batch: "B4", status: "In transit", units: 120 } },
        { op: "add", cells: { batch: "B5", status: "Planned", units: 300 } },
        { op: "add", cells: { batch: "B6", status: "Planned", units: 80 } },
      ],
    },
  })
  expect(wrote.status).toBe(200)
  expect(wrote.body.data.rows).toHaveLength(3)

  // Viewer: reads, cannot write.
  const viewerRows = await as(qa.amina.token, `/api/dashboards/tables/${table.id}/rows`)
  expect(viewerRows.status).toBe(200)
  expect(viewerRows.body.data.rows).toHaveLength(3)
  const viewerWrite = await as(qa.amina.token, `/api/dashboards/tables/${table.id}/rows`, "POST", {
    ops: [{ op: "add", cells: { batch: "X" } }],
  })
  expect([403, 404]).toContain(viewerWrite.status)
  // Non-grantee: nothing, as if it did not exist.
  expect((await as(qa.lucas.token, `/api/dashboards/tables/${table.id}`)).status).toBe(404)
  expect((await as(qa.lucas.token, `/api/dashboards/tables/${table.id}/rows`)).status).toBe(404)
  const lucasList = await as(qa.lucas.token, "/api/dashboards/tables")
  expect(lucasList.body.data.tables.map((t: { id: string }) => t.id)).not.toContain(table.id)

  // The viewer's grid in the browser: rows, no edit control.
  const viewerContext = await browser.newContext()
  const viewerPage = await viewerContext.newPage()
  await loginAs(viewerPage, env, qa.amina.email, "QaPass1!")
  await openDashboardsRail(viewerPage, env.ports[1])
  await viewerPage.getByTestId(`dashboards-sidebar-table-${table.id}`).click()
  const vGrid = "table-page-grid"
  const b4 = await rowIdOf(viewerPage, vGrid, "batch", "B4")
  await expect(viewerPage.getByTestId(`${vGrid}-edit-${b4}-units`)).toHaveCount(0)
  await expect(viewerPage.getByTestId(`${vGrid}-add`)).toHaveCount(0)
  await shot(viewerPage, info, "04-viewer-read-only")
  await viewerContext.close()

  // A non-grantee's sidebar does not list it.
  const otherContext = await browser.newContext()
  const otherPage = await otherContext.newPage()
  await loginAs(otherPage, env, qa.lucas.email, "QaPass1!")
  await openDashboardsRail(otherPage, env.ports[1])
  await expect(otherPage.getByTestId("dashboards-sidebar-tables")).toBeVisible()
  await expect(otherPage.getByTestId(`dashboards-sidebar-table-${table.id}`)).toHaveCount(0)
  await shot(otherPage, info, "05-non-grantee-sees-nothing")
  await otherContext.close()

  // A dashboard: the editable block and a bar chart of units by status.
  const dash = await as(accessToken, "/api/dashboards", "POST", {
    title: "E2E inbound",
    visibility: "personal",
    spec: {
      v: 1,
      layout: "grid",
      blocks: [
        {
          id: "grid",
          type: "table",
          title: "Batches",
          width: 2,
          source: { kind: "table", table: table.id },
          map: { editable: true },
        },
        {
          id: "units",
          type: "bar",
          title: "Units by status",
          width: 1,
          source: { kind: "table", table: table.id },
          map: { groupBy: { field: "status" }, y: "units", agg: "sum" },
        },
      ],
    },
  })
  expect([200, 201]).toContain(dash.status)
  const dashId = (dash.body.data ?? dash.body).id as string

  await openDashboardsRail(page, env.ports[1])
  await page.getByTestId(`dashboards-sidebar-row-${dashId}`).click()
  const bar = page.getByTestId("dashboard-block-units")
  await expect(bar).toHaveAttribute("data-state", "ready", { timeout: 20_000 })
  const blockGrid = "table-block-grid"
  await rowIdOf(page, blockGrid, "batch", "B5")
  await shot(page, info, "06-dashboard-bar-and-editable-block")

  // Another writer's row reaches the open block live (kernel:dashboard_table_row frame).
  const live = await as(accessToken, "/api/apps/tools/kernel:tables_rows_write", "POST", {
    params: { tableId: table.id, ops: [{ op: "add", cells: { batch: "B7", units: 5 } }] },
  })
  expect(live.status).toBe(200)
  await rowIdOf(page, blockGrid, "batch", "B7")
  await shot(page, info, "07-live-row-from-agent-write")
})
