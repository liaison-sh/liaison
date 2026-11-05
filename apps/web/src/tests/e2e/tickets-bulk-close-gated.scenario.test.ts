// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S9 Bulk-close five gated tickets from the inbox toolbar.
//
// Approvals are for agents, not persons: a person's own bulk click never parks
// an approval. Every item runs on the tool's own permission: Amina holds
// `tickets:tickets:close` and NOT `tickets:approve`, and all five close on her
// own authority, with nothing parked.

import { randomUUID } from "node:crypto"
import type { WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { getApprovalsForBulkRequest } from "./helpers/db-reads"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import { indexSeededTickets, searchInboxFor } from "./helpers/tickets-search"

interface BulkBody {
  data: {
    bulkRequestId: string
    total: number
    approvalsCreated: number
    failed: number
    succeeded: number
    items: Array<{ id: string; status: string; error?: string }>
  }
}

function schema(env: WorkerEnv, name: string): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}${name}"` : name
}

async function ticketApprovalCount(env: WorkerEnv, orgId: string): Promise<number> {
  const rows = (await env.db.sql.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${schema(env, "kernel")}.approval_requests
      WHERE org_id = $1 AND tool_name LIKE 'tickets:%'`,
    [orgId],
  )) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

async function ticketStatuses(env: WorkerEnv, ids: string[]): Promise<string[]> {
  const rows = (await env.db.sql.unsafe(
    `SELECT status FROM ${schema(env, "app_tickets")}.tickets WHERE id = ANY($1::uuid[])`,
    [ids],
  )) as Array<{ status: string }>
  return rows.map((r) => r.status)
}

async function bulkCloseFromToolbar(
  page: Page,
  env: WorkerEnv,
  prefix: string,
  ids: string[],
): Promise<BulkBody["data"]> {
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await searchInboxFor(page, prefix, ids)
  for (const id of ids) {
    await page.getByTestId(`tickets-row-checkbox-${id}`).check()
  }
  await expect(page.getByTestId("bulk-selection-count")).toHaveText(`${ids.length} selected`)

  await page.getByTestId("bulk-action-close").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  // closedReason is an enum param → rendered as a <select>, not a text input.
  await page.getByTestId("bulk-field-closedReason").selectOption("resolved")
  // No final email: a close that runs would send it, and the seeded inboxes
  // have no connected mailbox to send through ("close without a message").

  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/close") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  const resp = await dispatchResp
  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as BulkBody
  await expect(page.getByTestId("bulk-outcome")).toBeVisible({ timeout: 5000 })
  return body.data
}

test("a person's bulk-close of five gated tickets runs on their authority and parks no approval", async ({
  page,
  env,
  qa,
  world,
}) => {
  const prefix = `s9-${randomUUID().slice(0, 6)}`
  // Amina can close tickets and does not hold `tickets:approve`: the close's
  // own scope is what decides her click.
  await grantTicketsScopes(env, world.org.id, qa.amina.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:tickets:close",
  ])
  const inbox = await seedInbox(env, world.org.id, {
    name: `S9Inbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const tickets: Array<{ id: string }> = []
  for (let i = 0; i < 5; i++) {
    const t = await seedTicket(env, world.org.id, {
      subject: `${prefix} ticket ${i}`,
      sourceInboxId: inbox.id,
    })
    tickets.push({ id: t.id })
  }
  const ids = tickets.map((t) => t.id)
  await indexSeededTickets(env, { email: qa.amina.email, password: "QaPass1!" }, prefix, ids)
  const approvalsBefore = await ticketApprovalCount(env, world.org.id)

  await loginAs(page, env, qa.amina.email, "QaPass1!")

  // Without `tickets:approve`, all five close on her own authority, without a
  // single approval.
  const closed = await bulkCloseFromToolbar(page, env, prefix, ids)
  expect(closed.total).toBe(5)
  expect(closed.failed, JSON.stringify(closed.items)).toBe(0)
  expect(closed.succeeded).toBe(5)
  expect(closed.approvalsCreated).toBe(0)
  expect(await getApprovalsForBulkRequest(env, closed.bulkRequestId)).toEqual([])
  expect(await ticketApprovalCount(env, world.org.id)).toBe(approvalsBefore)
  await expect
    .poll(async () => (await ticketStatuses(env, ids)).every((st) => st === "closed"), {
      timeout: 10000,
    })
    .toBe(true)
})
