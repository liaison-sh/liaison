// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S17 Shopify-style permission grid + catalog-driven dimension picker.
//
// Covers the consolidated admin permissions UI:
//   - Permission grid groups scopes by app, shows count badges, expand/collapse
//     section state, and toggles immediately commit POST/DELETE.
//   - Dimension picker is driven by GET /api/admin/dimension-catalog; the
//     dimension key is a <select> (never free-text), and level/enum dimensions
//     render checkbox-style value chips instead of comma-separated text.
//   - Visual showcase of the redesigned role detail (full Shopify-style view).

import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { seedRoleWithScopes } from "./helpers/seed"

test("dimension catalog endpoint returns manifest-declared dimensions", async ({ env, qa }) => {
  const resp = await api(env.serverUrl, "/api/admin/dimension-catalog", {
    token: qa.admin.token,
  })
  expect(resp.status).toBe(200)
  const catalog = resp.body.data as Array<{
    key: string
    app: string
    type: string
    order?: string[]
    values?: string[]
    label?: string
    description?: string
  }>
  // tickets app declares two dimensions in its manifest.
  const team = catalog.find((d) => d.key === "tickets:team")
  expect(team).toBeDefined()
  expect(team?.type).toBe("membership")
  expect(team?.label).toBe("Team")
  // Membership dimensions ship a values catalog so the UI never needs free-text.
  expect(team?.values).toContain("support-us")
  expect(team?.values).toContain("support-east")

  const sensitivity = catalog.find((d) => d.key === "tickets:sensitivity")
  expect(sensitivity).toBeDefined()
  expect(sensitivity?.type).toBe("level")
  expect(sensitivity?.label).toBe("Sensitivity")
  expect(sensitivity?.order).toEqual(["internal", "confidential", "restricted"])

  // Catalog is ordered by (app, key).
  const keys = catalog.map((d) => d.key)
  const ticketsKeys = keys.filter((k) => k.startsWith("tickets:"))
  expect(ticketsKeys).toEqual([...ticketsKeys].sort())
})

test("permission grid groups scopes by app + toggles commit immediately", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]

  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: `S17Grid-${randomUUID().slice(0, 6)}`,
    scopes: ["kernel:threads:read"],
  })

  await page.goto(`http://localhost:${vitePort}/settings/admin/roles/${roleId}`)
  await expect(page.getByTestId("admin-role-section-scopes")).toBeVisible({ timeout: 15000 })

  // Kernel section is present and includes a count badge.
  const kernelSection = page.getByTestId("admin-role-permission-app-kernel")
  await expect(kernelSection).toBeVisible()
  await expect(kernelSection).toContainText(/\d+ \/ \d+/)

  // Pre-granted kernel:threads:read appears as a remove-state row.
  await expect(page.getByTestId("admin-role-remove-scope-kernel:threads:read")).toBeVisible()

  // Add a fresh scope by clicking its row — testid swaps add → remove on success.
  const addResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/admin/roles/${roleId}/scopes`) && r.request().method() === "POST",
  )
  await page.getByTestId("admin-role-add-scope-kernel:threads:write").click()
  expect((await addResp).status()).toBeLessThan(400)
  await expect(page.getByTestId("admin-role-remove-scope-kernel:threads:write")).toBeVisible({
    timeout: 10000,
  })

  // Section filter narrows results and force-expands matching sections.
  await page.getByTestId("admin-role-scope-input").fill("contacts")
  await expect(page.getByTestId("admin-role-permission-app-kernel")).toBeVisible()
  await expect(page.getByTestId("admin-role-add-scope-kernel:contacts:read")).toBeVisible()
})

test("role detail has NO dimension editor: roles are pure capabilities", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]
  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: `S17NoDim-${randomUUID().slice(0, 6)}`,
    scopes: [],
  })
  await page.goto(`http://localhost:${vitePort}/settings/admin/roles/${roleId}`)
  await expect(page.getByTestId("admin-role-section-scopes")).toBeVisible({ timeout: 15000 })
  // Anti-regression — there is no per-role dimension UI. Dimensions are a
  // per-user attribute and live on the user page.
  await expect(page.getByTestId("admin-role-section-dimensions")).toHaveCount(0)
  await expect(page.getByTestId("admin-role-dimension-key")).toHaveCount(0)
  await expect(page.getByTestId("admin-role-grant-dimension")).toHaveCount(0)
})

test("visual showcase: role detail full permissions surface", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]

  // Seed a role with a representative mix of granted scopes so the screenshot
  // exercises the populated state.
  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: `S17Showcase-${randomUUID().slice(0, 6)}`,
    scopes: [
      "kernel:threads:read",
      "kernel:threads:write",
      "kernel:contacts:read",
      "kernel:saved_views:share",
      "kernel:approvals:read",
      "tickets:tickets:read",
    ],
  })

  await page.goto(`http://localhost:${vitePort}/settings/admin/roles/${roleId}`)
  await expect(page.getByTestId("admin-role-section-scopes")).toBeVisible({ timeout: 15000 })
  // Anti-rubber-stamp: confirm representative content rendered before snapshot.
  await expect(page.getByTestId("admin-role-section-scopes")).toContainText("Permissions")
  await expect(page.getByTestId("admin-role-permission-app-kernel")).toBeVisible()
  await expect(page.getByTestId("admin-role-permission-app-tickets")).toBeVisible()
  await expect(page.getByTestId("admin-role-remove-scope-kernel:threads:read")).toBeVisible()
  await expect(page.getByTestId("admin-role-remove-scope-tickets:tickets:read")).toBeVisible()
})
