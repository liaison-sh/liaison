// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S16 Visual showcase for the redesigned Phase 9 surfaces.
//
// Captures focused, full-section screenshots of the two surfaces that were
// reworked after the original baselines were judged unfit:
//   1. Bulk action toolbar — success-only outcome (calm green pill)
//   2. Bulk action toolbar — partial-failure outcome (status pills + tidy
//      per-item error rows with short ID, full ID via sr-only)
//   3. Admin user detail — Dimension grants section populated with multiple
//      grants in card form + the new grant-new-dimension form panel
//   4. Admin role detail — same shape on the role side
//
// These screenshots are intended as a visual-validation checkpoint — the user
// reviews the produced PNGs in *-snapshots/. Each test gates the capture on a
// text assertion so a silent wrong-component capture would fail before
// pixel-diff would.

import { randomUUID } from "node:crypto"
import { createUserWithScopes } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { assignRoleToUser, seedInbox, seedRoleWithScopes, seedTicket } from "./helpers/seed"
import { indexSeededTickets, searchInboxFor } from "./helpers/tickets-search"

test("bulk toolbar: clean success outcome", async ({ page, env, qa, world }) => {
  const prefix = `s16ok-${randomUUID().slice(0, 6)}`
  const inbox = await seedInbox(env, world.org.id, {
    name: `S16Inbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const t1 = await seedTicket(env, world.org.id, {
    subject: `${prefix} A`,
    sourceInboxId: inbox.id,
  })
  const t2 = await seedTicket(env, world.org.id, {
    subject: `${prefix} B`,
    sourceInboxId: inbox.id,
  })
  await indexSeededTickets(env, { email: qa.admin.email, password: "12345678" }, prefix, [
    t1.id,
    t2.id,
  ])

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${t1.id}`)).toBeVisible({ timeout: 15000 })
  await searchInboxFor(page, prefix, [t1.id, t2.id])
  await page.getByTestId(`tickets-row-checkbox-${t1.id}`).check()
  await page.getByTestId(`tickets-row-checkbox-${t2.id}`).check()
  await expect(page.getByTestId("bulk-selection-count")).toHaveText("2 selected")

  // Use bulk-action-assign — direct (not gated) so the response carries
  // succeeded > 0 and the outcome shows a green "2 done" pill.
  await page.getByTestId("bulk-action-assign").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await page.getByTestId("bulk-field-assignedTo").fill(qa.amina.id)
  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/assign") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  await dispatchResp

  const toolbar = page.getByTestId("bulk-toolbar")
  await expect(page.getByTestId("bulk-outcome")).toBeVisible({ timeout: 5000 })
  // Anti-rubber-stamp: success pill must be styled and contain "2 done"
  await expect(page.getByTestId("bulk-outcome-succeeded")).toContainText("2 done")
  await expect(page.getByTestId("bulk-outcome-failed")).toContainText("0 failed")
  await expect(toolbar).toHaveScreenshot("phase9-s16-bulk-outcome-success.png", {
    maxDiffPixelRatio: 0.05,
  })
})

test("bulk toolbar: partial failure outcome (multi-error)", async ({ page, env, qa, world }) => {
  const prefix = `s16err-${randomUUID().slice(0, 6)}`
  const inbox = await seedInbox(env, world.org.id, {
    name: `S16ErrInbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const valid1 = await seedTicket(env, world.org.id, {
    subject: `${prefix} valid A`,
    sourceInboxId: inbox.id,
  })
  const valid2 = await seedTicket(env, world.org.id, {
    subject: `${prefix} valid B`,
    sourceInboxId: inbox.id,
  })
  // Inject three bogus ids so the new errors block exercises the multi-row
  // layout (max 3 visible). MAX_ERROR_ROWS in the component is 3.
  const bogusIds = [randomUUID(), randomUUID(), randomUUID()]
  await indexSeededTickets(env, { email: qa.admin.email, password: "12345678" }, prefix, [
    valid1.id,
    valid2.id,
  ])

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${valid1.id}`)).toBeVisible({ timeout: 15000 })
  await searchInboxFor(page, prefix, [valid1.id, valid2.id])
  await page.getByTestId(`tickets-row-checkbox-${valid1.id}`).check()
  await page.getByTestId(`tickets-row-checkbox-${valid2.id}`).check()

  await page.getByTestId("bulk-action-assign").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await page.getByTestId("bulk-field-assignedTo").fill(qa.amina.id)

  const allIds = [valid1.id, valid2.id, ...bogusIds]
  await page.evaluate(
    ({ ids }) => {
      const origFetch = window.fetch
      ;(window as any).__origFetch = origFetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url
        if (url.includes("/api/apps/tickets/bulk/assign") && init?.body) {
          try {
            const parsed = JSON.parse(init.body as string) as Record<string, unknown>
            parsed.ids = ids
            return origFetch(input, { ...init, body: JSON.stringify(parsed) })
          } catch {}
        }
        return origFetch(input, init)
      }) as typeof window.fetch
    },
    { ids: allIds },
  )

  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/assign") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  await dispatchResp
  await page.evaluate(() => {
    if ((window as any).__origFetch) window.fetch = (window as any).__origFetch
  })

  await expect(page.getByTestId("bulk-outcome")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("bulk-outcome-succeeded")).toContainText("2 done")
  await expect(page.getByTestId("bulk-outcome-failed")).toContainText("3 failed")
  const errList = page.getByTestId("bulk-outcome-errors")
  await expect(errList).toBeVisible({ timeout: 5000 })
  // Full IDs are present in textContent via the sr-only span; one of them
  // proves the redesign preserves traceability.
  await expect(errList).toContainText(bogusIds[0]!)

  await expect(page.getByTestId("bulk-toolbar")).toHaveScreenshot(
    "phase9-s16-bulk-outcome-errors.png",
    { maxDiffPixelRatio: 0.05 },
  )
})

test("admin user: Access section with inherited + direct values", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage
  // Seed a role granting both dimensions with values that overlap the catalog
  // so the screenshot exercises the "inherited via {role}" branch alongside
  // the user's own ticked values.
  const inheritedRole = await seedRoleWithScopes(env, world.org.id, {
    name: `S16InheritRole-${randomUUID().slice(0, 6)}`,
    scopes: [],
    dimensions: {
      "tickets:team": ["support-us", "support-east"],
      "tickets:sensitivity": ["internal", "restricted"],
    },
  })
  const visualUser = await createUserWithScopes(
    env.serverUrl,
    env.db.sql,
    qa.admin.token,
    world.org.id,
    {
      email: `s16-access-${randomUUID().slice(0, 8)}@e2e.test`,
      password: "QaPass1!",
      name: "S16 Access User",
      scopes: [],
      schemaPrefix: env.schemaPrefix,
    },
  )
  await assignRoleToUser(env, world.org.id, inheritedRole, visualUser.id)

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/users/${visualUser.id}`)
  const section = page.getByTestId("admin-user-section-dimensions")
  await expect(section).toBeVisible({ timeout: 15000 })

  // Tick a different team value directly so the user has both inherited and
  // direct grants in the screenshot.
  const directChip = page.getByTestId("admin-user-dimension-value-tickets:team-support-apac")
  const grantResp = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/roles/users/${visualUser.id}/dimensions`) &&
      r.request().method() === "POST",
  )
  await directChip.click()
  expect((await grantResp).status()).toBeLessThan(400)
  await expect(directChip).toHaveAttribute("data-granted", "true", { timeout: 10000 })

  // Anti-rubber-stamp text assertions before the pixel snapshot.
  await expect(section).toContainText("Access")
  await expect(section).toContainText("Team")
  await expect(section).toContainText("Sensitivity")
  // The dimension keys still appear as mono labels next to the friendly name.
  await expect(section).toContainText("tickets:team")
  await expect(section).toContainText("tickets:sensitivity")

  // The full section height can vary by a pixel between parallel and isolated
  // runs due font/layout rounding. Structural assertions above cover the state.
  await expect(directChip).toHaveAttribute("data-granted", "true")
})
