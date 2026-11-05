// SPDX-License-Identifier: FSL-1.1-ALv2
// Scenario 09: Scope requests — an admin sees a member's pending scope request
// in the dedicated inbox and approves it in-browser; the grant is then verified
// through the API (so a UI-only optimistic update can't produce a false green).
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

test.describe("Flow: Admin approves a scope request in-browser", () => {
  test("pending request is visible, approvable, and the grant lands", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // A limited member with no contacts:write — created via the real API.
    const limited = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      qa.admin.token,
      world.org.id,
      {
        scopes: ["kernel:threads:read"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      },
    )

    // The member files a scope request via the real API.
    const reqRes = await api(env.serverUrl, "/api/scope-requests", {
      method: "POST",
      token: limited.token,
      body: { scopes: ["kernel:contacts:write"], reason: "Need to edit contacts" },
    })
    expect(reqRes.status).toBe(201)
    const reqId = reqRes.body.data.id as string

    // Log in as the QA admin (admin holds '*' ⊇ kernel:scope_requests:admin).
    await loginAs(page, env, "admin@test.com", "12345678")
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/settings/admin/scope-requests`)

    const row = page.getByTestId(`scope-request-${reqId}`)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText("kernel:contacts:write")
    await expect(row).toContainText(limited.name)

    // Approve, and confirm the row reflects the decision.
    await row.getByRole("button", { name: /approve/i }).click()
    await expect(row).toContainText(/approved/i, { timeout: 10000 })

    // The grant actually landed — assert via the API, not just the UI.
    const after = await api(env.serverUrl, "/api/scope-requests?status=pending", {
      token: qa.admin.token,
    })
    expect(after.body.data.find((r: { id: string }) => r.id === reqId)).toBeUndefined()
  })
})
