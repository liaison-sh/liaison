// SPDX-License-Identifier: FSL-1.1-ALv2
// Cross-app mention scenario (Phase 9, spec §11.5):
// Confirm the manifest-driven mention search returns ticket entities once
// the actor holds tickets:tickets:read, and that backlinks resolve via the
// kernel reference endpoint.

import { randomUUID } from "node:crypto"
import { api, login } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { grantTicketsScopes, seedInbox } from "./helpers/seed"
import { waitForMentionIndex } from "./helpers/wait-for-mention"

test("mention search surfaces ticket entities + backlinks endpoint", async ({ env, qa, world }) => {
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const fresh = await login(env.serverUrl, "admin@test.com", "12345678")
  const adminToken = fresh.accessToken

  const inbox = await seedInbox(env, world.org.id, {
    name: `MentionInbox-${Date.now()}`,
    emailAddress: `mentions-${Date.now()}@e2e.test`,
  })
  const created = await api(env.serverUrl, "/api/apps/tools/tickets:create", {
    method: "POST",
    token: adminToken,
    body: {
      subject: `MentionSearch ${randomUUID().slice(0, 6)}`,
      contactEmail: "user@e2e.test",
      sourceInboxId: inbox.id,
    },
  })
  expect(created.status).toBeLessThan(400)
  const ticketData = created.body.data ?? created.body
  const ticketId = (ticketData.ticketId ?? ticketData.id) as string

  // Phase 10 swapped the mention search backend to MeiliSearch. Indexing is
  // async (write → outbox → durable consumer → BullMQ → Meili), so we poll
  // /api/mentions until the seeded ticket surfaces before asserting.
  const indexed = await waitForMentionIndex({
    serverUrl: env.serverUrl,
    token: adminToken,
    query: "mention",
    type: "entity",
    predicate: (r) => String(r.id ?? "") === String(ticketId),
  })
  expect(indexed, "Meili must surface the seeded ticket via /api/mentions").not.toBeNull()
  const indexedRow = indexed as Record<string, unknown>
  const entityType = String(indexedRow.entityType ?? "")
  expect(entityType === "ticket" || entityType === "tickets").toBe(true)

  // Backlinks endpoint sanity: shouldn't error for a fresh ticket
  const backlinks = await api(
    env.serverUrl,
    `/api/references?app=tickets&entityType=ticket&entityId=${ticketId}`,
    { token: adminToken },
  )
  expect(backlinks.status).toBe(200)
})
