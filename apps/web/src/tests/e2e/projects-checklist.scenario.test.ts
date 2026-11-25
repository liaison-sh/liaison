// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.checklist: the task checklist end to end, driven through the UI:
//   1. configure three validation levels (AI, Dev, Beta) in the statuses dialog
//   2. add three checklist items on the task detail
//   3. AI Success on every item, Dev Fail with a note on one: the note lands
//      in the task discussion with the spec text (Fail on <level> for "<item>")
//   4. the Kanban card counters read the right numbers, the failing level in
//      the error token, the fully successful level in the success token
//   5. the checklist never blocks a move: dragging the incomplete card to Done
//      succeeds, no toast, the card lands in Done with its counters
//   6. complete everything (Success or N/A): the counters follow
//   7. "Show checklist on cards" off in the statuses dialog hides the counters
import { api } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

interface TaskRow {
  id: string
  key: string | null
  statusId: string
}

async function fetchTask(
  env: { serverUrl: string },
  token: string,
  projectId: string,
  taskId: string,
): Promise<TaskRow | undefined> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token })
  return (r.body.data as { items: TaskRow[] }).items.find((t) => t.id === taskId)
}

/** Same DataTransfer choreography as projects-dnd: drop on the column body. */
async function dragCardToColumn(page: Page, taskId: string, statusId: string) {
  await page.evaluate(
    ({ taskId, statusId }) => {
      const src = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null
      const tgt = document.querySelector(`[data-status-id="${statusId}"]`) as HTMLElement | null
      if (!src || !tgt) throw new Error(`drag elements missing: ${taskId} -> ${statusId}`)
      const dt = new DataTransfer()
      const rect = tgt.getBoundingClientRect()
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + rect.height * 0.8
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
      tgt.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      tgt.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }))
    },
    { taskId, statusId },
  )
}

function itemRow(page: Page, title: string): Locator {
  return page
    .getByTestId("task-detail.checklist")
    .locator("li[data-item-id]")
    .filter({ has: page.getByTestId("checklist.title").getByText(title, { exact: true }) })
}

function chip(row: Locator, levelId: string): Locator {
  return row.locator(`[data-testid="checklist.chip"][data-level-id="${levelId}"]`)
}

async function setState(row: Locator, levelId: string, state: "success" | "na" | "not_done") {
  const c = chip(row, levelId)
  const popover = row.getByTestId("checklist.chip-popover")
  await c.click()
  await popover.locator(`[data-testid="checklist.state-option"][data-state="${state}"]`).click()
  await expect(c).toHaveAttribute("data-state", state)
  await expect(popover).toHaveCount(0)
}

function counter(card: Locator, level: string): Locator {
  return card.locator(`[data-testid="checklist-counter"][data-level="${level}"]`)
}

test("projects.checklist: levels, fail note, counters, non-blocking drop, card option", async ({
  page,
  env,
  qa,
  world,
}) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  const seeded = await seedProjectWithTasks(env, qa.admin.token, {
    name: `Checklist-${Date.now()}`,
    tasks: [{ title: "Ship firmware 2.1", statusLabel: "todo" }],
  })
  const taskId = seeded.tasks[0]!.id
  const todo = seeded.statuses.find((s) => s.label === "todo")!
  const done = seeded.statuses.find((s) => s.label === "done")!
  const taskKey = (await fetchTask(env, qa.admin.token, seeded.id, taskId))?.key
  expect(taskKey, "task has a display key").toBeTruthy()

  await loginAs(page, env, "admin@test.com", "12345678")
  const boardUrl = `http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`
  await page.goto(boardUrl)
  await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })

  // ── 1. Levels in the statuses dialog ──
  await page.getByTestId("project-workspace.manage-statuses").click()
  const levels = page.getByTestId("levels.section")
  await expect(levels).toBeVisible({ timeout: 5_000 })
  await expect(levels.getByTestId("levels.hint")).toHaveText(
    "Without levels, each item is a simple checkbox.",
  )
  // Agents are trusted on every level: no per-level agent setting.
  await expect(levels.getByTestId("levels.agents")).toHaveCount(0)
  await expect(levels.getByTestId("levels.show-on-cards")).toBeChecked()
  for (const name of ["AI", "Dev", "Beta"]) {
    await levels.getByTestId("levels.add").click()
    await levels.getByTestId("levels.name").last().fill(name)
  }
  await levels.getByTestId("levels.save").click()
  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${seeded.id}`, {
          token: qa.admin.token,
        })
        const lv = (r.body.data as { validationLevels?: Array<{ name: string }> }).validationLevels
        return (lv ?? []).map((l) => l.name).join(",")
      },
      { timeout: 5_000 },
    )
    .toBe("AI,Dev,Beta")
  // Saved rows carry their server ids.
  await expect(levels.locator('[data-testid="levels.row"][data-level-id=""]')).toHaveCount(0)
  const levelIds = await levels
    .getByTestId("levels.row")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.levelId ?? ""))
  expect(levelIds).toHaveLength(3)
  const [aiId, devId, betaId] = levelIds as [string, string, string]
  await page.keyboard.press("Escape")
  await expect(levels).toHaveCount(0)

  // ── 2. Three items on the task detail ──
  await page.goto(`http://localhost:${env.ports[1]}/projects/tasks/${taskId}`)
  const section = page.getByTestId("task-detail.checklist")
  await expect(section).toBeVisible({ timeout: 15_000 })
  const titles = ["Flash the bootloader", "Pedal calibration", "MIDI routing"]
  await section.getByTestId("checklist.add").click()
  for (const title of titles) {
    const input = section.getByTestId("checklist.add-input")
    await input.fill(title)
    await input.press("Enter")
    await expect(itemRow(page, title)).toHaveCount(1, { timeout: 5_000 })
  }
  await expect(section.locator("li[data-item-id]")).toHaveCount(3)
  // One chip per configured level, named from the project's own config.
  const firstChips = itemRow(page, titles[0]!).getByTestId("checklist.chip")
  await expect(firstChips).toHaveCount(3)
  await expect(firstChips).toHaveText(["AI", "Dev", "Beta"])

  // ── 3. AI Success on all, Dev Fail with a note on one ──
  for (const title of titles) await setState(itemRow(page, title), aiId, "success")

  const failRow = itemRow(page, "Pedal calibration")
  await chip(failRow, devId).click()
  await failRow.locator('[data-testid="checklist.state-option"][data-state="fail"]').click()
  const form = failRow.getByTestId("checklist.fail-form")
  await expect(form).toContainText("Posted to the task discussion")
  // A Fail needs its note: the submit stays disabled while it is empty.
  await expect(form.getByTestId("checklist.fail-submit")).toBeDisabled()
  const note = "Sustain pedal reads inverted on the rev B board"
  await form.getByTestId("checklist.fail-note").fill(note)
  await form.getByTestId("checklist.fail-submit").click()
  await expect(chip(failRow, devId)).toHaveAttribute("data-state", "fail", { timeout: 5_000 })

  await expect(page.getByTestId("checklist.header")).toContainText("0/3 complete")
  await expect(page.getByTestId("checklist.header")).toContainText("1 failing")
  await expect(page.getByTestId("task-detail.thread")).toContainText(
    `Fail on Dev for "Pedal calibration": ${note}`,
    { timeout: 10_000 },
  )

  // ── 4. Card counters on the board ──
  await page.goto(boardUrl)
  await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
  const card = page.locator(`[data-testid="project-kanban-card"][data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 5_000 })
  await expect(counter(card, "AI")).toHaveText("AI 3/3", { timeout: 5_000 })
  await expect(counter(card, "Dev")).toHaveText("Dev 0/3")
  await expect(counter(card, "Beta")).toHaveText("Beta 0/3")
  await expect(counter(card, "AI")).toHaveClass(/\btext-success\b/)
  await expect(counter(card, "Dev")).toHaveClass(/\btext-error\b/)
  await expect(counter(card, "Beta")).not.toHaveClass(/\btext-(error|success)\b/)
  // The error token resolves to a real colour, distinct from the neutral one.
  // Resolved and read in one evaluate: `card.evaluate` resolves the element,
  // then runs the function in a second round trip, and a board refetch in
  // between re-renders the card, leaving a detached node whose computed
  // colour is "".
  const colours = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="project-kanban-card"][data-task-id="${id}"]`)
    if (!el) throw new Error(`card ${id} is not on the board`)
    const pick = (lvl: string) => {
      const counter = el.querySelector(`[data-testid="checklist-counter"][data-level="${lvl}"]`)
      if (!counter) throw new Error(`card ${id} has no ${lvl} counter`)
      return getComputedStyle(counter).color
    }
    const probe = document.createElement("span")
    probe.style.color = "var(--color-error)"
    document.body.appendChild(probe)
    const errorToken = getComputedStyle(probe).color
    probe.remove()
    return { ai: pick("AI"), dev: pick("Dev"), beta: pick("Beta"), errorToken }
  }, taskId)
  expect(colours.dev).toBe(colours.errorToken)
  expect(colours.dev).not.toBe(colours.beta)
  expect(colours.dev).not.toBe(colours.ai)

  // ── 5. The incomplete checklist never blocks the drop to Done ──
  await dragCardToColumn(page, taskId, done.id)
  await expect
    .poll(async () => (await fetchTask(env, qa.admin.token, seeded.id, taskId))?.statusId, {
      timeout: 5_000,
    })
    .toBe(done.id)
  const doneCard = page.locator(
    `[data-status-id="${done.id}"] [data-testid="project-kanban-card"][data-task-id="${taskId}"]`,
  )
  await expect(doneCard).toBeVisible({ timeout: 5_000 })
  await expect(
    page.locator(`[data-status-id="${todo.id}"] [data-task-id="${taskId}"]`),
  ).toHaveCount(0)
  await expect(counter(doneCard, "AI")).toHaveText("AI 3/3")
  await expect(counter(doneCard, "Dev")).toHaveText("Dev 0/3")
  await expect(page.getByTestId("toast-error")).toHaveCount(0)

  // ── 6. Complete everything: the counters follow ──
  await page.goto(`http://localhost:${env.ports[1]}/projects/tasks/${taskId}`)
  await expect(page.getByTestId("task-detail.checklist")).toBeVisible({ timeout: 15_000 })
  for (const title of titles) {
    const row = itemRow(page, title)
    await setState(row, devId, "success")
    await setState(row, betaId, "na")
  }
  await expect(page.getByTestId("checklist.header")).toContainText("3/3 complete")
  await expect(page.getByTestId("checklist.header")).not.toContainText("failing")

  await page.goto(boardUrl)
  await expect(doneCard).toBeVisible({ timeout: 15_000 })
  await expect(counter(doneCard, "Dev")).toHaveText("Dev 3/3", { timeout: 5_000 })
  await expect(counter(doneCard, "Dev")).toHaveClass(/\btext-success\b/)
  // Beta is N/A everywhere: zero applicable items, so its counter is hidden.
  await expect(counter(doneCard, "Beta")).toHaveCount(0)

  // ── 7. The card summary is a per-project option ──
  await page.getByTestId("project-workspace.manage-statuses").click()
  const option = page.getByTestId("levels.show-on-cards")
  await expect(option).toBeChecked({ timeout: 5_000 })
  await option.click()
  await expect
    .poll(
      async () => {
        const r = await api(env.serverUrl, `/api/projects/${seeded.id}`, {
          token: qa.admin.token,
        })
        return (r.body.data as { checklistOnCards?: boolean }).checklistOnCards
      },
      { timeout: 5_000 },
    )
    .toBe(false)
  await page.keyboard.press("Escape")
  await expect(doneCard.getByTestId("checklist-counters")).toHaveCount(0, { timeout: 5_000 })
  // It sticks across a reload (read from the project GET).
  await page.reload()
  await expect(doneCard).toBeVisible({ timeout: 15_000 })
  await expect(doneCard.getByTestId("checklist-counters")).toHaveCount(0)
})
