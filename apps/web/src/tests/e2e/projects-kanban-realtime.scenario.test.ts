// SPDX-License-Identifier: FSL-1.1-ALv2
// projects-kanban-status-realtime — two browser contexts; browser A drags a card
// between Kanban columns, and browser B receives the WS update within 1 s.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

const PROJECT_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

async function grantScopes(env: { db: { sql: any } }, orgId: string) {
  for (const scope of PROJECT_SCOPES) {
    await env.db
      .sql`INSERT INTO kernel.role_scope_grants (role_id, scope) SELECT id, ${scope} FROM kernel.roles WHERE org_id = ${orgId} ON CONFLICT DO NOTHING`
  }
}

async function dragTaskToStatus(
  page: import("@playwright/test").Page,
  taskId: string,
  statusId: string,
) {
  const card = `[data-testid="project-kanban-card"][data-task-id="${taskId}"]`
  const column = `[data-testid="project-kanban-column"][data-status-id="${statusId}"]`
  await page.locator(card).waitFor({ state: "visible", timeout: 10_000 })
  await page.locator(column).waitFor({ state: "visible", timeout: 10_000 })
  await page.dragAndDrop(card, column, { targetPosition: { x: 48, y: 96 } })
}

test("projects.kanban-status-realtime + projects.custom-status-rename-drag", async ({
  env,
  qa,
  world,
  browser,
}) => {
  await grantScopes(env, world.org.id)

  // Seed a project with two open statuses + one task in the first.
  const created = (
    await api(env.serverUrl, "/api/projects", {
      token: qa.admin.token,
      body: { name: `KanbanRT-${Date.now()}` },
    })
  ).body.data as {
    id: string
    statuses: Array<{ id: string; label: string; terminal: boolean }>
  }
  const projectId = created.id
  const fromStatus = created.statuses.find((s) => s.label === "backlog")!
  const toStatus = created.statuses.find((s) => s.label === "todo")!

  const taskRes = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, {
    token: qa.admin.token,
    body: { title: "Realtime card", statusId: fromStatus.id },
  })
  const taskId = (taskRes.body.data as { id: string }).id

  // Two contexts, both logged in as admin, both opening the same project.
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()

  await loginAs(pageA, env, "admin@test.com", "12345678")
  await loginAs(pageB, env, "admin@test.com", "12345678")
  await pageA.goto(`http://localhost:${env.ports[1]}/projects/${projectId}?view=kanban`)
  await pageB.goto(`http://localhost:${env.ports[1]}/projects/${projectId}?view=kanban`)

  await pageA.waitForSelector("[data-testid='project-kanban-board']", { timeout: 15_000 })
  await pageB.waitForSelector("[data-testid='project-kanban-board']", { timeout: 15_000 })

  // Wait until each page has actually rendered the seeded task (initial loadProject
  // has populated tasks). Without this, the move WS event can race the initial load
  // and project-store.handleTaskEvent drops events when state.current is still null.
  for (const p of [pageA, pageB]) {
    await p.waitForFunction((id) => !!document.querySelector(`[data-task-id="${id}"]`), taskId, {
      timeout: 10_000,
    })
  }

  // projects.kanban-status-realtime: page A drags the task; page B sees it under
  // the new status within the binding 1s WS budget.
  await dragTaskToStatus(pageA, taskId, toStatus.id)

  await pageB.waitForFunction(
    ({ status, task }) => {
      const board =
        document.querySelector('[data-testid="project-kanban-board"]') ??
        document.querySelector('[data-testid="status-grouped-vertical"]')
      if (!board) return false
      // Find the column for this status, then look for our task within it.
      const col = board.querySelector(`[data-status-id="${status}"]`)
      if (!col) return false
      return !!col.querySelector(`[data-task-id="${task}"]`)
    },
    { status: toStatus.id, task: taskId },
    { timeout: 1_000 },
  )

  // projects.custom-status-rename-drag: rename a status in A; B observes new label;
  // dragging a task into the renamed column still works through browser DnD.
  // No hyphen or underscore: the board tidies those to spaces in a named
  // column (prettyStatus), and the label is matched verbatim below.
  const newLabel = `Renamed ${Date.now()}`
  await api(env.serverUrl, `/api/projects/${projectId}/statuses/${toStatus.id}`, {
    token: qa.admin.token,
    method: "PATCH",
    body: { label: newLabel },
  })

  await pageB.waitForFunction(
    (label) =>
      !!Array.from(document.querySelectorAll('[data-testid="project-kanban-column"]'))
        .concat(
          Array.from(document.querySelectorAll('[data-testid="status-grouped-vertical.section"]')),
        )
        .find((el) => (el.textContent ?? "").includes(label)),
    newLabel,
    { timeout: 5_000 },
  )

  // Move it back, then drag into the renamed column from another column.
  await dragTaskToStatus(pageA, taskId, fromStatus.id)
  await pageA.waitForFunction(
    ({ status, task }) => {
      const col = document.querySelector(`[data-status-id="${status}"]`)
      return !!col?.querySelector(`[data-task-id="${task}"]`)
    },
    { status: fromStatus.id, task: taskId },
    { timeout: 5_000 },
  )
  await dragTaskToStatus(pageA, taskId, toStatus.id)
  await pageA.waitForFunction(
    ({ status, task }) => {
      const col = document.querySelector(`[data-status-id="${status}"]`)
      return !!col?.querySelector(`[data-task-id="${task}"]`)
    },
    { status: toStatus.id, task: taskId },
    { timeout: 5_000 },
  )

  await ctxA.close()
  await ctxB.close()
  expect(true).toBe(true)
})
