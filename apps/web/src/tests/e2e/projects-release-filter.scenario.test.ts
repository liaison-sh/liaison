// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.release-filter — the board's release filter (spec S22) and the
// projects charter's release filter parity rule:
//   - a task without its own release matches its nearest ancestor's release
//     (parent 2.1.0, child none, grandchild 2.2.0: 2.1.0 = parent + child)
//   - the count beside a release value equals the rows visible with it alone
//   - the filtered list states its own arithmetic ("Showing N of M")
//   - "No release" selects tasks with no effective release
//   - a saved view keeps the release filter (capture and apply)
//
// The toolbar chip test drives the "Release" chip the spec puts in the board
// toolbar. The saved-view test reaches the same filter state through a saved
// view, so inheritance and parity are proven independently of the chip.
import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { clearAllProjects, grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

interface ReleaseTree {
  projectId: string
  parentId: string
  childId: string
  grandchildId: string
  looseId: string
}

async function createTask(
  env: WorkerEnv,
  token: string,
  projectId: string,
  body: { title: string; parentTaskId?: string; release?: string },
): Promise<string> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks`, { token, body })
  if (r.status !== 200) throw new Error(`task create failed ${r.status}: ${JSON.stringify(r.body)}`)
  return (r.body.data as { id: string }).id
}

/** Parent 2.1.0 > child (no release) > grandchild 2.2.0, plus a loose root task. */
async function seedReleaseTree(env: WorkerEnv, token: string): Promise<ReleaseTree> {
  const seeded = await seedProjectWithTasks(env, token, { name: "Release Filter" })
  const parentId = await createTask(env, token, seeded.id, {
    title: "Firmware 2.1 rollout",
    release: "2.1.0",
  })
  const childId = await createTask(env, token, seeded.id, {
    title: "Pedal input rework",
    parentTaskId: parentId,
  })
  const grandchildId = await createTask(env, token, seeded.id, {
    title: "Expression curve editor",
    parentTaskId: childId,
    release: "2.2.0",
  })
  const looseId = await createTask(env, token, seeded.id, { title: "Clean up old logs" })
  return { projectId: seeded.id, parentId, childId, grandchildId, looseId }
}

async function visibleRowIds(page: Page): Promise<string[]> {
  return page
    .getByTestId("project-list-view.row")
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.taskId ?? "").filter((id) => id.length > 0),
    )
}

async function expectRows(page: Page, ids: string[]) {
  await expect
    .poll(async () => (await visibleRowIds(page)).sort(), { timeout: 10_000 })
    .toEqual([...ids].sort())
}

test.describe("projects release filter", () => {
  test.beforeEach(async ({ env, qa }) => {
    // Release counts are org-wide: start from an empty projects table so the
    // counts compare against this project's rows only.
    await clearAllProjects(env, qa.admin.token)
  })

  test("toolbar Release chip: values with counts, inheritance, parity, No release", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const tree = await seedReleaseTree(env, qa.admin.token)

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${tree.projectId}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })
    await expectRows(page, [tree.parentId, tree.childId, tree.grandchildId, tree.looseId])

    const chip = page.getByTestId("project-workspace.release-filter")
    await expect(chip, "S22: the board toolbar has a Release chip").toBeVisible({
      timeout: 5_000,
    })
    await chip.click()
    const options = page.getByTestId("release-filter.option")
    await expect(options.filter({ hasText: "2.1.0" })).toContainText("2")
    await expect(options.filter({ hasText: "2.2.0" })).toContainText("1")
    await expect(options.filter({ hasText: "No release" })).toBeVisible()

    // 2.1.0: the parent and the child that inherits it, not the grandchild.
    await options.filter({ hasText: "2.1.0" }).click()
    await expectRows(page, [tree.parentId, tree.childId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 2 of 4/i)

    // No release: only the loose root task.
    await chip.click()
    await options.filter({ hasText: "No release" }).click()
    await expectRows(page, [tree.looseId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 1 of 4/i)
  })

  test("saved view keeps the release filter: apply, inherit, count parity, capture", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const tree = await seedReleaseTree(env, qa.admin.token)

    // The releases endpoint the chip menu reads: effective counts.
    const rel = await api(env.serverUrl, "/api/projects/releases", { token: qa.admin.token })
    expect(rel.status).toBe(200)
    const counts = Object.fromEntries(
      (rel.body.data as Array<{ value: string; count: number }>).map((r) => [r.value, r.count]),
    )
    expect(counts).toEqual({ "2.1.0": 2, "2.2.0": 1 })

    const makeView = async (name: string, release: string) => {
      const r = await api(env.serverUrl, "/api/saved-views", {
        token: qa.admin.token,
        body: { app: "projects", viewId: "project", name, payload: { release } },
      })
      expect([200, 201]).toContain(r.status)
      return (r.body.data ?? r.body).id as string
    }
    const v210 = await makeView("Release 2.1.0", "2.1.0")
    const vNone = await makeView("Without release", "__none__")

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${tree.projectId}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })
    await expectRows(page, [tree.parentId, tree.childId, tree.grandchildId, tree.looseId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveCount(0)

    // Apply 2.1.0: parent + inheriting child; count parity with /releases.
    await page.getByTestId(`saved-view-${v210}`).getByRole("button").first().click()
    await expectRows(page, [tree.parentId, tree.childId])
    expect((await visibleRowIds(page)).length).toBe(counts["2.1.0"])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 2 of 4/i)

    // Capture: a view saved now carries the release filter.
    await page.getByTestId("saved-view-create").click()
    await page.getByTestId("saved-view-dialog-name").fill("Captured 2.1.0")
    await page.getByTestId("saved-view-dialog-submit").click()
    await expect
      .poll(
        async () => {
          const r = await api(env.serverUrl, "/api/saved-views?app=projects&viewId=project", {
            token: qa.admin.token,
          })
          const views = (r.body.data ?? []) as Array<{
            name: string
            payload: { release?: unknown }
          }>
          return views.find((v) => v.name === "Captured 2.1.0")?.payload?.release
        },
        { timeout: 5_000 },
      )
      .toBe("2.1.0")

    // No release: the loose task only.
    await page.getByTestId(`saved-view-${vNone}`).getByRole("button").first().click()
    await expectRows(page, [tree.looseId])
    await expect(page.getByTestId("project-workspace.showing-count")).toHaveText(/Showing 1 of 4/i)
  })
})
