// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.dnd-list-and-kanban — exercises every drag-and-drop path PMs
// expect from a project tool: reorder siblings, nest as child, unnest to a
// shallower depth (list view), reorder within column + change status (kanban).
//
// Each path drives the production UI via dispatched DataTransfer events
// (Playwright's high-level `dragAndDrop` is not granular enough for
// reorder-vs-nest decisions — we need explicit cursor-Y positioning to
// trigger the "above" / "into" / "below" zones) and asserts on the resulting
// state via the public API.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import {
  addChecklistItems,
  grantProjectScopes,
  seedProjectWithTasks,
} from "./helpers/projects-seed"

interface ProjectTaskShape {
  id: string
  title: string
  parentTaskId: string | null
  position: number
  statusId: string
}

async function fetchTasks(env: { serverUrl: string }, token: string, projectId: string) {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token })
  return (r.body.data as { items: ProjectTaskShape[] }).items
}

async function fetchProject(env: { serverUrl: string }, token: string, projectId: string) {
  const r = await api(env.serverUrl, `/api/projects/${projectId}`, { token })
  return r.body.data as {
    statuses: Array<{ id: string; label: string; order: number }>
  }
}

/**
 * Dispatch a sequence of dragstart → dragover (on target) → drop events,
 * targeting a specific cursor-Y position inside the target so the production
 * code's `computeDropPosition` lands on "above" | "into" | "below".
 */
async function performDrag(
  page: import("@playwright/test").Page,
  source: string,
  target: string,
  zone: "above" | "into" | "below",
) {
  await page.evaluate(
    ({ source, target, zone }) => {
      const src = document.querySelector(source) as HTMLElement | null
      const tgt = document.querySelector(target) as HTMLElement | null
      if (!src || !tgt) throw new Error(`drag elements missing: ${source} -> ${target}`)
      const dt = new DataTransfer()
      const rect = tgt.getBoundingClientRect()
      const yOffset =
        zone === "above"
          ? rect.height * 0.1
          : zone === "into"
            ? rect.height * 0.5
            : rect.height * 0.9
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + yOffset
      // Find the drag handle inside the source row, if any (list view) — kanban
      // cards are draggable wholesale.
      const handle = (src.querySelector('[data-testid="project-list-view.drag-handle"]') ??
        src) as HTMLElement
      handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
      tgt.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      tgt.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      handle.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }))
    },
    { source, target, zone },
  )
}

test.describe("projects dnd", () => {
  test("list — drag to nest (drop ON target middle)", async ({ page, env, qa, world }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndNest-${Date.now()}`,
      key: "DNA",
      tasks: [{ title: "Parent A" }, { title: "Parent B" }, { title: "Parent C" }],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })

    const childId = seeded.tasks.find((t) => t.title === "Parent C")!.id
    const parentId = seeded.tasks.find((t) => t.title === "Parent A")!.id
    await expect(page.locator(`[data-task-id="${childId}"]`)).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-task-id="${parentId}"]`)).toBeVisible({ timeout: 5_000 })
    await performDrag(page, `[data-task-id="${childId}"]`, `[data-task-id="${parentId}"]`, "into")

    await expect
      .poll(
        async () => {
          const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
          return tasks.find((t) => t.id === childId)?.parentTaskId
        },
        { timeout: 5_000 },
      )
      .toBe(parentId)
  })

  test("list — drag to reorder siblings (drop ABOVE target)", async ({ page, env, qa, world }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndReorder-${Date.now()}`,
      key: "DNB",
      tasks: [{ title: "Sib 1" }, { title: "Sib 2" }, { title: "Sib 3" }],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })

    const sib1 = seeded.tasks.find((t) => t.title === "Sib 1")!.id
    const sib3 = seeded.tasks.find((t) => t.title === "Sib 3")!.id
    await expect(page.locator(`[data-task-id="${sib1}"]`)).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-task-id="${sib3}"]`)).toBeVisible({ timeout: 5_000 })
    // Drop Sib 3 ABOVE Sib 1 → Sib 3 should become first sibling.
    await performDrag(page, `[data-task-id="${sib3}"]`, `[data-task-id="${sib1}"]`, "above")

    await expect
      .poll(
        async () => {
          const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
          const roots = tasks
            .filter((t) => t.parentTaskId === null)
            .sort((a, b) => a.position - b.position)
          return roots[0]?.id
        },
        { timeout: 5_000 },
      )
      .toBe(sib3)
  })

  test("list — drag to unnest (child dropped at root sibling level)", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    // Seed with one parent, one child of that parent, and a separate root sibling
    // we can drop above to unnest.
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndUnnest-${Date.now()}`,
      key: "DNC",
      tasks: [{ title: "Root parent" }, { title: "Other root" }],
    })
    const parentId = seeded.tasks.find((t) => t.title === "Root parent")!.id
    const otherRootId = seeded.tasks.find((t) => t.title === "Other root")!.id
    const child = await api(env.serverUrl, `/api/projects/${seeded.id}/tasks`, {
      token: qa.admin.token,
      body: { title: "Nested child", parentTaskId: parentId },
    })
    const childId = (child.body.data as { id: string }).id

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`[data-task-id="${childId}"]`)).toBeVisible({ timeout: 5_000 })

    // Drop child ABOVE the other root → child becomes a root sibling.
    await expect
      .poll(
        async () => {
          await performDrag(
            page,
            `[data-task-id="${childId}"]`,
            `[data-task-id="${otherRootId}"]`,
            "above",
          )
          const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
          return tasks.find((t) => t.id === childId)?.parentTaskId
        },
        { timeout: 10_000 },
      )
      .toBe(null)
  })

  test("kanban — drag card across columns changes status", async ({ page, env, qa, world }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndKanban-${Date.now()}`,
      key: "DND",
      tasks: [
        { title: "K1", statusLabel: "backlog" },
        { title: "K2", statusLabel: "todo" },
      ],
    })
    const detail = await fetchProject(env, qa.admin.token, seeded.id)
    const todo = detail.statuses.find((s) => s.label === "todo")!
    const k1Id = seeded.tasks.find((t) => t.title === "K1")!.id

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })

    await expect(page.locator(`[data-task-id="${k1Id}"]`)).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-status-id="${todo.id}"]`)).toBeVisible({ timeout: 5_000 })
    // Drop K1 (currently in backlog) onto the TODO column body.
    await performDrag(page, `[data-task-id="${k1Id}"]`, `[data-status-id="${todo.id}"]`, "into")

    await expect
      .poll(
        async () => {
          const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
          return tasks.find((t) => t.id === k1Id)?.statusId
        },
        { timeout: 5_000 },
      )
      .toBe(todo.id)
  })

  test("kanban — drag card above another card reorders within column", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndReorderKanban-${Date.now()}`,
      key: "DNE",
      tasks: [
        { title: "RK1", statusLabel: "todo" },
        { title: "RK2", statusLabel: "todo" },
        { title: "RK3", statusLabel: "todo" },
      ],
    })
    const rk1 = seeded.tasks.find((t) => t.title === "RK1")!.id
    const rk3 = seeded.tasks.find((t) => t.title === "RK3")!.id

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    // Wait for both target cards to mount in the column.
    await expect(page.locator(`[data-task-id="${rk1}"]`)).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-task-id="${rk3}"]`)).toBeVisible({ timeout: 5_000 })

    // Drop RK3 ABOVE RK1 → order becomes RK3, RK1, RK2.
    await performDrag(page, `[data-task-id="${rk3}"]`, `[data-task-id="${rk1}"]`, "above")

    await expect
      .poll(
        async () => {
          const tasks = await fetchTasks(env, qa.admin.token, seeded.id)
          return tasks
            .filter((t) => t.title === "RK3" || t.title === "RK1")
            .sort((a, b) => a.position - b.position)[0]?.title
        },
        { timeout: 5_000 },
      )
      .toBe("RK3")
  })

  test("kanban: an incomplete checklist never blocks the drop to Done", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: `DndChecklist-${Date.now()}`,
      key: "DNF",
      tasks: [
        { title: "Unchecked", statusLabel: "in_progress" },
        { title: "Already shipped", statusLabel: "done" },
      ],
    })
    const detail = await fetchProject(env, qa.admin.token, seeded.id)
    const inProgress = detail.statuses.find((s) => s.label === "in_progress")!
    const done = detail.statuses.find((s) => s.label === "done")!
    const taskId = seeded.tasks.find((t) => t.title === "Unchecked")!.id
    const shippedId = seeded.tasks.find((t) => t.title === "Already shipped")!.id
    // Plain mode (no levels): one unchecked item, the checklist is incomplete.
    await addChecklistItems(env, qa.admin.token, seeded.id, taskId, ["Release notes reviewed"])

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    const inOwnColumn = page.locator(
      `[data-status-id="${inProgress.id}"] [data-task-id="${taskId}"]`,
    )
    const inDone = page.locator(`[data-status-id="${done.id}"] [data-task-id="${taskId}"]`)
    await expect(inOwnColumn).toBeVisible({ timeout: 5_000 })
    await expect(inOwnColumn.getByTestId("checklist-counter")).toHaveText("0/1")

    // Card drop (above a card already in Done), then a column-body drop: both
    // paths land the card in Done with its counters, and no toast.
    for (const [target, zone] of [
      [`[data-task-id="${shippedId}"]`, "above"],
      [`[data-status-id="${done.id}"]`, "into"],
    ] as const) {
      await performDrag(page, `[data-task-id="${taskId}"]`, target, zone)
      await expect
        .poll(
          async () =>
            (await fetchTasks(env, qa.admin.token, seeded.id)).find((t) => t.id === taskId)
              ?.statusId,
          { timeout: 5_000 },
        )
        .toBe(done.id)
      await expect(inDone).toBeVisible({ timeout: 5_000 })
      await expect(inOwnColumn).toHaveCount(0)
      await expect(inDone.getByTestId("checklist-counter")).toHaveText("0/1")
      await expect(page.getByTestId("toast-error")).toHaveCount(0)
      // Back to In progress for the next path.
      const back = await api(env.serverUrl, `/api/projects/${seeded.id}/tasks/${taskId}/move`, {
        method: "POST",
        token: qa.admin.token,
        body: { statusId: inProgress.id },
      })
      expect(back.status).toBe(200)
      await expect(inOwnColumn).toBeVisible({ timeout: 5_000 })
    }
  })
})
