// SPDX-License-Identifier: FSL-1.1-ALv2
// Dashboards: a dashboard with one block read from the data store and one read
// from a kernel tool opens in its tab from Home's Dashboards section, and both
// blocks draw their data. The rail's Dashboards entry lists them, and one
// shared with the org while the page is open shows up without a reload. A
// block that follows the dashboard's time range reads again when a period is
// picked, and the link carries the period.
import { api, login } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { seedFactory } from "./helpers/seed"

test("a seeded dashboard renders a store block and a tool block", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const { accessToken } = await login(env.serverUrl, "admin@test.com", "12345678")

  // Three orders in the agent's own store namespace.
  for (const [id, total] of [
    ["o1", 10],
    ["o2", 15],
    ["o3", 17],
  ] as const) {
    await seedFactory(env, world.org.id, "appDocument", {
      app: "agent",
      collection: "e2e_orders",
      id,
      data: { title: `Order ${id}`, total },
    })
  }

  const created = await api(env.serverUrl, "/api/dashboards", {
    method: "POST",
    token: accessToken,
    body: {
      title: "E2E sales",
      visibility: "personal",
      spec: {
        v: 1,
        layout: "grid",
        blocks: [
          {
            id: "revenue",
            type: "metric",
            title: "Revenue",
            width: 1,
            source: { kind: "store", app: "agent", collection: "e2e_orders", query: {} },
            map: { value: "total", agg: "sum", format: "number" },
          },
          {
            id: "people",
            type: "table",
            title: "People",
            width: 2,
            source: { kind: "tool", tool: "kernel:users_list", params: {} },
            map: { columns: [{ field: "name", label: "Name" }] },
          },
        ],
      },
    },
  })
  expect([200, 201]).toContain(created.status)
  const id = (created.body.data ?? created.body).id as string

  await page.goto(`http://localhost:${env.ports[1]}/`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.getByTestId("activity-dashboards").click()
  await page.getByTestId(`dashboards-sidebar-row-${id}`).click()

  await expect(page.getByTestId("dashboard-title")).toHaveText("E2E sales")
  await expect(page.getByTestId("dashboard-visibility")).toHaveAttribute(
    "data-visibility",
    "personal",
  )
  const revenue = page.getByTestId("dashboard-block-revenue")
  await expect(revenue).toHaveAttribute("data-state", "ready", { timeout: 20_000 })
  await expect(revenue.getByTestId("block-metric-value")).toHaveText("42")
  const people = page.getByTestId("dashboard-block-people")
  await expect(people).toHaveAttribute("data-state", "ready", { timeout: 20_000 })
  await expect(people.getByTestId("block-table")).toContainText("Elodie Vasseur")
  await expect(page).toHaveURL(new RegExp(`/dashboard/${id}$`))
})

test("the rail's Dashboards page lists dashboards and shows a new one without a reload", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  const { accessToken } = await login(env.serverUrl, "admin@test.com", "12345678")

  await page.goto(`http://localhost:${env.ports[1]}/`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.getByTestId("activity-dashboards").click()
  await expect(page).toHaveURL(/\/dashboards$/)
  const index = page.getByTestId("dashboards-index")
  await expect(index).toBeVisible()
  // Either the empty state or the list, once the list has been read.
  await expect(
    index.getByTestId("dashboards-index-empty").or(index.getByTestId("dashboards-index-list")),
  ).toBeVisible()

  // Shared with the org from elsewhere (the API here), while the page is open.
  const created = await api(env.serverUrl, "/api/dashboards", {
    method: "POST",
    token: accessToken,
    body: { title: "E2E live org", visibility: "org", spec: { v: 1, layout: "grid", blocks: [] } },
  })
  expect([200, 201]).toContain(created.status)
  const id = (created.body.data ?? created.body).id as string

  const row = page.getByTestId(`dashboards-index-row-${id}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(page.getByTestId("dashboard-title")).toHaveText("E2E live org")
  await expect(page.getByTestId("dashboard-empty")).toBeVisible()

  // Deleted elsewhere: the open tab says so.
  const removed = await api(env.serverUrl, `/api/dashboards/${id}`, {
    method: "DELETE",
    token: accessToken,
  })
  expect([200, 204]).toContain(removed.status)
  await expect(page.getByTestId("dashboard-not-found")).toBeVisible({ timeout: 15_000 })
})

test("picking a period re-reads a block that follows the dashboard's range", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const { accessToken } = await login(env.serverUrl, "admin@test.com", "12345678")

  // Two orders dated yesterday: inside the last 30 days, outside last year.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  for (const [id, total] of [
    ["r1", 20],
    ["r2", 22],
  ] as const) {
    await seedFactory(env, world.org.id, "appDocument", {
      app: "agent",
      collection: "e2e_range_orders",
      id,
      data: { title: `Order ${id}`, total, day: yesterday },
    })
  }

  const created = await api(env.serverUrl, "/api/dashboards", {
    method: "POST",
    token: accessToken,
    body: {
      title: "E2E range",
      visibility: "personal",
      spec: {
        v: 1,
        layout: "grid",
        timeRange: { preset: "last30d" },
        compare: "lastYear",
        blocks: [
          {
            id: "revenue",
            type: "metric",
            title: "Revenue",
            width: 1,
            source: {
              kind: "store",
              app: "agent",
              collection: "e2e_range_orders",
              query: { where: { day: { gte: "{{range.from}}", lte: "{{range.to}}" } } },
            },
            map: { value: "total", agg: "sum", format: "number" },
          },
        ],
      },
    },
  })
  expect([200, 201]).toContain(created.status)
  const id = (created.body.data ?? created.body).id as string

  await page.goto(`http://localhost:${env.ports[1]}/dashboard/${id}`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  const revenue = page.getByTestId("dashboard-block-revenue")
  await expect(revenue).toHaveAttribute("data-state", "ready", { timeout: 20_000 })
  await expect(revenue.getByTestId("block-metric-value")).toHaveText("42")
  await expect(page.getByTestId("dashboard-range-label")).toContainText("vs")
  await expect(page.getByTestId("dashboard-block-updated-revenue")).toBeVisible()

  // Last year: the block reads again, for that year, and finds no order (a sum of none is 0).
  const reread = page.waitForRequest(
    (r) => r.url().includes(`/blocks/revenue/data`) && r.url().includes("range=lastYear"),
  )
  await page.getByTestId("dashboard-range-trigger").click()
  await page.getByTestId("dashboard-range-preset-lastYear").click()
  await reread
  await expect(revenue.getByTestId("block-metric-value")).toHaveText("0", { timeout: 20_000 })
  await expect(page.getByTestId("dashboard-range-label")).toContainText(
    String(new Date().getFullYear() - 1),
  )
  await expect(page).toHaveURL(/range=lastYear&compare=lastYear/)
})
