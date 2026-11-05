// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The co-addressed line: when one message addresses two agents, each of them is
// told the other was addressed too.
//
// The live failure this pins: "@support and @finance, what do you handle?" was
// fanned out to both agents, neither was told about the other, and the second
// one asked the first with agents_ask and posted both answers as a list, so the
// room read one agent answering in another's name. Every assertion here is on
// the REAL assembled tail for a REAL mentions payload, never on a mock.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  assembleContext,
  CO_ADDRESSED_AGENTS_PREFIX,
  coAddressedAgentIds,
  formatHandleList,
  renderCoAddressedAgents,
  resetSystemPromptCache,
} from "~/modules/agent/context/context"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const SUPPORT = crypto.randomUUID()
const FINANCE = crypto.randomUUID()
const OPERATIONS = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** The ephemeral runtime-context tail, exactly as the model receives it. */
function tail(result: Awaited<ReturnType<typeof assembleContext>>): string {
  const last = result.messages[result.messages.length - 1]
  const content = typeof last?.content === "string" ? last.content : ""
  return content.startsWith("<runtime-context") ? content : ""
}

async function post(content: string, mentions: Array<{ type: "agent"; id: string }>) {
  await sql`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, mentions)
    VALUES (${THREAD}, ${ORG}, ${USER}, 'user', ${content}, '{}'::text[], ${JSON.stringify(mentions)}::jsonb)`
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Co Addressed Org', ${`co-addr-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`co-addr-${tag}@test.com`}, 'Co Addressed User')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${SUPPORT}, ${ORG}, 'role', '@support', 'Support Desk', 'You answer customer questions.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${FINANCE}, ${ORG}, 'role', '@finance', 'Finance Desk', 'You own invoices and refunds.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${OPERATIONS}, ${ORG}, 'role', '@operations', 'Operations Desk', 'You own shipments.')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`co-addr-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
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

describe("the co-addressed agents line in the runtime context", () => {
  it("names the OTHER addressed agent and never the agent itself", async () => {
    await post("@support and @finance, what do you handle here?", [
      { type: "agent", id: SUPPORT },
      { type: "agent", id: FINANCE },
    ])
    const forFinance = tail(
      await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: FINANCE }),
    )
    expect(forFinance).toContain(`${CO_ADDRESSED_AGENTS_PREFIX} @support.`)
    expect(forFinance).toContain("never ask them and never repeat their answer")
    // The line names colleagues, never the reader: an agent told it also
    // addresses ITSELF is exactly the prompt that produced the self ask.
    expect(forFinance).not.toContain("@finance")

    const forSupport = tail(
      await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SUPPORT }),
    )
    expect(forSupport).toContain(`${CO_ADDRESSED_AGENTS_PREFIX} @finance.`)
    expect(forSupport).not.toContain("@support")
  })

  it("lists three co-addressed handles in handle order", async () => {
    await post("@support @finance @operations, one line each please", [
      { type: "agent", id: OPERATIONS },
      { type: "agent", id: SUPPORT },
      { type: "agent", id: FINANCE },
    ])
    const forSupport = tail(
      await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SUPPORT }),
    )
    expect(forSupport).toContain(`${CO_ADDRESSED_AGENTS_PREFIX} @finance and @operations.`)
  })

  it("renders nothing when the agent is the only one addressed", async () => {
    await post("@support, one more question", [{ type: "agent", id: SUPPORT }])
    const forSupport = tail(
      await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SUPPORT }),
    )
    expect(forSupport.length).toBeGreaterThan(0)
    expect(forSupport).not.toContain(CO_ADDRESSED_AGENTS_PREFIX)
  })
})

describe("the co-addressed line's own parts", () => {
  it("reads the addressed set off the stored mentions, self excluded", () => {
    const message = {
      mentions: [
        { type: "agent", id: SUPPORT },
        { type: "user", id: USER },
        { type: "agent", id: FINANCE },
        { type: "agent", id: FINANCE },
      ],
    }
    expect(coAddressedAgentIds(message, SUPPORT)).toEqual([FINANCE])
    expect(coAddressedAgentIds({ mentions: null }, SUPPORT)).toEqual([])
    expect(coAddressedAgentIds(null, SUPPORT)).toEqual([])
  })

  it("joins handles the way a sentence does", () => {
    expect(formatHandleList([])).toBe("")
    expect(formatHandleList(["@a"])).toBe("@a")
    expect(formatHandleList(["@a", "@b"])).toBe("@a and @b")
    expect(formatHandleList(["@a", "@b", "@c"])).toBe("@a, @b and @c")
  })

  it("renders the empty string for no other addressed agent", async () => {
    expect(await renderCoAddressedAgents([])).toBe("")
  })
})
