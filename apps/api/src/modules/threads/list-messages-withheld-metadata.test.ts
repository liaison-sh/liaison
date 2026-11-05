// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D1: the withheld block on an agent reply is PRIVATE to the requester.
// The row is shared into the room, so the read path is what makes the card per
// user: every other member gets the same message with no withheld metadata at
// all.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const REQUESTER = crypto.randomUUID()
const OTHER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let threadId: string

const ctx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: ["kernel:threads:read"],
  dimensionGrants: {},
})

async function list(userId: string) {
  return withRlsContext(ctx(userId), (tx) =>
    listMessages(tx, { orgId: ORG, userId, threadId, limit: 50 }),
  )
}

describe("withheld metadata is private to the requester", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'WM Org', ${`wm-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REQUESTER}, ${ORG}, ${`wm-req-${tag}@t.com`}, 'Requester')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER}, ${ORG}, ${`wm-oth-${tag}@t.com`}, 'Other')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@wm-${tag}`}, 'WM Agent', ${REQUESTER}, '["*"]'::jsonb)`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, ${`wm-room-${tag}`}, 'thread', ${REQUESTER}) RETURNING id`
    threadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${REQUESTER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${OTHER}, ${ORG})`
    const metadata = {
      modelId: "test-model",
      withheld: {
        requesterId: REQUESTER,
        turnId: null,
        items: [{ label: "finance data", scopeName: "pennylane:payouts:read" }],
      },
    }
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
      VALUES (${threadId}, ${ORG}, ${REQUESTER}, 'agent', ${AGENT}, 'here is what I could do', ${JSON.stringify(metadata)}::jsonb, '{}'::text[])`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("the requester reads the withheld items", async () => {
    const out = await list(REQUESTER)
    const meta = out?.messages[0].metadata as any
    expect(meta.modelId).toBe("test-model")
    expect(meta.withheld.items[0].label).toBe("finance data")
  })

  it("another member of the room gets no withheld metadata and no scope name", async () => {
    const out = await list(OTHER)
    const meta = out?.messages[0].metadata as any
    expect(meta.modelId).toBe("test-model")
    expect(meta.withheld).toBeUndefined()
    expect(JSON.stringify(meta)).not.toContain("pennylane")
  })
})
