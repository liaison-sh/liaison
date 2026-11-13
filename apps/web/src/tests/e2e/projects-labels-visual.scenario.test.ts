// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.labels visual — the task page meta row with two label chips, light
// theme (spec section 10): the subtask's own value (Nature: evolution,
// overriding its parent's bug) in the normal style and the value it inherits
// (Domain: security) muted and italic, after Release and before Blocked.
// DOM assertions run first, so a wrong baseline cannot pass on its own.
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { PIXEL_BASELINES } from "./helpers/pixel-baselines"
import {
  clearAllLabels,
  clearAllProjects,
  grantProjectScopes,
  seedProjectWithTasks,
} from "./helpers/projects-seed"

const SHOT = { maxDiffPixelRatio: 0.02 } as const

// The admin's theme preference is `system` after the lane reset: a light OS
// scheme resolves it to light.
test.use({ colorScheme: "light" })

function url(env: WorkerEnv, path: string): string {
  return `http://localhost:${env.ports[1]}${path}`
}

/**
 * Create a label group (no parentId) or value through the production tool
 * route. A typed tool refusal can come back as HTTP 200 with `data.error`, so
 * anything but a created row with an id throws.
 */
async function createLabel(
  env: WorkerEnv,
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const r = await api(env.serverUrl, "/api/apps/run-tool", {
    token,
    body: {
      toolName: "projects:labels.create",
      params: { name, ...(parentId ? { parentId } : {}) },
    },
  })
  const data = (r.body as { data?: { id?: unknown; error?: unknown } }).data
  if (r.status !== 200 || !data || data.error !== undefined || typeof data.id !== "string") {
    throw new Error(`labels.create "${name}" failed ${r.status}: ${JSON.stringify(r.body)}`)
  }
  return data.id
}

async function patchLabels(
  env: WorkerEnv,
  token: string,
  projectId: string,
  taskId: string,
  labels: Record<string, string>,
): Promise<void> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    token,
    body: { labels },
  })
  if (r.status !== 200) throw new Error(`label patch failed ${r.status}: ${JSON.stringify(r.body)}`)
}

test.describe("projects task labels visual", () => {
  test.beforeEach(async ({ env, world, qa }) => {
    await clearAllProjects(env, qa.admin.token)
    await clearAllLabels(env, qa.admin.token)
    // Parity with the precedent specs; the admin already holds `*`.
    await grantProjectScopes(env, world.org.id, qa.admin.id)
  })

  test("task meta row shows an own and an inherited label chip (light)", async ({
    page,
    env,
    qa,
  }) => {
    const token = qa.admin.token
    // Groups in this order, so the chips' order is deterministic.
    const natureId = await createLabel(env, token, "Nature")
    await createLabel(env, token, "bug", natureId)
    await createLabel(env, token, "evolution", natureId)
    const domainId = await createLabel(env, token, "Domain")
    await createLabel(env, token, "enrichment", domainId)
    await createLabel(env, token, "security", domainId)

    const seeded = await seedProjectWithTasks(env, token, {
      name: `Labels Visual ${Date.now()}`,
      tasks: [{ title: "Fix login crash" }],
    })
    const parentId = seeded.tasks[0]!.id
    const child = await api(env.serverUrl, `/api/projects/${seeded.id}/tasks`, {
      token,
      body: { title: "Reproduce on staging", parentTaskId: parentId },
    })
    if (child.status !== 200) {
      throw new Error(`subtask create failed ${child.status}: ${JSON.stringify(child.body)}`)
    }
    const childId = (child.body.data as { id: string }).id
    await patchLabels(env, token, seeded.id, parentId, { Nature: "bug", Domain: "security" })
    await patchLabels(env, token, seeded.id, childId, { Nature: "evolution" })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(url(env, `/projects/tasks/${childId}`))
    const meta = page
      .locator(`[data-testid="task-detail"][data-task-id="${childId}"]`)
      .getByTestId("task-detail.meta-row")
    await expect(meta).toBeVisible({ timeout: 15_000 })
    // The picker triggers exist only once the catalog loaded: the captured
    // render is the catalog-driven one, not the payload-only fallback.
    await expect(meta.getByRole("button", { name: "Set Nature" })).toBeVisible({
      timeout: 15_000,
    })
    await expect(meta.getByRole("button", { name: "Set Domain" })).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    await expect(meta.locator('[data-testid^="task-detail.label-"]')).toHaveCount(2)
    const natureChip = meta.getByTestId(`task-detail.label-${natureId}`)
    const domainChip = meta.getByTestId(`task-detail.label-${domainId}`)
    await expect(natureChip).toHaveText("Nature: evolution")
    await expect(natureChip).toHaveAttribute("data-inherited", "false")
    await expect(domainChip).toHaveText("Domain: security")
    await expect(domainChip).toHaveAttribute("data-inherited", "true")
    await expect(domainChip).toHaveCSS("font-style", "italic")
    await expect(natureChip).toHaveCSS("font-style", "normal")

    const box = await meta.boundingBox()
    expect(box, "meta row has a layout box").not.toBeNull()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440)
    expect(box!.y + box!.height).toBeLessThanOrEqual(900)

    await page.mouse.move(0, 0)
    await page.evaluate(() => document.fonts?.ready)
    if (PIXEL_BASELINES) {
      await expect(meta).toHaveScreenshot("task-meta-labels-light.png", {
        ...SHOT,
        // The time in status ("for 1 min") grows with the run.
        mask: [meta.getByTestId("task-detail.status-since")],
      })
    }
  })
})
