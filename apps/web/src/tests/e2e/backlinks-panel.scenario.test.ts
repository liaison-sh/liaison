// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S14 Backlinks panel unmounts when empty; paginates when populated.
// (e2e-plan §S14, spec §3.4 panel behavior, §6.5 states matrix.)
//
// Seeds two tickets: one with zero thread_references, one with eleven. Opens
// each in the browser and asserts the BacklinksPanel either does not render
// or renders 10 rows + a Show more button that reveals the 11th.

import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedReferences, seedTicket } from "./helpers/seed"

test("backlinks panel unmounts when empty; paginates when populated", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id

  const inbox = await seedInbox(env, orgId, {
    name: `S14Inbox-${Date.now()}`,
    emailAddress: `s14-${Date.now()}@e2e.test`,
    isDefault: true,
  })
  const emptyTicket = await seedTicket(env, orgId, {
    subject: `S14 zero refs ${Date.now()}`,
    sourceInboxId: inbox.id,
  })
  const populatedTicket = await seedTicket(env, orgId, {
    subject: `S14 eleven refs ${Date.now()}`,
    sourceInboxId: inbox.id,
  })

  // Seed exactly 11 references pointing at the populated ticket. Each reference
  // is a separate thread with Elodie as participant so RLS lets him see them.
  await seedReferences(env, {
    orgId,
    actorId: qa.admin.id,
    app: "tickets",
    entityType: "ticket",
    entityId: populatedTicket.id,
    count: 11,
    handlePrefix: `s14-${Date.now()}`,
  })

  // Login in the browser AFTER the scope grant so the JWT carries the new
  // permission_version.
  await loginAs(page, env, qa.admin.email, "12345678")

  // --- Zero-reference ticket: BacklinksPanel must NOT render --------------
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${emptyTicket.id}`)).toBeVisible({
    timeout: 15000,
  })
  await page.getByTestId(`tickets-list-row-${emptyTicket.id}`).click()
  // Keep-alive rendering keeps prior ticket-detail tabs mounted; scope to the
  // visible (active) tab to avoid Playwright's strict-mode duplicate-match.
  await expect(page.getByTestId("tickets-detail").locator(":visible").first()).toBeVisible({
    timeout: 10000,
  })
  // Panel is wrapped in <Show when={length > 0}> — when the references list
  // is empty, the container is never rendered. Give it a beat to settle the
  // createResource fetch, then assert no panel exists for the empty ticket.
  await page.waitForTimeout(500)
  await expect(
    page.locator(`[data-testid="backlinks-panel"][data-entity-id="${emptyTicket.id}"]`),
  ).toHaveCount(0)

  // --- 11-reference ticket: 10 rows + Show more reveals the 11th ----------
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${populatedTicket.id}`)).toBeVisible({
    timeout: 15000,
  })
  await page.getByTestId(`tickets-list-row-${populatedTicket.id}`).click()
  // Keep-alive rendering keeps prior ticket-detail tabs mounted; scope to the
  // visible (active) tab to avoid Playwright's strict-mode duplicate-match.
  await expect(page.getByTestId("tickets-detail").locator(":visible").first()).toBeVisible({
    timeout: 10000,
  })

  // Scope by entityId — the BacklinksPanel exposes data-entity-id on the
  // container so we can target the populated ticket's panel directly without
  // racing keep-alive duplicates.
  const panel = page.locator(
    `[data-testid="backlinks-panel"][data-entity-id="${populatedTicket.id}"]`,
  )
  await expect(panel).toBeVisible({ timeout: 15000 })
  // First page returns the 10 most recently visited references. Show more
  // loads the next page (the 11th row). The pageSize is 10 (component default).
  const rowsFirstPage = panel.locator('[data-testid^="backlink-row-"]')
  await expect(rowsFirstPage).toHaveCount(10, { timeout: 10000 })
  await expect(panel.getByTestId("backlinks-show-more")).toBeVisible()

  await panel.getByTestId("backlinks-show-more").click()
  await expect(panel.locator('[data-testid^="backlink-row-"]')).toHaveCount(11, { timeout: 10000 })
})
