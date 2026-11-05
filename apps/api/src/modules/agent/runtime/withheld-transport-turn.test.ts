// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D1, the producer half: a turn whose room floor narrowed the agent's
// ceiling persists the withheld labels on its own reply, addressed to the
// requester. A turn that withheld nothing writes no block at all.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "Agent reply" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ORG = crypto.randomUUID()
const REQUESTER = crypto.randomUUID()
const OTHER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const DM = crypto.randomUUID()
const ROLE = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const CEILING = "pennylane:payouts:read"

async function runTurn(threadId: string) {
  const { runAgentChat } = await import("./agent-service")
  const result = await runAgentChat({
    threadId,
    content: "what do the payouts say",
    actor: {
      actorType: "user" as const,
      userId: REQUESTER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: {},
    },
    orgId: ORG,
  })
  await result.finalize({
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
    text: "Agent reply",
    steps: [],
  })
  const rows = await sql<{ metadata: any }[]>`
    SELECT metadata FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent'
    ORDER BY created_at DESC LIMIT 1`
  return rows[0]?.metadata
}

describe("a withheld turn persists its labels for the requester", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'WT Org', ${`wt-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REQUESTER}, ${ORG}, ${`wt-req-${tag}@t.com`}, 'Requester')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER}, ${ORG}, ${`wt-oth-${tag}@t.com`}, 'Other')`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, ${`wt-role-${tag}`}, 'all')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, '*')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${REQUESTER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@wt-${tag}`}, 'WT Agent', ${REQUESTER}, ${`["${CEILING}"]`}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${ROOM}, ${ORG}, ${`wt-room-${tag}`}, 'thread', ${REQUESTER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${REQUESTER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${OTHER}, ${ORG})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${DM}, ${ORG}, ${`wt-dm-${tag}`}, 'agent_chat', ${REQUESTER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${DM}, ${REQUESTER}, ${ORG})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${`claude-haiku-wt-${tag}`}, 'Claude Haiku WT', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("the room floor narrows the ceiling, so the reply carries labels for the requester", async () => {
    const meta = await runTurn(ROOM)
    expect(meta.withheld).toBeDefined()
    expect(meta.withheld.requesterId).toBe(REQUESTER)
    expect(meta.withheld.turnId).toBeTruthy()
    // The ceiling is a pennylane scope, so the card names that CATEGORY. It
    // said "a capability" for every scope in the product until the labels were
    // actually supplied.
    expect(meta.withheld.items.map((i: any) => i.label)).toEqual(["finance data"])
  })

  it("a DM withholds nothing, so the reply carries no withheld block", async () => {
    const meta = await runTurn(DM)
    expect(meta.withheld).toBeUndefined()
  })

  // A view that reads the reply from a page (a reload, a reconnect's resync)
  // ends the turn's live block only when the stored reply names its turn, as
  // the live copy does. Without it the block stayed "working" under the
  // finished answer until the quiet-time fallback asked the server.
  it("the stored reply names the turn it ends, as its live copy does", async () => {
    const meta = await runTurn(DM)
    const [ask] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${DM} AND author_type = 'user'
      ORDER BY created_at DESC LIMIT 1`
    expect(ask?.id).toBeTruthy()
    expect(meta.turnId).toBe(ask?.id)
  })
})
