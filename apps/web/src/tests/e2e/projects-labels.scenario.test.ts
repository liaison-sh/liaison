// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.labels — the first five minutes of task labels, in a real
// browser against the real server:
//   - with no label group, neither a task chip nor the board's Labels filter shows
//   - an admin builds the "Nature" group (bug, evolution) in Settings > Projects
//     > Labels, and the whole-tree save survives a reload
//   - the task page chip sets a value; a subtask shows it inherited, muted, with
//     an "Inherited from <key>" tooltip
//   - kanban cards show the effective value, inherited ones muted
//   - the board Labels filter matches effective values (the subtask is in
//     "bug" through its parent), the "Showing N of M" counter agrees, and clear
//     removes the filter
import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { readLabelCatalog } from "./helpers/db-reads"
import {
  clearAllLabels,
  clearAllProjects,
  grantProjectScopes,
  seedProjectWithTasks,
} from "./helpers/projects-seed"

interface Journey {
  projectId: string
  parentId: string
  childId: string
  looseId: string
  parentKey: string
}

function url(env: WorkerEnv, path: string): string {
  return `http://localhost:${env.ports[1]}${path}`
}

async function createTask(
  env: WorkerEnv,
  token: string,
  projectId: string,
  body: { title: string; parentTaskId?: string },
): Promise<string> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token, body })
  if (r.status !== 200) throw new Error(`task create failed ${r.status}: ${JSON.stringify(r.body)}`)
  return (r.body.data as { id: string }).id
}

async function taskLabels(env: WorkerEnv, token: string, projectId: string, taskId: string) {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks/${taskId}`, { token })
  if (r.status !== 200) throw new Error(`task read failed ${r.status}: ${JSON.stringify(r.body)}`)
  return (r.body.data as { labels?: unknown[] }).labels ?? []
}

/** Parent P with subtask C, plus a loose task L. */
async function seedJourney(env: WorkerEnv, token: string): Promise<Journey> {
  const seeded = await seedProjectWithTasks(env, token, {
    name: `Labels Journey ${Date.now()}`,
    tasks: [{ title: "Fix login crash" }, { title: "Add CSV export" }],
  })
  const parentId = seeded.tasks[0]!.id
  const looseId = seeded.tasks[1]!.id
  const childId = await createTask(env, token, seeded.id, {
    title: "Reproduce on staging",
    parentTaskId: parentId,
  })
  const r = await api(env.serverUrl, `/api/projects/${seeded.id}/tasks/${parentId}`, { token })
  if (r.status !== 200) throw new Error(`task read failed ${r.status}: ${JSON.stringify(r.body)}`)
  const parentKey = (r.body.data as { key: string }).key
  return { projectId: seeded.id, parentId, childId, looseId, parentKey }
}

/**
 * The task page of one task. Open tabs stay mounted (hidden), so a page-wide
 * testid would also match the task opened before: scope to the task's root.
 */
function taskDetail(page: Page, id: string): Locator {
  return page.locator(`[data-testid="task-detail"][data-task-id="${id}"]`)
}

function taskCard(page: Page, id: string): Locator {
  return page.locator(`[data-testid="project-kanban-card"][data-task-id="${id}"]`)
}

async function expectVisibleCards(page: Page, ids: string[]) {
  await expect
    .poll(
      async () =>
        (
          await page
            .getByTestId("project-kanban-card")
            .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.taskId ?? ""))
        ).sort(),
      { timeout: 10_000 },
    )
    .toEqual([...ids].sort())
}

async function pickFilterValue(page: Page, groupId: string, name: string) {
  const chip = page.getByTestId("project-workspace.label-filter")
  await expect(chip).toBeEnabled()
  await chip.click()
  const section = page.locator(`[data-testid="label-filter.section"][data-group="${groupId}"]`)
  await expect(section).toBeVisible()
  await section.getByTestId("label-filter.option").filter({ hasText: name }).click()
}

/**
 * The element's computed colour once it stopped changing: chips carry
 * `transition-colors`, so a read in the render that switched their class is
 * mid-transition. Two consecutive equal reads mean it settled.
 */
async function settledColor(locator: Locator): Promise<string> {
  let previous: string | null = null
  let current = ""
  await expect
    .poll(
      async () => {
        current = await locator.evaluate((el) => getComputedStyle(el).color)
        const same = current === previous
        previous = current
        return same
      },
      { intervals: [200, 200, 200, 500], timeout: 5_000 },
    )
    .toBe(true)
  return current
}

/** Tree rows of the Labels section, in document order: name text and depth. */
async function treeRows(section: Locator): Promise<Array<{ name: string; depth: string }>> {
  return section.locator('[data-testid^="tree-row-"]').evaluateAll((els) =>
    els.map((e) => ({
      name: (e.querySelector('[data-testid^="tree-name-"]')?.textContent ?? "").trim(),
      depth: (e as HTMLElement).dataset.depth ?? "",
    })),
  )
}

const EXPECTED_TREE = [
  { name: "Nature", depth: "1" },
  { name: "bug", depth: "2" },
  { name: "evolution", depth: "2" },
]

test.describe("projects task labels", () => {
  test.beforeEach(async ({ env, world, qa }) => {
    // The taxonomy is org-wide: start from no project and no label group.
    await clearAllProjects(env, qa.admin.token)
    await clearAllLabels(env, qa.admin.token)
    // Scopes are embedded at login: grant before loginAs. The admin already
    // holds `*` (so `projects:labels:admin`); this is parity with the
    // precedent specs only.
    await grantProjectScopes(env, world.org.id, qa.admin.id)
  })

  test("admin builds a label group, labels a task, sees inheritance and filters the board", async ({
    page,
    env,
    qa,
    world,
  }) => {
    test.setTimeout(120_000)
    const token = qa.admin.token
    const j = await seedJourney(env, token)
    await loginAs(page, env, "admin@test.com", "12345678")

    // 0. No group in the org: no Labels filter chip, no task label chip.
    await page.goto(url(env, `/projects/${j.projectId}?view=kanban`))
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("project-kanban-card")).toHaveCount(3, { timeout: 15_000 })
    await expect(
      page.getByTestId("project-workspace.label-filter"),
      "criterion 11: no Labels filter while the org has no group",
    ).toHaveCount(0, { timeout: 10_000 })
    await page.goto(url(env, `/projects/tasks/${j.parentId}`))
    const parentMeta = taskDetail(page, j.parentId).getByTestId("task-detail.meta-row")
    await expect(parentMeta).toBeVisible({ timeout: 15_000 })
    await expect(
      parentMeta.locator('[data-testid^="task-detail.label-"]'),
      "criterion 11: no label chip while the org has no group",
    ).toHaveCount(0)

    // A. Settings > Projects > Labels: create Nature with bug and evolution.
    await page.goto(url(env, "/settings/apps/projects"))
    const section = page.getByTestId("settings-section-labels")
    await expect(section).toBeVisible({ timeout: 15_000 })
    // The empty text shows only once the tree has loaded: adding a node before
    // that would be wiped by the load's reset.
    await expect(section.getByText("Nothing here yet.")).toBeVisible({ timeout: 15_000 })
    await expect(section.getByTestId("tree-add-root")).toBeVisible()

    await section.getByTestId("tree-add-root").click()
    const input = section.getByTestId("tree-rename-input")
    await expect(input).toBeFocused()
    await input.fill("Nature")
    await input.press("Enter")
    const natureRow = section.locator('[data-testid^="tree-row-"]').filter({ hasText: "Nature" })
    await expect(natureRow).toHaveAttribute("data-depth", "1")

    for (const value of ["bug", "evolution"]) {
      await natureRow.locator('[data-testid^="tree-menu-"]').first().click()
      await page.getByRole("menuitem", { name: "Add inside" }).click()
      await expect(
        section.getByTestId("tree-rename-input"),
        "the new value's name input keeps the focus after the menu closes",
      ).toBeFocused()
      await section.getByTestId("tree-rename-input").fill(value)
      await section.getByTestId("tree-rename-input").press("Enter")
      await expect(section.getByTestId("tree-rename-input")).toHaveCount(0)
    }
    await expect.poll(() => treeRows(section)).toEqual(EXPECTED_TREE)

    await expect(section.getByTestId("tree-dirty-bar")).toBeVisible()
    await expect(section.getByTestId("tree-dirty-count")).toHaveText("3 unsaved changes")
    await section.getByTestId("tree-save").click()
    await expect(section.getByTestId("tree-dirty-bar")).toHaveCount(0, { timeout: 15_000 })
    await expect(section.getByTestId("tree-error")).toHaveCount(0)
    await expect(section.getByTestId("tree-conflict")).toHaveCount(0)

    await page.reload()
    const reloaded = page.getByTestId("settings-section-labels")
    await expect(
      reloaded.locator('[data-testid^="tree-row-"]').filter({ hasText: "Nature" }),
    ).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => treeRows(reloaded)).toEqual(EXPECTED_TREE)

    const catalog = await readLabelCatalog(env, world.org.id)
    expect(catalog.map((g) => g.name)).toEqual(["Nature"])
    const nature = catalog[0]!
    expect(nature.values.map((v) => [v.name, v.sortOrder])).toEqual([
      ["bug", 0],
      ["evolution", 1],
    ])
    const groupId = nature.id
    const bugId = nature.values[0]!.id
    const setNature = { name: "Set Nature" } as const

    // B. Task page: set Nature = bug through the chip picker.
    await page.goto(url(env, `/projects/tasks/${j.parentId}`))
    await expect(taskDetail(page, j.parentId)).toBeVisible({ timeout: 15_000 })
    const parentChip = parentMeta.getByTestId(`task-detail.label-${groupId}`)
    await expect(parentChip).toHaveText("Nature: not set", { timeout: 15_000 })
    await expect(parentChip).toHaveAttribute("data-inherited", "false")
    await expect(parentMeta.getByRole("button", setNature)).toBeVisible()

    await parentChip.click()
    const options = page.getByTestId("task-detail.label-option")
    await expect(options).toHaveText(["bug", "evolution"])
    await expect(page.getByTestId("task-detail.label-none")).toBeVisible()
    await options.filter({ hasText: "bug" }).click()
    await expect(parentChip).toHaveText("Nature: bug")
    await expect(parentChip).toHaveAttribute("data-inherited", "false")
    await expect
      .poll(() => taskLabels(env, token, j.projectId, j.parentId), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ groupId, valueId: bugId, inherited: false }),
        ]),
      )

    // L gets evolution over REST (names accepted), so the filter has something to exclude.
    const patchLoose = await api(env.serverUrl, `/api/projects/${j.projectId}/tasks/${j.looseId}`, {
      method: "PATCH",
      token,
      body: { labels: { Nature: "evolution" } },
    })
    expect(patchLoose.status, JSON.stringify(patchLoose.body)).toBe(200)

    // Reference colour of an own-value chip, from a settled, unhovered render.
    await page.goto(url(env, `/projects/tasks/${j.parentId}`))
    await expect(parentChip).toHaveText("Nature: bug", { timeout: 15_000 })
    await expect(parentMeta.getByRole("button", setNature)).toBeVisible()
    await page.mouse.move(0, 0)
    const ownColor = await settledColor(parentChip)

    // C. The subtask shows the parent's value, inherited and muted.
    await page.goto(url(env, `/projects/tasks/${j.childId}`))
    const childMeta = taskDetail(page, j.childId).getByTestId("task-detail.meta-row")
    const childChip = childMeta.getByTestId(`task-detail.label-${groupId}`)
    await expect(childChip).toHaveText("Nature: bug", { timeout: 15_000 })
    await expect(childChip).toHaveAttribute("data-inherited", "true")
    // The inherited chip renders read-only from the payload before the catalog
    // loads; the picker trigger is the catalog-ready signal.
    await expect(childMeta.getByRole("button", setNature)).toBeVisible()
    await page.mouse.move(0, 0)
    await expect(childChip).toHaveCSS("font-style", "italic")
    const inheritedColor = await settledColor(childChip)
    expect(inheritedColor, "an inherited chip is muted compared with an own value").not.toBe(
      ownColor,
    )

    await childChip.hover()
    await expect(page.getByTestId("tooltip-content")).toContainText(`Inherited from ${j.parentKey}`)

    await page.mouse.move(0, 0)
    await childChip.click()
    await expect(options).toHaveText(["bug", "evolution"])
    await expect(page.getByTestId("task-detail.label-none")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(options).toHaveCount(0)
    await expect(childChip).toHaveText("Nature: bug")
    await expect(childChip).toHaveAttribute("data-inherited", "true")

    // D. Kanban cards: value names only, inherited muted.
    await page.goto(url(env, `/projects/${j.projectId}?view=kanban`))
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("project-kanban-card")).toHaveCount(3, { timeout: 15_000 })
    const parentCardLabel = taskCard(page, j.parentId).getByTestId("project-kanban-card.label")
    await expect(parentCardLabel).toHaveText(["bug"])
    await expect(parentCardLabel).toHaveAttribute("data-inherited", "false")
    await expect(parentCardLabel).toHaveAttribute("title", "Nature: bug")
    const childCardLabel = taskCard(page, j.childId).getByTestId("project-kanban-card.label")
    await expect(childCardLabel).toHaveText(["bug"])
    await expect(childCardLabel).toHaveAttribute("data-inherited", "true")
    const looseCardLabel = taskCard(page, j.looseId).getByTestId("project-kanban-card.label")
    await expect(looseCardLabel).toHaveText(["evolution"])
    await expect(looseCardLabel).toHaveAttribute("data-inherited", "false")
    await expect(page.getByTestId("project-kanban-card.labels-more")).toHaveCount(0)

    // E. The board Labels filter and its "Showing N of M" counter.
    const filter = page.getByTestId("project-workspace.label-filter")
    await expect(filter).toBeEnabled({ timeout: 10_000 })
    await expect(filter).toHaveText("Labels")
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveCount(0)

    await filter.click()
    const filterSection = page.locator(
      `[data-testid="label-filter.section"][data-group="${groupId}"]`,
    )
    await expect(filterSection.getByTestId("label-filter.option")).toHaveText([
      "bug",
      "evolution",
      "No label",
    ])
    await filterSection.getByTestId("label-filter.option").filter({ hasText: "bug" }).click()
    // C is in "bug" through its parent: the effective-value rule.
    await expectVisibleCards(page, [j.parentId, j.childId])
    await expect(filter).toHaveText("Labels · 1")
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 2 of 3/i)
    await expect(page.getByTestId("project-workspace.label-filter-clear")).toBeVisible()

    // One value per group: evolution replaces bug.
    await pickFilterValue(page, groupId, "evolution")
    await expectVisibleCards(page, [j.looseId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 1 of 3/i)

    await page.getByTestId("project-workspace.label-filter-clear").click()
    await expectVisibleCards(page, [j.parentId, j.childId, j.looseId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveCount(0)
    await expect(filter).toHaveText("Labels")
    await expect(page.getByTestId("project-workspace.label-filter-clear")).toHaveCount(0)
  })

  test("a board whose org already has label groups offers the filter at once and ANDs the groups", async ({
    page,
    env,
    qa,
  }) => {
    test.setTimeout(120_000)
    const token = qa.admin.token
    // The taxonomy and the task values exist before anyone opens the board, as a seeded or
    // long-lived org has them: two groups, values set over the task API.
    const suffix = Date.now().toString(36)
    const create = async (name: string, parentId?: string): Promise<string> => {
      const r = await api(env.serverUrl, "/api/apps/run-tool", {
        token,
        body: {
          toolName: "projects:labels.create",
          params: { name, ...(parentId ? { parentId } : {}) },
        },
      })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const id = (r.body as { data?: { id?: string } }).data?.id
      expect(id, JSON.stringify(r.body)).toBeTruthy()
      return id as string
    }
    const typeGroup = `Type ${suffix}`
    const areaGroup = `Area ${suffix}`
    const typeId = await create(typeGroup)
    await create("Bug", typeId)
    await create("Feature", typeId)
    const areaId = await create(areaGroup)
    await create("Docs", areaId)
    await create("Web", areaId)

    const seeded = await seedProjectWithTasks(env, token, {
      name: `Labelled board ${suffix}`,
      tasks: [
        { title: "Fix the broken link" },
        { title: "Write the setup guide" },
        { title: "New pricing page" },
        { title: "Unlabelled chore" },
      ],
    })
    const [broken, guide, pricing, plain] = seeded.tasks.map((t) => t.id) as [
      string,
      string,
      string,
      string,
    ]
    const label = async (taskId: string, labels: Record<string, string>) => {
      const r = await api(env.serverUrl, `/api/projects/${seeded.id}/tasks/${taskId}`, {
        method: "PATCH",
        token,
        body: { labels },
      })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    await label(broken, { [typeGroup]: "Bug", [areaGroup]: "Web" })
    await label(guide, { [typeGroup]: "Feature", [areaGroup]: "Docs" })
    await label(pricing, { [typeGroup]: "Feature", [areaGroup]: "Web" })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(url(env, `/projects/${seeded.id}?view=kanban`))
    await expectVisibleCards(page, [broken, guide, pricing, plain])
    const filter = page.getByTestId("project-workspace.label-filter")
    await expect(filter).toBeEnabled({ timeout: 15_000 })
    await expect(filter).toHaveText("Labels")

    // One group: Feature is the guide and the pricing page.
    await pickFilterValue(page, typeId, "Feature")
    await expectVisibleCards(page, [guide, pricing])
    await expect(filter).toHaveText("Labels · 1")
    // A second group ANDs: Feature and Web is the pricing page alone.
    await page.keyboard.press("Escape")
    await pickFilterValue(page, areaId, "Web")
    await expectVisibleCards(page, [pricing])
    await expect(filter).toHaveText("Labels · 2")
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 1 of 4/i)

    await page.getByTestId("project-workspace.label-filter-clear").click()
    await expectVisibleCards(page, [broken, guide, pricing, plain])
  })
})
