// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S11 Projects bulk setStatus via the toolbar.
// (e2e-plan §S11, spec §1.3 criteria 15, 17, §3.3 projects bulk actions.)
//
// Drives the real BulkActionToolbar mounted on the project workspace:
//   1. Seed a project with three statuses + three tasks (all in "Todo")
//   2. Open /projects/<id>; assert the task rows render via the existing
//      `project-list-view.select-${taskId}` checkbox affordance
//   3. Select all three rows; assert the bulk toolbar reports 3 selected
//   4. Click `bulk-action-setStatus`, fill `bulk-field-statusId` with the
//      target status, submit
//   5. Cross-check the DB: each task's status_id is the target status
//
// Note: the plan calls for `projects-task-checkbox-${id}` test IDs; the
// projects module currently uses the equivalent
// `project-list-view.select-${id}` IDs. Both expose the same row-level
// selection contract — the test uses the actual ID until a future cleanup
// renames them.

import { randomUUID } from "node:crypto"
import { login } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

test("projects bulk setStatus updates each selected task via the toolbar", async ({
  page,
  env,
  qa,
  world,
}) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  // permission_version bumped — reissue the token for the seed POSTs.
  const fresh = await login(env.serverUrl, qa.admin.email, "12345678")
  const token = fresh.accessToken

  const prefix = `s11-${randomUUID().slice(0, 6)}`
  const project = await seedProjectWithTasks(env, token, {
    name: `S11 project ${prefix}`,
    tasks: [
      { title: `${prefix} task A` },
      { title: `${prefix} task B` },
      { title: `${prefix} task C` },
    ],
  })
  // Pick a target status that's different from the seeded default (the first
  // status the project is created with).
  const targetStatus = project.statuses.find((s) => s.label !== "Todo") ?? project.statuses[1]!
  expect(targetStatus).toBeTruthy()

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/projects/${project.id}`)

  // Wait for the task rows to render.
  for (const t of project.tasks) {
    await expect(page.getByTestId(`project-list-view.select-${t.id}`)).toBeVisible({
      timeout: 20000,
    })
  }
  for (const t of project.tasks) {
    await page.getByTestId(`project-list-view.select-${t.id}`).check()
  }

  await expect(page.getByTestId("bulk-toolbar")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("bulk-selection-count")).toHaveText("3 selected")

  await page.getByTestId("bulk-action-setStatus").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await page.getByTestId("bulk-field-statusId").fill(targetStatus.id)

  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/projects/bulk/setStatus") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  const resp = await dispatchResp
  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as {
    data: { total: number; succeeded: number; failed: number }
  }
  expect(body.data.total).toBe(3)
  expect(body.data.failed).toBe(0)

  // DB cross-check: every task's status_id is now the target.
  const ps = env.schemaPrefix ? `"${env.schemaPrefix}app_projects"` : "app_projects"
  for (const t of project.tasks) {
    const rows = (await env.db.sql.unsafe(
      `SELECT status_id AS "statusId" FROM ${ps}.tasks WHERE id = $1`,
      [t.id],
    )) as Array<{ statusId: string }>
    expect(rows[0]?.statusId).toBe(targetStatus.id)
  }
})
