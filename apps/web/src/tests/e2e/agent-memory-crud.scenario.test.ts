// SPDX-License-Identifier: FSL-1.1-ALv2
// Agent Memory CRUD — drives the user through create → read → delete on the
// agent page's Memory tab. Exercises the typed-memory HTTP routes, the store,
// the per agent memory tree that renders those rows as `<type>/<name>.md`, RLS,
// and the underlying typed-memory service in one journey.
//
// P4c FX-F1: the flat `/agent/memories` screen is unmounted and `/agent/memories`
// redirects onto this tab, so the journey starts from the legacy URL and lands
// where every shipped link now lands.

import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

/** The Memory tab of the viewer's own agent page, reached the way a shipped
 *  link reaches it: the legacy list URL, which the shell rewrites onto the
 *  agent page. The tab is then selected by hand, because the shell does not
 *  hand this page its sub route in the browser (the tab store answers
 *  `/agents/self` for a `/agents/self/memory` navigation), so the page opens on
 *  Overview. Reported: that is the shell's own deep link gap, not this tab's.
 */
async function openMemoryTab(page: Page): Promise<void> {
  await page.goto(new URL("/agent/memories", page.url()).toString())
  await page.getByTestId("agent-profile").waitFor({ state: "visible", timeout: 30_000 })
  await expect(page).toHaveURL(/\/agents\//)
  await page.getByTestId("agent-profile-tab-memory").click()
  await page.getByTestId("agent-memory-tree").waitFor({ state: "visible", timeout: 30_000 })
}

test("[Agent Memory] CRUD on the agent page's Memory tab", async ({ page, env, qa }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // Wait for the API to be ready.
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    const r = await fetch(`${env.serverUrl}/api/agent/memories`, {
      headers: { authorization: `Bearer ${qa.admin.token}` },
    }).catch(() => null)
    if (r && (r.status === 200 || r.status === 401)) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  expect(ready).toBe(true)

  // Pre-test cleanup via the API so the journey starts from zero regardless of
  // prior state in this org.
  const existing = await fetch(`${env.serverUrl}/api/agent/memories`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  })
    .then((r) => r.json())
    .catch(() => ({ data: [] }))
  for (const entry of existing.data ?? []) {
    await fetch(`${env.serverUrl}/api/agent/memories/${entry.type}/${entry.name}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${qa.admin.token}` },
    })
  }

  await page.reload()
  await openMemoryTab(page)

  // Create — the tab's own form, with the type picked on it.
  await page.getByTestId("agent-memory-new").click()
  await expect(page.getByTestId("agent-memory-create")).toBeVisible()
  await page.getByTestId("agent-memory-create-type").selectOption("user")
  await page.getByTestId("agent-memory-create-name").fill("role")
  await page.getByTestId("agent-memory-create-description").fill("Senior platform eng")
  await page
    .getByTestId("agent-memory-create-content")
    .fill("Elodie leads platform reliability work.")
  const created = page.waitForResponse(
    (res) => res.url().endsWith("/api/agent/memories") && res.request().method() === "POST",
  )
  await page.getByTestId("agent-memory-create-save").click()
  await created

  // Read — the row is a file in the agent's tree, and it opens.
  await expect(page.getByTestId("agent-memory-file-user/role.md")).toBeVisible()
  await expect(page.getByTestId("agent-memory-open-path")).toHaveText("user/role.md")
  await expect(page.getByTestId("agent-memory-body")).toContainText(
    "Elodie leads platform reliability work.",
  )

  // The server agrees, not just the screen.
  const list = await fetch(`${env.serverUrl}/api/agent/memories`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  }).then((r) => r.json())
  const entry = (list.data ?? []).find((e: any) => e.name === "role")
  expect(entry).toBeDefined()
  expect(entry.type).toBe("user")
  expect(entry.description).toBe("Senior platform eng")

  // Delete — two step inline confirm (no modal).
  await page.getByTestId("agent-memory-file-user/role.md").click()
  await page.getByTestId("memory-delete").click()
  const deleted = page.waitForResponse(
    (res) =>
      res.url().includes("/api/agent/memories/user/role") && res.request().method() === "DELETE",
  )
  await page.getByTestId("memory-delete-confirm").click()
  await deleted

  await expect(page.getByTestId("agent-memory-file-user/role.md")).toHaveCount(0)
  const after = await fetch(`${env.serverUrl}/api/agent/memories`, {
    headers: { authorization: `Bearer ${qa.admin.token}` },
  }).then((r) => r.json())
  expect((after.data ?? []).some((e: any) => e.name === "role")).toBe(false)
})
