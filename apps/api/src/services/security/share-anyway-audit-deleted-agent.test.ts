// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A disclosure whose agent has since been deleted still records the
// disclosure. The row's agent name is what is lost, never the row: the audit
// insert used to name the agent directly and hard-fail on the composite
// (agent_id, org_id) foreign key, taking the disclosed message down with it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { writeShareAnywayAudit } from "~/services/security/share-anyway"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const REQUESTER = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const DELETED_AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

const ctx: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

describe("the share anyway audit row survives a deleted agent", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'SAD Org', ${`sad-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REQUESTER}, ${ORG}, ${`sad-${tag}@t.com`}, 'Requester')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${ROOM}, ${ORG}, ${`sad-room-${tag}`}, 'thread', ${REQUESTER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${REQUESTER}, ${ORG})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("records the disclosure with no agent instead of failing the write", async () => {
    await withRlsContext(ctx, (db) =>
      writeShareAnywayAudit(db, {
        orgId: ORG,
        requesterId: REQUESTER,
        agentId: DELETED_AGENT,
        roomId: ROOM,
        turnId: crypto.randomUUID(),
        effectiveScope: ["wshare:alpha:read"],
        disclosedTo: [REQUESTER],
        messageIds: [crypto.randomUUID()],
      }),
    )
    const rows = await sql<{ agent_id: string | null; requester_user_id: string }[]>`
      SELECT agent_id, requester_user_id FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = 'share_anyway'`
    expect(rows.length).toBe(1)
    expect(rows[0].agent_id).toBe(null)
    expect(rows[0].requester_user_id).toBe(REQUESTER)
  })
})
