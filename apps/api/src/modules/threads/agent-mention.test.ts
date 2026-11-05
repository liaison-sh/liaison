// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-0000000a0001"
const USER_ID = "00000000-0000-0000-0000-0000000a0002"
const ROLE_ID = "00000000-0000-0000-0000-0000000a0003"
// The user's personal agent, as bootstrapRegister creates for every user. An
// agent-authored reply names the agent that spoke (0080).
const AGENT_ID = "00000000-0000-0000-0000-0000000a0004"
// A ROLE agent, in the org but in no thread until a mention pulls it in.
const ROLE_AGENT_ID = "00000000-0000-0000-0000-0000000a0005"
// An ARCHIVED role agent: a mention naming it addresses nobody (S12).
const ARCHIVED_AGENT_ID = "00000000-0000-0000-0000-0000000a0006"
// A live agent of ANOTHER org, and a uuid that names no agent at all.
const FOREIGN_ORG_ID = "00000000-0000-0000-0000-0000000a0007"
const FOREIGN_AGENT_ID = "00000000-0000-0000-0000-0000000a0008"
const GHOST_AGENT_ID = "00000000-0000-0000-0000-0000000a0009"
let THREAD_ID: string
let AGENT_CHAT_THREAD_ID: string
let PLAIN_THREAD_ID: string
/**
 * A token for USER_ID at the versions the database holds NOW. The org's apps are
 * initialised lazily (the outbox tick's first event for the org), and that
 * extends the member role and bumps every holder's permission_version: a token
 * minted once in beforeAll is then refused as permission_version_mismatch on
 * whichever request comes after, which under load is a different one each run.
 * A real client refreshes; this does the same per request.
 */
async function currentToken(): Promise<string> {
  const [u] = await sql<{ auth_version: number; permission_version: number }[]>`
    SELECT auth_version, permission_version FROM kernel.users WHERE id = ${USER_ID}`
  return signAccessToken(
    {
      userId: USER_ID,
      orgId: ORG_ID,
      name: "AgentUser",
      authVersion: u!.auth_version,
      permissionVersion: u!.permission_version,
      scopes: ["kernel"],
    },
    env.JWT_SECRET,
  )
}
// The stubbed stream never reaches a provider, but the pre-check still resolves
// a key before it streams. Without one every invocation stops at "No API key
// available" and no agent reply is ever written, so the replies asserted below
// depended on the machine happening to export a real key.
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

/** Poll kernel.messages for an agent-authored reply in a thread (fire-and-forget
 *  invocation settles after the HTTP response). Returns the count seen. */
async function waitForAgentReply(threadId: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'
    `
    if (rows.length > 0) return rows.length
    await new Promise((r) => setTimeout(r, 100))
  }
  return 0
}

// Empty stream — the @Liaison mention triggers fire-and-forget agent
// invocation. Without a fake stream the underlying `streamText` keeps the
// HTTP request pending and Bun's afterAll waits 5s for it. The mock returns
// an immediately-done stream so the invocation settles before the test exits.
function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

describe("POST /:threadId/messages — agent mention", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-agent-mention-stub"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'AgentMentionOrg', 'agent-mention-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'agentmention@t.com', 'AgentUser')`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ID}, ${ORG_ID}, 'member', 'Member')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel:threads:read')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel:threads:write')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER_ID}, ${ROLE_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@agentuser', 'AgentUser agent', ${USER_ID})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${ROLE_AGENT_ID}, ${ORG_ID}, 'role', '@support', 'Support', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, archived_at)
      VALUES (${ARCHIVED_AGENT_ID}, ${ORG_ID}, 'role', '@retired', 'Retired', '["*"]'::jsonb, now())`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${FOREIGN_ORG_ID}, 'OtherOrg', 'agent-mention-other-org')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${FOREIGN_AGENT_ID}, ${FOREIGN_ORG_ID}, 'role', '@foreign', 'Foreign', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '5.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT (provider, model_id) DO NOTHING`
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)

    const [t] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG_ID}, 'agent-mention-thread', 'Agent Mention Test', ${USER_ID})
      RETURNING id
    `
    THREAD_ID = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${THREAD_ID}, ${ORG_ID})`

    // A 1:1 agent chat: the sole human participant, so every message is directed
    // at the agent — no @mention required.
    const [ac] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, agent_model_id, created_by)
      VALUES (${ORG_ID}, 'agent-chat-thread', '1:1 Liaison', 'agent_chat', 'claude-haiku-4-5', ${USER_ID})
      RETURNING id
    `
    AGENT_CHAT_THREAD_ID = ac.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${AGENT_CHAT_THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${AGENT_CHAT_THREAD_ID}, ${ORG_ID})`

    // A shared thread (default type): the agent stays quiet unless @-mentioned.
    const [pt] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG_ID}, 'plain-thread', 'Shared Thread', ${USER_ID})
      RETURNING id
    `
    PLAIN_THREAD_ID = pt.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${PLAIN_THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${PLAIN_THREAD_ID}, ${ORG_ID})`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  it("returns 201 and persists the user message with agent mention parsed", async () => {
    const res = await app.request(`/api/threads/${THREAD_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `Hey @[AgentUser agent](agent:${AGENT_ID}) can you help?`,
        correlationId: "test-corr-1",
      }),
    })

    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data).toBeDefined()
    expect(body.data.mentions).toContainEqual({ type: "agent", id: AGENT_ID })
  })

  it("does not double-persist the user message when agent mention is detected", async () => {
    const content = `Hey @[AgentUser agent](agent:${AGENT_ID}) check this`

    await app.request(`/api/threads/${THREAD_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        correlationId: "test-corr-2",
      }),
    })

    const messages = await sql`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${THREAD_ID} AND author_type = 'user' AND content = ${content}
    `
    expect(messages.length).toBe(1)
  })

  it("replies in a 1:1 agent_chat thread without requiring an @mention", async () => {
    const res = await app.request(`/api/threads/${AGENT_CHAT_THREAD_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "what's the status of my orders?", correlationId: "ac-1" }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    // Plain message — no agent mention parsed…
    expect(body.data.mentions).toBeNull()
    // …yet the agent still replies because it is a 1:1 agent chat.
    expect(await waitForAgentReply(AGENT_CHAT_THREAD_ID)).toBeGreaterThan(0)
  })

  it("does NOT reply in a shared thread when not @mentioned", async () => {
    const res = await app.request(`/api/threads/${PLAIN_THREAD_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "just a note to the team", correlationId: "plain-1" }),
    })
    expect(res.status).toBe(200)
    // No mention + shared thread → the agent stays quiet.
    expect(await waitForAgentReply(PLAIN_THREAD_ID, 1500)).toBe(0)
  })
  it("mentioning a non-member agent by id auto-adds it and posts the system line before the reply", async () => {
    const [ch] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG_ID}, 'mention-autoadd-channel', 'Autoadd', ${USER_ID}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ch!.id}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${ch!.id}, ${ORG_ID})`

    const res = await app.request(`/api/threads/${ch!.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `@[Support](agent:${ROLE_AGENT_ID}) can you look at this?`,
        correlationId: "autoadd-1",
      }),
    })
    expect(res.status).toBe(200)
    expect(await waitForAgentReply(ch!.id)).toBeGreaterThan(0)

    const seats = await sql`
      SELECT participant_type FROM kernel.thread_participants
      WHERE thread_id = ${ch!.id} AND agent_id = ${ROLE_AGENT_ID}`
    expect(seats.length).toBe(1)
    expect(seats[0].participant_type).toBe("agent")

    const rows = await sql<{ author_type: string; content: string }[]>`
      SELECT author_type, content FROM kernel.messages
      WHERE thread_id = ${ch!.id} ORDER BY created_at ASC, id ASC`
    const systemAt = rows.findIndex((r) => r.author_type === "system")
    const agentAt = rows.findIndex((r) => r.author_type === "agent")
    expect(systemAt).toBeGreaterThanOrEqual(0)
    // A room reads the join line the way Slack writes one: the agent's display
    // NAME, no handle, no "(mentioned)" tail, and never as a post by the person
    // who mentioned it.
    expect(rows[systemAt].content).toBe("AgentUser added Support")
    expect(agentAt).toBeGreaterThan(systemAt)

    // The open channel learns about the seat over the socket, never by a
    // reload: the room the line was written for is watching it live. Without
    // an outbox row for the system message the line existed in the database
    // and in the list read, and the room still showed nothing (FX4).
    const [sysRow] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${ch!.id} AND author_type = 'system' LIMIT 1`
    const [pending] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.pending_events
      WHERE org_id = ${ORG_ID}
        AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create'
        AND payload->'data'->>'id' = ${sysRow!.id}
      LIMIT 1`
    expect(pending?.id).toBeDefined()
  })

  it("an unrelated message in a channel with an agent member fires no agent turn", async () => {
    // S12's literal regression: membership is not standing to speak.
    const [ch] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG_ID}, 'quiet-channel', 'Quiet', ${USER_ID}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ch!.id}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
              VALUES (${ch!.id}, ${ORG_ID}, 'agent', ${ROLE_AGENT_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${ch!.id}, ${ORG_ID})`

    const res = await app.request(`/api/threads/${ch!.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "team, standup moved to 10", correlationId: "quiet-1" }),
    })
    expect(res.status).toBe(200)
    expect(await waitForAgentReply(ch!.id, 2000)).toBe(0)
  })
  // S12: a mention only has standing to speak when it NAMES a live agent of
  // this org. parseMentions validates the uuid shape and nothing else, so
  // without a resolve step an unresolvable mention seated nobody and still
  // dispatched, and the requester's own personal agent answered in a channel
  // it has no seat in.
  async function postMentionToFreshChannel(handle: string, mentionedId: string, corr: string) {
    const [ch] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG_ID}, ${handle}, ${handle}, ${USER_ID}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ch!.id}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${ch!.id}, ${ORG_ID})`
    const res = await app.request(`/api/threads/${ch!.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await currentToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `@[Somebody](agent:${mentionedId}) please look`,
        correlationId: corr,
      }),
    })
    expect(res.status).toBe(200)
    return ch!.id
  }

  async function agentSeats(threadId: string) {
    return await sql`
      SELECT agent_id FROM kernel.thread_participants
      WHERE thread_id = ${threadId} AND participant_type = 'agent'`
  }

  it("a mention naming no agent at all fires no turn and seats nobody", async () => {
    const id = await postMentionToFreshChannel("ghost-mention-channel", GHOST_AGENT_ID, "ghost-1")
    expect(await waitForAgentReply(id, 2000)).toBe(0)
    expect((await agentSeats(id)).length).toBe(0)
  })

  it("a mention naming an archived agent fires no turn and seats nobody", async () => {
    const id = await postMentionToFreshChannel(
      "archived-mention-channel",
      ARCHIVED_AGENT_ID,
      "archived-1",
    )
    expect(await waitForAgentReply(id, 2000)).toBe(0)
    expect((await agentSeats(id)).length).toBe(0)
  })

  it("a mention naming a foreign-org agent fires no turn and seats nobody", async () => {
    const id = await postMentionToFreshChannel(
      "foreign-mention-channel",
      FOREIGN_AGENT_ID,
      "foreign-1",
    )
    expect(await waitForAgentReply(id, 2000)).toBe(0)
    expect((await agentSeats(id)).length).toBe(0)
  })

  it("mentioning one agent fires exactly that agent, never another", async () => {
    const id = await postMentionToFreshChannel("exact-mention-channel", ROLE_AGENT_ID, "exact-1")
    expect(await waitForAgentReply(id)).toBeGreaterThan(0)
    const rows = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages
      WHERE thread_id = ${id} AND author_type = 'agent'`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.author_agent_id).toBe(ROLE_AGENT_ID)
    const seats = await agentSeats(id)
    expect(seats.map((s) => s.agent_id)).toEqual([ROLE_AGENT_ID])
  })
})
