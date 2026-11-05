// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 11 smoke: Knowledge workspace boots, default route is home, sidebar
// selection is wired. Gates S1–S5 — if smoke fails, none of the journey
// scenarios will be reliable.

import { expect, loginAs, test } from "./fixtures/test"

test("knowledge-workspace-loads", async ({ page, env, qa }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // Wait for the Knowledge API routes to be mounted on the spawned API.
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    const r = await fetch(`${env.serverUrl}/api/knowledge/home`, {
      headers: { authorization: `Bearer ${qa.admin.token}` },
    }).catch(() => null)
    if (r && (r.status === 200 || r.status === 401)) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  expect(ready).toBe(true)

  // Open Knowledge from the activity bar.
  await page.getByTestId("activity-knowledge").click()

  // Default route should be /knowledge and the workspace+home view should mount.
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByTestId("knowledge-workspace")).toBeVisible()
  await expect(page.getByTestId("knowledge-home")).toBeVisible()

  // Sidebar splits collections into Personal vs Shared (commit 9ba1bfc). The
  // Personal section is always rendered; Shared appears once any shared
  // collection exists. The deprecated `knowledge-nav-source-settings` surface
  // is gone — connector auth lives in AdminIntegrations (settings).
  await expect(page.getByTestId("knowledge-sidebar-section-personal")).toBeVisible()
  await expect(page.getByTestId("knowledge-nav-source-settings")).toHaveCount(0)

  // Mock-Drive server is reachable on its allocated port (sanity check that
  // the env fixture wired the third deterministic port through correctly).
  const mockDrive = env.mockDrive
  test.skip(!mockDrive, "mock Drive server did not start in this worker")
  if (!mockDrive) return
  const driveProbe = await fetch(`${mockDrive.url}/drive/v3/files`).catch(() => null)
  expect(driveProbe?.status).toBe(401) // bearer missing → 401, server is up
})
