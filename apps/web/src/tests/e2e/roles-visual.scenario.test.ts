// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S3b Role management visual coverage + app-registry scope assertion +
// scope-escalation negative. Bridges gaps left by S3/S4/S15: per-user role list
// snapshots (add -> assigned), role detail members+dimensions snapshot,
// app-registry-sourced scope catalog visibility, and 403 on escalation.

import { randomUUID } from "node:crypto"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { assignRoleToUser, seedRolelessUser, seedRoleWithScopes } from "./helpers/seed"

test("role list/detail visuals + app-registry scopes + escalation negative", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]
  const role = `S3bRole-${randomUUID().slice(0, 6)}`
  const dimRole = `S3bDimRole-${randomUUID().slice(0, 6)}`
  const rolelessUser = await seedRolelessUser(env, world.org.id, {
    name: `S3b Roleless ${randomUUID().slice(0, 6)}`,
    email: `s3b-roleless-${randomUUID().slice(0, 8)}@e2e.test`,
  })

  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: role,
    scopes: ["tickets:tickets:read"],
  })
  const dimRoleId = await seedRoleWithScopes(env, world.org.id, {
    name: dimRole,
    scopes: [],
    dimensions: { "tickets:team": ["support-us", "support-west"] },
  })
  await assignRoleToUser(env, world.org.id, dimRoleId, qa.amina.id)

  // -- Visual: user roles list — empty state --------------------------------
  await page.goto(`http://localhost:${vitePort}/settings/admin/users/${rolelessUser.id}`)
  const rolesSection = page.getByTestId("admin-user-section-roles")
  await expect(rolesSection).toBeVisible({ timeout: 15000 })
  await expect(rolesSection).toContainText(/Roles/)
  const rolesList = page.getByTestId("admin-user-roles-list")
  await expect(rolesList).toBeVisible()
  await expect(rolesList.getByTestId(/^admin-user-unassign-/)).toHaveCount(0)
  const roleCard = page.getByTestId(`admin-user-role-card-${roleId}`)
  await expect(roleCard).toBeVisible({ timeout: 10000 })
  await expect(roleCard).toHaveAttribute("data-assigned", "false")

  // -- Add role + assert app-registry scopes appear in catalog ---------------
  const catalogResp = await api(env.serverUrl, "/api/admin/scope-catalog", {
    token: qa.admin.token,
  })
  expect(catalogResp.status).toBe(200)
  const catalog = catalogResp.body.data as Array<{ scope: string; app: string }>
  const ticketsScope = catalog.find((c) => c.scope === "tickets:tickets:read")
  expect(ticketsScope).toBeDefined()
  expect(ticketsScope?.app).toBe("tickets")

  const assignResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/admin/roles/${roleId}/users`) && r.request().method() === "POST",
  )
  await page.getByTestId(`admin-user-role-card-${roleId}`).click()
  expect((await assignResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`admin-user-unassign-${roleId}`)).toBeVisible({ timeout: 10000 })

  // -- Visual: user roles list — assigned state ------------------------------
  await expect(rolesSection).toContainText(role)
  await expect(roleCard).toHaveAttribute("data-assigned", "true")

  // -- Delete role from user -------------------------------------------------
  const unassignResp = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/roles/${roleId}/users/${rolelessUser.id}`) &&
      r.request().method() === "DELETE",
  )
  await page.getByTestId(`admin-user-role-card-${roleId}`).click()
  expect((await unassignResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`admin-user-unassign-${roleId}`)).toHaveCount(0, { timeout: 10000 })

  // -- Visual: role detail — members section only (roles are pure capabilities
  // post-redesign; dimensions are a per-user attribute and live on the user
  // page).
  await page.goto(`http://localhost:${vitePort}/settings/admin/roles/${dimRoleId}`)
  await expect(page.getByTestId("admin-role-section-members")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("admin-role-section-members")).toContainText(/Amina/i)
  // Wait for fonts + all images to settle, then pin the section's height to a
  // fixed value before capturing so sub-pixel font metrics under parallel load
  // can't flip the rendered height by 1px (576x88 vs 576x89). Pinning happens
  // in-DOM (not at the CSS layer) so it only affects this single screenshot.
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.images).map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true })
              img.addEventListener("error", () => resolve(), { once: true })
            }),
      ),
    )
  })
  // Wait for fonts/layout to fully settle — under the full Playwright sweep's
  // CPU contention the section's measured height has been observed to drift
  // (96/97/98 px) because layout sometimes completes before the custom-font
  // glyph metrics stabilize. `document.fonts.ready` is the browser-blessed
  // signal for that.
  await page.evaluate(() => document.fonts?.ready)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="admin-role-section-members"]') as HTMLElement
    if (el) {
      // Pin to a fixed bounding rect with all sizing levers locked. The
      // section is captured by Playwright's element screenshot which reads
      // `getBoundingClientRect()` — locking width + min/max + box-sizing
      // makes the rect deterministic across solo/sweep runs.
      el.style.boxSizing = "border-box"
      el.style.width = "576px"
      el.style.minWidth = "576px"
      el.style.maxWidth = "576px"
      el.style.height = "97px"
      el.style.minHeight = "97px"
      el.style.maxHeight = "97px"
      el.style.overflow = "hidden"
      // Force the element onto the pixel grid by giving it its own stacking
      // context — without this Chrome can place it at a sub-pixel y-offset
      // (e.g. 200.4), so the rounded bounding rect grows by 1 px and the
      // screenshot capture drifts 97→98 under sweep CPU contention.
      el.style.transform = "translate3d(0, 0, 0)"
      void el.offsetHeight // force a paint flush
    }
  })
  await page.waitForTimeout(300)
  // Scroll the element into the top-left of the viewport so subsequent
  // clip math is deterministic — the test's viewport is 1440×900, the
  // element is 576×97. Sweep runs sometimes leave the section partway off
  // the visible region, which made `page.toHaveScreenshot({clip})` error
  // with "Clipped area is either empty or outside the resulting image".
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="admin-role-section-members"]') as HTMLElement
    el?.scrollIntoView({ block: "start", inline: "start" })
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(200)
  // Compute pixel-aligned clip from the locked element. Element-relative
  // screenshots inherit Chrome's sub-pixel rounding even with explicit size
  // — a page-level screenshot with a pixel-floored clip rect is the only
  // way to guarantee identical dimensions on every capture.
  const clip = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="admin-role-section-members"]') as HTMLElement
    const r = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.floor(r.left)),
      y: Math.max(0, Math.floor(r.top)),
      width: 576,
      height: 97,
    }
  })
  await expect(page).toHaveScreenshot("phase9-admin-role-members.png", {
    clip,
    maxDiffPixelRatio: 0.03,
    animations: "disabled",
  })

  // -- Scope-escalation negative ---------------------------------------------
  const godRoleId = await seedRoleWithScopes(env, world.org.id, {
    name: `S3bGod-${randomUUID().slice(0, 6)}`,
    scopes: ["kernel"],
  })
  const lowAdminEmail = `s3b-low-admin-${randomUUID().slice(0, 8)}@e2e.test`
  const lowAdminPassword = "QaPass1!"
  await createUserWithScopes(env.serverUrl, env.db.sql, qa.admin.token, world.org.id, {
    email: lowAdminEmail,
    password: lowAdminPassword,
    name: "S3b Low Admin",
    scopes: ["kernel:users:admin"],
    schemaPrefix: env.schemaPrefix,
  })
  await loginAs(page, env, lowAdminEmail, lowAdminPassword)
  await page.goto(`http://localhost:${vitePort}/settings/admin/users/${qa.amina.id}`)
  await expect(page.getByTestId("admin-user-section-roles")).toBeVisible({ timeout: 15000 })
  const escResp = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/roles/${godRoleId}/users`) && r.request().method() === "POST",
  )
  await page.getByTestId(`admin-user-role-card-${godRoleId}`).click()
  const escFinal = await escResp
  expect(escFinal.status()).toBe(403)
  await expect(page.getByTestId("admin-user-assign-error")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("admin-user-assign-error")).toContainText(
    /can't assign|escalat|permission/i,
  )
})
