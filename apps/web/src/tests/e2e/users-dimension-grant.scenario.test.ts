// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S5 Admin grants/revokes per-user dimension values via the UI.
// (e2e-plan §S5, spec §1.1 criterion 5, §3.1 user detail dimensions.)
//
// Drives the redesigned AdminUserDetail "Access" section. Each declared
// dimension is a checkbox grid scoped to its manifest-declared values; ticking
// adds the value to the user's direct grant, unticking the last value
// removes the grant entirely. There is no free-text input.

import { expect, test } from "./fixtures/test"

test("admin grants and revokes a user dimension value via the UI", async ({
  authenticatedPage,
  env,
  qa,
}) => {
  const page = authenticatedPage
  // tickets:team declares "support-us" as a catalog value — manifest-driven,
  // not free text. Elodie's admin role holds wildcard scope so the actor
  // escalation check passes through.
  const dimensionKey = "tickets:team"
  const valueToToggle = "support-us"

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/users/${qa.amina.id}`)
  await expect(page.getByTestId("admin-user-section-dimensions")).toBeVisible({ timeout: 15000 })

  // ── Tick the value — POSTs the new direct-grant set ───────────────────
  const valueChip = page.getByTestId(`admin-user-dimension-value-${dimensionKey}-${valueToToggle}`)
  await expect(valueChip).toBeVisible({ timeout: 10000 })
  await expect(valueChip).toHaveAttribute("data-granted", "false")

  const grantResp = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/roles/users/${qa.amina.id}/dimensions`) &&
      r.request().method() === "POST",
  )
  await valueChip.click()
  expect((await grantResp).status()).toBeLessThan(400)
  await expect(valueChip).toHaveAttribute("data-granted", "true", { timeout: 10000 })

  // DB cross-check: row exists with the granted value.
  const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
  const rows = (await env.db.sql.unsafe(
    `SELECT dimension_values FROM ${ks}.user_dimension_grants
       WHERE user_id = $1 AND dimension_key = $2`,
    [qa.amina.id, dimensionKey],
  )) as Array<{ dimension_values: unknown }>
  expect(rows.length).toBe(1)

  // ── Untick the value — DELETEs the dimension grant (no values left) ───
  const revokeResp = page.waitForResponse(
    (r) =>
      r
        .url()
        .endsWith(
          `/api/admin/roles/users/${qa.amina.id}/dimensions/${encodeURIComponent(dimensionKey)}`,
        ) && r.request().method() === "DELETE",
  )
  await valueChip.click()
  expect((await revokeResp).status()).toBeLessThan(400)
  await expect(valueChip).toHaveAttribute("data-granted", "false", { timeout: 10000 })

  const after = (await env.db.sql.unsafe(
    `SELECT id FROM ${ks}.user_dimension_grants WHERE user_id = $1 AND dimension_key = $2`,
    [qa.amina.id, dimensionKey],
  )) as Array<{ id: string }>
  expect(after.length).toBe(0)
})
