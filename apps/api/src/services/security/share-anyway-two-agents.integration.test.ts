// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One channel message can fire SEVERAL agents (threads/routes.ts loops over
// every mentioned agent with the same `msg.id`), so one turn id carries as many
// withheld cards as there were agents. The disclosure's idempotency key
// therefore cannot be the turn: sharing the second agent's card matched the
// first agent's audit row and handed back ITS message ids, so the second agent
// was never disclosed at all and the requester was told it had been.
//
// The key is the withheld MESSAGE's own id (one card, one row), with the acting
// agent as a secondary guard.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { type ShareAnywayRerun, shareAnyway } from "~/services/security/share-anyway"

const A = "sha2:a:read"
const ORG_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const AGENT_B = crypto.randomUUID()
const REQUESTER = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

let turnId = ""
let cardA = ""
let cardB = ""

const ctx: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG_ID,
  scopes: [A],
  dimensionGrants: {},
}

function recordingRerun(): { rerun: ShareAnywayRerun; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    rerun: async (input) => {
      calls.push(input.agentId)
      return [{ content: `shared by ${input.agentId}`, requiredScopes: [A] }]
    },
  }
}

async function insertCard(agentId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, metadata)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${REQUESTER}, 'agent', ${agentId}, 'withheld', '{}',
      ${JSON.stringify({ withheld: { requesterId: REQUESTER, turnId, items: [{ label: "Files" }] } })}::jsonb)
    RETURNING id`
  return row?.id ?? ""
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'TwoAgents', ${`two-agents-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${REQUESTER}, ${ORG_ID}, ${`two-agents-${tag}@test.com`}, 'requester', 'x')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${REQUESTER}, ${ORG_ID}, ${A})`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
    VALUES (${AGENT_A}, ${ORG_ID}, 'personal', ${`@two-a-${tag}`}, 'Agent A', ${REQUESTER}, ${JSON.stringify([A])}::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${AGENT_B}, ${ORG_ID}, 'role', ${`@two-b-${tag}`}, 'Agent B', ${JSON.stringify(["*"])}::jsonb)`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${`two-agents-${tag}`}, 'thread', ${REQUESTER})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${THREAD_ID}, ${REQUESTER}, ${ORG_ID})`
  const [turn] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${REQUESTER}, 'user', '@a @b show the deal', '{}')
    RETURNING id`
  turnId = turn?.id ?? ""
  cardA = await insertCard(AGENT_A)
  cardB = await insertCard(AGENT_B)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`.catch(() => {})
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("Share anyway: two agents on one turn", () => {
  it("each agent's withheld card discloses its own answer, not the first agent's", async () => {
    const { rerun, calls } = recordingRerun()
    const first = await shareAnyway(
      ctx,
      {
        turnId,
        requesterId: REQUESTER,
        roomId: THREAD_ID,
        agentId: AGENT_A,
        withheldMessageId: cardA,
      },
      { rerun },
    )
    const second = await shareAnyway(
      ctx,
      {
        turnId,
        requesterId: REQUESTER,
        roomId: THREAD_ID,
        agentId: AGENT_B,
        withheldMessageId: cardB,
      },
      { rerun },
    )

    expect(calls).toEqual([AGENT_A, AGENT_B])
    expect(second.messageIds).toHaveLength(1)
    expect(second.messageIds).not.toEqual(first.messageIds)

    const rows = await sql<{ author_agent_id: string }[]>`
      SELECT author_agent_id FROM kernel.messages
       WHERE id IN ${sql([...first.messageIds, ...second.messageIds])}
       ORDER BY created_at`
    expect(rows.map((r) => r.author_agent_id)).toEqual([AGENT_A, AGENT_B])
  })

  it("a second press on the SAME card still returns the ids it already wrote", async () => {
    const { rerun, calls } = recordingRerun()
    const again = await shareAnyway(
      ctx,
      {
        turnId,
        requesterId: REQUESTER,
        roomId: THREAD_ID,
        agentId: AGENT_A,
        withheldMessageId: cardA,
      },
      { rerun },
    )
    expect(calls).toEqual([])
    expect(again.messageIds).toHaveLength(1)
  })
})
