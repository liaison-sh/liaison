// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S8 Bulk-assign five tickets via the toolbar + idempotency replay.
// (e2e-plan §S8, spec §1.3 criteria 12, 14, §3.3, §6.1.)
//
// Drives the real BulkActionToolbar in /tickets: select five seeded rows,
// open the Assign chip, fill the assignedTo shared field, submit, and assert
// the outcome state. Then replays the same idempotencyKey via the API and
// confirms the cached response and zero new approval rows.

import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { getApprovalsForBulkRequest } from "./helpers/db-reads"
import { seedInbox, seedTicket } from "./helpers/seed"
import { indexSeededTickets, searchInboxFor } from "./helpers/tickets-search"

test("bulk-assign five tickets via the inbox toolbar; idempotency replay", async ({
  page,
  env,
  qa,
  world,
}) => {
  const prefix = `s8-${randomUUID().slice(0, 6)}`
  const inbox = await seedInbox(env, world.org.id, {
    name: `S8Inbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const tickets: Array<{ id: string; subject: string; handle: string }> = []
  for (let i = 0; i < 5; i++) {
    const t = await seedTicket(env, world.org.id, {
      subject: `${prefix} ticket ${i}`,
      sourceInboxId: inbox.id,
    })
    tickets.push(t)
  }
  expect(tickets.length).toBe(5)
  await indexSeededTickets(
    env,
    { email: qa.admin.email, password: "12345678" },
    prefix,
    tickets.map((t) => t.id),
  )

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })

  // Wait for at least one seeded row to surface before narrowing via search;
  // this mirrors tickets-list-and-detail / tickets-merge.
  await expect(page.getByTestId(`tickets-list-row-${tickets[0]!.id}`)).toBeVisible({
    timeout: 15000,
  })
  await searchInboxFor(
    page,
    prefix,
    tickets.map((t) => t.id),
  )

  // Select all five rows.
  for (const t of tickets) {
    await page.getByTestId(`tickets-row-checkbox-${t.id}`).check()
  }
  await expect(page.getByTestId("bulk-toolbar")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("bulk-selection-count")).toHaveText("5 selected")

  await page.getByTestId("bulk-action-assign").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await page.getByTestId("bulk-field-assignedTo").fill(qa.amina.id)

  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/assign") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  const resp = await dispatchResp
  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as {
    data: { bulkRequestId: string; succeeded: number; failed: number; total: number }
  }
  expect(body.data.total).toBe(5)
  expect(body.data.succeeded).toBe(5)
  expect(body.data.failed).toBe(0)
  const bulkRequestId = body.data.bulkRequestId

  // Outcome visible (auto-dismisses after 3s — wait window is short).
  await expect(page.getByTestId("bulk-outcome")).toContainText("5 done", { timeout: 3000 })
  await expect(page.getByTestId("bulk-outcome")).toContainText("0 failed")

  // Cross-check DB: each ticket assigned to Amina.
  const ticketsSchema = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
  for (const t of tickets) {
    const rows = (await env.db.sql.unsafe(
      `SELECT assigned_to AS "assignedTo" FROM ${ticketsSchema}.tickets WHERE id = $1`,
      [t.id],
    )) as Array<{ assignedTo: string | null }>
    expect(rows[0]?.assignedTo).toBe(qa.amina.id)
  }

  // Idempotency replay: re-submit the same bulkRequestId (the server uses
  // idempotencyKey == bulkRequestId) and confirm the response is cached and
  // no additional approval rows are written.
  const fresh = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: qa.admin.email, password: "12345678" },
  })
  const adminToken = fresh.body.data.accessToken as string
  const beforeApprovals = await getApprovalsForBulkRequest(env, bulkRequestId)

  const replay = await api(env.serverUrl, "/api/apps/tickets/bulk/assign", {
    method: "POST",
    token: adminToken,
    body: {
      ids: tickets.map((t) => t.id),
      idempotencyKey: bulkRequestId,
      params: { assignedTo: qa.amina.id },
    },
  })
  expect(replay.status).toBe(200)
  const replayData = replay.body.data as {
    bulkRequestId: string
    succeeded: number
    failed: number
  }
  expect(replayData.bulkRequestId).toBe(bulkRequestId)
  expect(replayData.succeeded).toBe(5)
  expect(replayData.failed).toBe(0)

  const afterApprovals = await getApprovalsForBulkRequest(env, bulkRequestId)
  // Assign is not a gated action — no approval rows expected before or after.
  expect(afterApprovals.length).toBe(beforeApprovals.length)
})
