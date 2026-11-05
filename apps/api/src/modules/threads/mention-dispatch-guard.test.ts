// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T07: the guard on the mention dispatch itself.
//
// The dispatch a human drives and the dispatch an agent drives are the same
// code path, so the hop bound, the dedupe and the per root cap are enforced for
// both here, before the seat and before the turn. A refusal is VISIBLE: the
// room is told in one fixed line, because a question that went nowhere in
// silence reads as an agent ignoring somebody.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { app } from "~/app"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import * as agentServiceModule from "~/modules/agent/runtime/agent-service"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-00000000b001"
const USER = "00000000-0000-0000-0000-00000000b002"
const ROLE = "00000000-0000-0000-0000-00000000b003"
const CALLEE = "00000000-0000-0000-0000-00000000b004"
const CALLER = "00000000-0000-0000-0000-00000000b005"
let THREAD = ""
let token = ""

const HOP_BOUND_LINE =
  "This question was not passed on: agents may relay a question twice, no further."
const DUPLICATE_LINE = "The same question was already asked, the earlier answer stands."

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

async function seed(opts: {
  content: string
  parentId?: string | null
  agentId?: string | null
  mentions?: Array<{ type: "agent"; id: string }>
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
       parent_message_id, mentions)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${opts.agentId ? "agent" : "user"}, ${opts.agentId ?? null},
            ${opts.content}, '{}'::text[], ${opts.parentId ?? null},
            ${opts.mentions ? JSON.stringify(opts.mentions) : null}::jsonb)
    RETURNING id`
  return row.id
}

async function post(body: Record<string, unknown>) {
  return app.request(`/api/threads/${THREAD}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Lines the room can read, newest last. */
async function contents(): Promise<string[]> {
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM kernel.messages WHERE thread_id = ${THREAD}
    ORDER BY created_at ASC, id ASC`
  return rows.map((r) => r.content)
}

async function agentMessageCount(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages WHERE thread_id = ${THREAD} AND author_type = 'agent'`
  return rows.length
}

/** Messages the CALLEE agent itself authored: the footprint of a turn it ran. */
async function calleeMessageCount(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages WHERE thread_id = ${THREAD} AND author_agent_id = ${CALLEE}`
  return rows.length
}

async function agentSeats(): Promise<number> {
  const rows = await sql<{ agent_id: string }[]>`
    SELECT agent_id FROM kernel.thread_participants
    WHERE thread_id = ${THREAD} AND agent_id IS NOT NULL`
  return rows.length
}

/**
 * Every agent turn started in this file, captured at `invokeAgentForThread`
 * (the one entry every turn goes through). The handle resolves only after the
 * turn's finalize has persisted what it wrote.
 */
const startedTurns: Promise<unknown>[] = []
const realInvokeAgentForThread = agentServiceModule.invokeAgentForThread
const invokeSpy = spyOn(agentServiceModule, "invokeAgentForThread").mockImplementation(((
  ...args: Parameters<typeof realInvokeAgentForThread>
) => {
  const turn = realInvokeAgentForThread(...args)
  startedTurns.push(turn)
  return turn
}) as typeof realInvokeAgentForThread)

/**
 * Lets the fire and forget dispatch do whatever it is going to do: runs every
 * turn it started to completion, so a "nothing ran" check reads a quiet room.
 */
async function settle() {
  let awaited = -1
  while (awaited !== startedTurns.length) {
    // A dispatch that imports the runtime lazily starts its turn a tick late.
    await new Promise((r) => setImmediate(r))
    awaited = startedTurns.length
    await Promise.allSettled(startedTurns)
  }
}

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Guard Route Org', 'p3b-t07-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'p3b-t07@t.com', 'Guard User')`
  await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, 'member', 'Member')`
  for (const scope of ["kernel", "kernel:threads:read", "kernel:threads:write"]) {
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, ${scope})`
  }
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER}, ${ROLE}, ${ORG})`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLEE}, ${ORG}, 'role', '@p3b-callee', 'Callee', '["*"]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLER}, ${ORG}, 'role', '@p3b-caller', 'Caller', '["*"]'::jsonb)`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, title, created_by)
    VALUES (${ORG}, 'p3b-t07-thread', 'Guard Route', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${THREAD}, ${ORG})`
  token = await signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "Guard User",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel"],
    },
    env.JWT_SECRET,
  )
})

afterAll(async () => {
  invokeSpy.mockRestore()
  AgentServiceTestAccess.setStreamText()
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("the guard on the mention dispatch", () => {
  it("a human mention of a live agent still dispatches", async () => {
    const res = await post({ content: `hello @[Callee](agent:${CALLEE}) can you look at this` })
    expect(res.status).toBe(200)
    await settle()
    expect(await agentSeats()).toBeGreaterThan(0)
    // The join line a room reads: "{adder} added {agent display name}", the
    // same line a person's add writes (the handle-and-"(mentioned)" form went
    // when the auto-add became a participant-added EVENT).
    expect((await contents()).some((c) => c.includes("added Callee"))).toBe(true)
  })

  it("a mention chain past the hop bound posts the refusal line and fires no turn", async () => {
    const human = await seed({ content: "the human question that started it" })
    const first = await seed({ content: "relayed once", parentId: human, agentId: CALLER })
    const second = await seed({ content: "relayed twice", parentId: first, agentId: CALLEE })
    const agentsBefore = await agentMessageCount()
    const res = await post({
      content: `@[Callee](agent:${CALLEE}) relay this a third time`,
      parentMessageId: second,
    })
    expect(res.status).toBe(200)
    await settle()
    const lines = await contents()
    expect(lines[lines.length - 1]).toBe(HOP_BOUND_LINE)
    expect(await agentMessageCount()).toBe(agentsBefore)
  })

  it("a refused dispatch seats no participant", async () => {
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD} AND agent_id IS NOT NULL`
    const human = await seed({ content: "another human question" })
    const first = await seed({ content: "relayed once more", parentId: human, agentId: CALLER })
    const second = await seed({ content: "relayed twice more", parentId: first, agentId: CALLEE })
    const res = await post({
      content: `@[Callee](agent:${CALLEE}) and once too often`,
      parentMessageId: second,
    })
    expect(res.status).toBe(200)
    await settle()
    expect(await agentSeats()).toBe(0)
  })

  it("a duplicate ask posts the duplicate line once, not per attempt", async () => {
    const parent = await seed({ content: "the root of a repeated question" })
    const question = `@[Callee](agent:${CALLEE}) has the pallet shipped yet`
    await seed({
      content: question,
      parentId: parent,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
    })
    const res = await post({ content: question, parentMessageId: parent })
    expect(res.status).toBe(200)
    await settle()
    const lines = await contents()
    expect(lines.filter((c) => c === DUPLICATE_LINE).length).toBe(1)
  })

  it("an agent dispatch whose caller scope is unknown is refused, and nothing runs", async () => {
    // FAIL CLOSED on A4: an agent is asking and how far it reaches is unknown,
    // so the callee's turn would otherwise run at the callee's OWN ceiling.
    const { dispatchAgentMention } = await import("~/modules/threads/agent-dispatch-guard")
    const actor = { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
    const trigger = await seed({ content: "an agent asking with no scope of record" })
    const before = await calleeMessageCount()
    const outcome = await dispatchAgentMention(
      (fn) =>
        withRlsContext(
          { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
          fn,
        ),
      {
        orgId: ORG,
        threadId: THREAD,
        calleeAgentId: CALLEE,
        callerAgentId: CALLER,
        parentMessageId: trigger,
        triggerMessageId: trigger,
        questionText: "answer this at your own ceiling please",
        actor,
        adderName: "Caller",
      },
    )
    expect(outcome.allowed).toBe(false)
    expect(!outcome.allowed && outcome.reason).toBe("caller_scope_unknown")
    await settle()
    expect(await calleeMessageCount()).toBe(before)
  })

  it("a direct message in an agent chat goes through the guard, not around it", async () => {
    // The 1:1 fallback used to invoke the turn directly, so a chain already at
    // the hop bound answered anyway. It is the same dispatch as a mention now.
    const [dm] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, 'p3b-fx1-dm', 'Direct', 'agent_chat', ${USER}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${dm.id}, ${USER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${dm.id}, ${CALLEE}, ${ORG}, 'agent')`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${dm.id}, ${ORG})`
    const rows = async () =>
      await sql<{ content: string; author_agent_id: string | null }[]>`
        SELECT content, author_agent_id FROM kernel.messages WHERE thread_id = ${dm.id}
        ORDER BY created_at ASC, id ASC`
    const [human] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${dm.id}, ${ORG}, ${USER}, 'user', 'the question that started it', '{}'::text[])
      RETURNING id`
    const [first] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, parent_message_id)
      VALUES (${dm.id}, ${ORG}, ${USER}, 'agent', ${CALLER}, 'relayed once', '{}'::text[], ${human.id})
      RETURNING id`
    const [second] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, parent_message_id)
      VALUES (${dm.id}, ${ORG}, ${USER}, 'agent', ${CALLEE}, 'relayed twice', '{}'::text[], ${first.id})
      RETURNING id`
    const agentRowsBefore = (await rows()).filter((r) => r.author_agent_id === CALLEE).length
    const res = await app.request(`/api/threads/${dm.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "one more relay please", parentMessageId: second.id }),
    })
    expect(res.status).toBe(200)
    await settle()
    const after = await rows()
    expect(after[after.length - 1].content).toBe(HOP_BOUND_LINE)
    expect(after.filter((r) => r.author_agent_id === CALLEE).length).toBe(agentRowsBefore)
  })

  // P3b-T09a pins two boundaries the extraction must not move.
  it("threads_reply with an agent mention starts no agent turn", async () => {
    const { handleThreadsReply } = await import("~/modules/agent/tools/chat-tools")
    const actor: UserContext = {
      actorType: "user",
      userId: USER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const before = await calleeMessageCount()
    const seatsBefore = await agentSeats()
    const result = await withRlsContext(actor, (tx) =>
      handleThreadsReply(
        {
          threadId: THREAD,
          content: `@[Callee](agent:${CALLEE}) an agent post that names another agent`,
        },
        { userId: USER, orgId: ORG, db: tx, scopes: ["*"] } as never,
      ),
    )
    expect((result as { message?: unknown }).message).toBeDefined()
    await settle()
    // No turn for the callee: threads_reply never calls invokeAgentForThread,
    // which is exactly why agents_ask exists rather than "just reply with a
    // mention". Its turn would have written a message authored by the callee
    // and seated it in the room; neither happened.
    expect(await calleeMessageCount()).toBe(before)
    expect(await agentSeats()).toBe(seatsBefore)
  })

  it("a routine re invocation cannot carry a coordination option", async () => {
    const source = readFileSync(
      new URL("../../infra/jobs/kernel-jobs.ts", import.meta.url).pathname,
      "utf8",
    )
    const callSites = [...source.matchAll(/invokeAgentForThread\(([\s\S]*?)\n\s*\),/g)].map(
      (m) => m[1],
    )
    expect(callSites.length).toBeGreaterThanOrEqual(2)
    for (const args of callSites) expect(args).not.toContain("coordination")

    // And a turn invoked without one stays flat. In a room of its own, where
    // nothing was hand seeded, every row a dispatch wrote sits at the root.
    const [fresh] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'p3b-t09a-flat', 'Flat Room', ${USER}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${fresh.id}, ${USER}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${fresh.id}, ${ORG})`
    const res = await app.request(`/api/threads/${fresh.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: `@[Callee](agent:${CALLEE}) a flat human question` }),
    })
    expect(res.status).toBe(200)
    await settle()
    const rows = await sql<{ parent_message_id: string | null }[]>`
      SELECT parent_message_id FROM kernel.messages WHERE thread_id = ${fresh.id}`
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.parent_message_id === null)).toBe(true)
  })
})
