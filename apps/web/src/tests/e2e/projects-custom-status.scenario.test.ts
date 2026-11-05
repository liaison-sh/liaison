// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.custom-status-rename-drag — full StatusManager UI flow:
// add → reorder → rename → drag a task into the renamed status → delete-in-use 409
// dialog with the spec's `<N> tasks still use this status. Move them first.` copy
// → migrate via the dialog → retry delete (success).
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

async function dragIntoColumn(
  page: import("@playwright/test").Page,
  source: string,
  target: string,
) {
  await page.evaluate(
    ({ source, target }) => {
      const src = document.querySelector(source) as HTMLElement | null
      const tgt = document.querySelector(target) as HTMLElement | null
      if (!src || !tgt) throw new Error(`drag elements missing: ${source} -> ${target}`)
      const dt = new DataTransfer()
      const rect = tgt.getBoundingClientRect()
      const clientX = rect.left + 48
      const clientY = rect.top + 96
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
      tgt.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      tgt.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }))
    },
    { source, target },
  )
}

test("projects.custom-status-rename-drag", async ({ page, env, qa, world }) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)

  const seeded = await seedProjectWithTasks(env, qa.admin.token, {
    name: `CustomStatus-${Date.now()}`,
    tasks: [
      { title: "First task", statusLabel: "backlog" },
      { title: "Second task", statusLabel: "backlog" },
    ],
  })
  const projectId = seeded.id

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/projects/${projectId}?view=kanban`)
  await page.waitForSelector("[data-testid='project-workspace']", { timeout: 15_000 })
  await page.waitForSelector(
    "[data-testid='project-kanban-board'], [data-testid='status-grouped-vertical']",
    { timeout: 15_000 },
  )

  // 1. Open the status manager from the workspace top bar.
  await page.getByTestId("project-workspace.manage-statuses").click()
  await expect(page.getByTestId("status-manager")).toBeVisible({ timeout: 5_000 })

  const initialRowCount = await page.getByTestId("status-manager.row").count()

  // 2. Add a new status via the UI.
  await page.getByTestId("status-manager.add-trigger").click()
  const addedLabel = `Review-${Date.now()}`
  await page.getByTestId("status-manager.add-input").fill(addedLabel)
  await page.getByTestId("status-manager.add-confirm").click()

  await expect
    .poll(async () => page.getByTestId("status-manager.row").count(), { timeout: 5_000 })
    .toBe(initialRowCount + 1)

  const projectAfterAdd = (
    await api(env.serverUrl, `/api/projects/${projectId}`, { token: qa.admin.token })
  ).body.data as {
    statuses: Array<{ id: string; label: string; order: number }>
  }
  const addedStatus = projectAfterAdd.statuses.find((s) => s.label === addedLabel)!
  expect(addedStatus).toBeDefined()

  // 3. Reorder: move the first row down once and confirm the persisted order changes.
  const firstRowBefore = page.getByTestId("status-manager.row").first()
  const firstStatusIdBefore = await firstRowBefore.getAttribute("data-status-id")
  await page.getByTestId("status-manager.move-down").first().click()

  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${projectId}`, {
          token: qa.admin.token,
        })
        const statuses = r.body.data.statuses as Array<{ id: string; order: number }>
        return [...statuses].sort((a, b) => a.order - b.order)[0]?.id
      },
      { timeout: 5_000 },
    )
    .not.toBe(firstStatusIdBefore)

  // 4. Rename the newly-added status via the inline rename UI.
  const addedRow = page.locator(
    `[data-testid="status-manager.row"][data-status-id="${addedStatus.id}"]`,
  )
  await addedRow.getByTestId("status-manager.rename").click()
  // No hyphen or underscore: the board tidies those to spaces in a named
  // column (prettyStatus), and the label is matched verbatim below.
  const renamedLabel = `Renamed ${Date.now()}`
  await page.getByTestId("status-manager.rename-input").fill(renamedLabel)
  await page.getByTestId("status-manager.rename-save").click()

  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${projectId}`, {
          token: qa.admin.token,
        })
        const statuses = r.body.data.statuses as Array<{ id: string; label: string }>
        return statuses.find((s) => s.id === addedStatus.id)?.label
      },
      { timeout: 5_000 },
    )
    .toBe(renamedLabel)

  // 5. Close the dialog, then drag a task into the renamed kanban column.
  // Press Escape to close the Kobalte dialog overlay.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("status-manager")).not.toBeVisible({ timeout: 5_000 })

  // Confirm the kanban board reflects the renamed column label.
  await page.waitForFunction(
    (label) =>
      Array.from(
        document.querySelectorAll(
          '[data-testid="project-kanban-column"], [data-testid="status-grouped-vertical.section"]',
        ),
      ).some((el) => (el.textContent ?? "").includes(label)),
    renamedLabel,
    { timeout: 5_000 },
  )

  const firstTask = seeded.tasks.find((t) => t.title === "First task")!
  const secondTask = seeded.tasks.find((t) => t.title === "Second task")!

  // Drag the first task into the renamed status column. dragAndDrop targets the
  // column element; the production drop handler reads data-status-id from the
  // closest column.
  await dragIntoColumn(
    page,
    `[data-task-id="${firstTask.id}"]`,
    `[data-testid="project-kanban-column"][data-status-id="${addedStatus.id}"]`,
  )

  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, {
          token: qa.admin.token,
        })
        return (r.body.data.items as Array<{ id: string; statusId: string }>).find(
          (t) => t.id === firstTask.id,
        )?.statusId
      },
      { timeout: 8_000 },
    )
    .toBe(addedStatus.id)

  // Move the second task into the renamed status as well so we have 2 in-use,
  // exercising the "<N> tasks still use this status" copy with a multi-task count.
  await api(env.serverUrl, `/api/projects/${projectId}/tasks/${secondTask.id}/move`, {
    token: qa.admin.token,
    method: "POST",
    body: { statusId: addedStatus.id },
  })

  // 6. Try to delete the in-use status — expect the 409 remediation dialog.
  await page.getByTestId("project-workspace.manage-statuses").click()
  await expect(page.getByTestId("status-manager")).toBeVisible({ timeout: 5_000 })

  const renamedRow = page.locator(
    `[data-testid="status-manager.row"][data-status-id="${addedStatus.id}"]`,
  )
  await renamedRow.getByTestId("status-manager.delete").click()
  await page.getByTestId("delete-status-dialog.delete").click()

  await expect(page.getByTestId("delete-status-dialog.in-use")).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId("delete-status-dialog.count")).toHaveText("2")
  // Required spec copy.
  await expect(page.getByTestId("delete-status-dialog.in-use")).toContainText(
    "tasks still use this status. Move them first.",
  )

  // 7. Pick a migration target and migrate-and-delete; the dialog closes on success.
  const migrationTarget = projectAfterAdd.statuses.find((s) => s.label === "todo")!
  await page.getByTestId("delete-status-dialog.migrate-target").selectOption(migrationTarget.id)
  await page.getByTestId("delete-status-dialog.migrate-and-delete").click()

  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${projectId}`, {
          token: qa.admin.token,
        })
        const statuses = r.body.data.statuses as Array<{ id: string }>
        return statuses.some((s) => s.id === addedStatus.id)
      },
      { timeout: 5_000 },
    )
    .toBe(false)

  // The migrated tasks now live under the migration-target status.
  const tasksAfter = (
    await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token: qa.admin.token })
  ).body.data.items as Array<{ id: string; statusId: string }>
  expect(tasksAfter.find((t) => t.id === firstTask.id)?.statusId).toBe(migrationTarget.id)
  expect(tasksAfter.find((t) => t.id === secondTask.id)?.statusId).toBe(migrationTarget.id)
})
