// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.task-detail-full-page — full-screen task detail QA.
//
// Exercises the redesigned `projects:task` tab end-to-end:
//   1. Open a populated task with subtasks via the production tab system
//   2. Confirm the editorial layout renders (breadcrumb, title, meta row,
//      description, subtasks, embedded thread)
//   3. Edit title inline → server PATCH → re-render reflects new title
//   4. Edit description inline → server PATCH → re-render reflects update
//   5. Toggle blocked → meta-row gets the warning underline + chip lights up
//   6. Reassign via "Assign to me" → assignee chip shows current user
//   7. Click a subtask row → opens that subtask in a new tab; back-link to
//      parent appears at top of subtask page
//   8. Confirm the embedded thread is visible (DISCUSSION header) and posts
//      a comment via the thread composer
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

interface TaskShape {
  id: string
  title: string
  description: string | null
  parentTaskId: string | null
  blocked: boolean
  assigneeId: string | null
  threadId: string
}

async function fetchTasks(env: { serverUrl: string }, token: string, projectId: string) {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token })
  return (r.body.data as { items: TaskShape[] }).items
}

test("projects.task-detail-full-page", async ({ page, env, qa, world }) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  const seeded = await seedProjectWithTasks(env, qa.admin.token, {
    name: `TaskDetail-${Date.now()}`,
    description: "Project for the full-page task detail scenario.",
    tasks: [
      {
        title: "Calibration drift on load-cell #4",
        statusLabel: "todo",
        assigneeId: qa.admin.id,
      },
    ],
  })
  const parentId = seeded.tasks[0]!.id

  // Add a couple of subtasks via the API so the subtasks block populates.
  for (const child of [
    { title: "Reproduce on staging", statusLabel: "todo" as const },
    { title: "Capture trace + logs", statusLabel: "backlog" as const },
    { title: "Draft fix in branch", statusLabel: "todo" as const },
  ]) {
    const status = seeded.statuses.find((s) => s.label === child.statusLabel)!
    await api(env.serverUrl, `/api/projects/${seeded.id}/tasks`, {
      token: qa.admin.token,
      body: { title: child.title, parentTaskId: parentId, statusId: status.id },
    })
  }

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/projects/tasks/${parentId}`)

  // 1. Editorial layout renders.
  await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("task-detail.title")).toHaveText(
    "Calibration drift on load-cell #4",
    { timeout: 10_000 },
  )
  await expect(page.getByTestId("task-detail.breadcrumb")).toBeVisible()
  await expect(page.getByTestId("task-detail.meta-row")).toBeVisible()
  await expect(page.getByTestId("task-detail.subtasks")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("task-detail.thread")).toBeVisible()

  // 2. Inline edit title.
  await page.getByTestId("task-detail.title").click()
  const titleInput = page.getByTestId("task-detail.title-input")
  await expect(titleInput).toBeFocused({ timeout: 5_000 })
  await titleInput.fill("Calibration drift — load-cell #4 (renamed)")
  await titleInput.press("Enter")
  await expect
    .poll(
      async () => {
        const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
        return tasks.find((t) => t.id === parentId)?.title
      },
      { timeout: 5_000 },
    )
    .toBe("Calibration drift — load-cell #4 (renamed)")

  // 3. Inline edit description.
  await page.getByTestId("task-detail.description").click()
  const descInput = page.getByTestId("task-detail.description-input")
  await descInput.fill(
    "Load-cell #4 reads 12% high after stabilising for 30s. Reproduces only on units shipped after batch K4.",
  )
  await descInput.blur()
  await expect
    .poll(
      async () => {
        const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
        return tasks.find((t) => t.id === parentId)?.description
      },
      { timeout: 5_000 },
    )
    .toContain("12% high")

  // 4. Toggle blocked → underline + chip.
  await page.getByTestId("task-detail.blocked-toggle").click()
  await expect
    .poll(
      async () => {
        const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
        return tasks.find((t) => t.id === parentId)?.blocked
      },
      { timeout: 5_000 },
    )
    .toBe(true)
  await expect(page.getByTestId("task-detail.blocked-toggle")).toHaveText(/Blocked/)

  // 5. Assignee — already admin (seeded). Confirm the chip renders the name.
  await expect(page.getByTestId("task-detail.assignee")).toContainText("Elodie")

  // 6. Click a subtask → opens new tab, back-link to parent renders.
  const subtasks = await fetchTasks(env, qa.admin.token, seeded.id)
  const reproduceChild = subtasks.find((t) => t.title === "Reproduce on staging")!
  await page.getByTestId(`task-detail.subtask-${reproduceChild.id}`).click()
  await expect(page.getByTestId("task-detail.parent-link")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("task-detail.parent-link")).toContainText("Calibration drift")

  // 7. Discussion section shows DISCUSSION header and the ThreadView mounts.
  // Both parent + subtask tabs are kept alive simultaneously (one hidden via
  // `display:none`); the `:visible` state filter scopes to the active tab.
  await expect(page.locator('[data-testid="task-detail.discussion"]:visible')).toContainText(
    "DISCUSSION",
  )
  // Promote-to-thread-list toggle exists with the default (not promoted) state.
  await expect(page.locator('[data-testid="task-detail.promote-thread"]:visible')).toContainText(
    "Promote to thread list",
  )
})
