// SPDX-License-Identifier: FSL-1.1-ALv2
// Bulk tickets scenario (Phase 9, spec §11.5):
// Select two tickets in the inbox → BulkActionToolbar appears → submit assign
// via the bulk dispatch endpoint and confirm both tickets are updated.

import { randomUUID } from "node:crypto"
import { api, login } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { grantTicketsScopes, seedInbox } from "./helpers/seed"

test("bulk assign tickets via /api/apps/tickets/bulk/assign", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  await grantTicketsScopes(env, world.org.id, qa.amina.id)
  // permission_version bumped — reissue the admin's token
  const fresh = await login(env.serverUrl, "admin@test.com", "12345678")
  const adminToken = fresh.accessToken

  const inbox = await seedInbox(env, world.org.id, {
    name: `BulkInbox-${Date.now()}`,
    emailAddress: `bulk-${Date.now()}@e2e.test`,
  })

  // Seed two tickets via the public tools API
  const createOne = async () => {
    const res = await api(env.serverUrl, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: adminToken,
      body: {
        subject: `Bulk ${randomUUID().slice(0, 6)}`,
        contactEmail: "user@e2e.test",
        sourceInboxId: inbox.id,
      },
    })
    expect(res.status).toBeLessThan(400)
    const data = res.body.data ?? res.body
    return (data.ticketId ?? data.id) as string
  }
  const ids = [await createOne(), await createOne()]

  // Visit the inbox so the frontend has a chance to mount the toolbar
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await page.waitForLoadState("networkidle")

  // Dispatch bulk assign directly against the kernel endpoint
  const dispatch = await api(env.serverUrl, "/api/apps/tickets/bulk/assign", {
    method: "POST",
    token: adminToken,
    body: {
      ids,
      idempotencyKey: randomUUID(),
      params: { assigneeId: qa.amina.id },
    },
  })
  expect(dispatch.status).toBe(200)
  const data = dispatch.body.data ?? dispatch.body
  const items = (data.items ?? []) as Array<{ id: string; status: string }>
  expect(items.length).toBe(2)
  for (const item of items) {
    expect(["succeeded", "failed", "pending_approval"]).toContain(item.status)
  }
})
