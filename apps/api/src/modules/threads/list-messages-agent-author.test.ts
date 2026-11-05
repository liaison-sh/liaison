// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX4 item 2: the read side loses the speaking agent.
//
// `kernel.messages.author_agent_id` names the agent that wrote an agent row
// (H1 puts it there on every write, and migration 0080's trigger refuses an
// agent row without it). The list projection never selected the column and
// never returned it, so GET /api/threads/:id/messages answered
// `authorAgentId: null` with `authorName: "Liaison"` for a message @finance
// had just written, and the room rendered "Liaison Agent" instead of the
// agent the member had named.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agentAuthorDisplayName, listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let threadId: string
let agentId: string
let agentMessageId: string
let humanMessageId: string
let nestedMessageId: string
let personalAgentId: string
let personalMessageId: string

const ctx: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["kernel:threads:read"],
  dimensionGrants: {},
}

describe("listMessages names the speaking agent (FX4)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Agent Author Org', ${`laa-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, ${`laa-${tag}@test.com`}, 'Alice', 'x')`
    const [a] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name)
      VALUES (${ORG}, 'role', '@finance', 'Finance') RETURNING id`
    agentId = a.id
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, ${`laa-${tag}`}, 'Agent author', ${USER}) RETURNING id`
    threadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${USER}, ${ORG})`

    const [h] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
      VALUES (${threadId}, ${ORG}, ${USER}, 'user', 'what is our runway', '{}'::text[], '2026-03-01T00:00:01Z'::timestamptz)
      RETURNING id`
    humanMessageId = h.id
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
      VALUES (${threadId}, ${ORG}, ${USER}, 'agent', ${agentId}, 'about eleven months', '{}'::text[], '2026-03-01T00:00:02Z'::timestamptz)
      RETURNING id`
    agentMessageId = m.id
    // P3b-T02: an agent only turn nests under the message that triggered it.
    const [n] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, parent_message_id, created_at)
      VALUES (${threadId}, ${ORG}, ${USER}, 'agent', ${agentId}, 'nested under the question', '{}'::text[], ${humanMessageId}, '2026-03-01T00:00:03Z'::timestamptz)
      RETURNING id`
    nestedMessageId = n.id
    // A personal agent's post, written with the generic label its stored name
    // used to copy onto the row, plus its reply under the human's message.
    const [pa] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id)
      VALUES (${ORG}, 'personal', ${`@alice-${tag}`}, 'Personal agent', ${USER}) RETURNING id`
    personalAgentId = pa.id
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes, created_at)
      VALUES (${threadId}, ${ORG}, ${USER}, 'agent', ${personalAgentId}, 'the proforma is attached',
              ${JSON.stringify({ agentAuthorLabel: "Personal agent" })}::jsonb, '{}'::text[], '2026-03-01T00:00:04Z'::timestamptz)
      RETURNING id`
    personalMessageId = p.id
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, reply_root_id, created_at)
      VALUES (${threadId}, ${ORG}, ${USER}, 'agent', ${personalAgentId}, 'a reply in the thread', '{}'::text[], ${humanMessageId}, '2026-03-01T00:00:05Z'::timestamptz)`
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

  it("returns authorAgentId and the agent display name on an agent message", async () => {
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId, limit: 50 }),
    )
    const agentRow = page?.messages.find((m) => m.id === agentMessageId)
    expect(agentRow).toBeDefined()
    expect(agentRow?.authorAgentId).toBe(agentId)
    expect(agentRow?.authorName).toBe("Finance")
  })

  // A personal agent posted into its owner's DM with a teammate as the bare
  // "Personal agent": the teammate could not tell whose agent spoke. The read
  // names it after its owner, rows written before the rule included.
  it("names a personal agent's post as its owner's agent, never the bare default", async () => {
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId, limit: 50 }),
    )
    const row = page?.messages.find((m) => m.id === personalMessageId)
    expect(row?.authorAgentId).toBe(personalAgentId)
    expect(row?.authorName).toBe("Alice's agent")
    const root = page?.messages.find((m) => m.id === humanMessageId)
    expect(root?.replyAuthors).toEqual([
      { id: personalAgentId, name: "Alice's agent", avatarUrl: null },
    ])
  })

  it("leaves a human message with no agent id and the human name", async () => {
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId, limit: 50 }),
    )
    const humanRow = page?.messages.find((m) => m.id === humanMessageId)
    expect(humanRow?.authorAgentId).toBeNull()
    expect(humanRow?.authorName).toBe("Alice")
  })

  // P3b-T02: the nesting column is addressable from the read path, so Home can
  // render an agent to agent exchange without a second query per message.
  it("listMessages returns parentMessageId for a nested message", async () => {
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId, limit: 50 }),
    )
    const nestedRow = page?.messages.find((m) => m.id === nestedMessageId)
    expect(nestedRow).toBeDefined()
    expect(nestedRow?.parentMessageId).toBe(humanMessageId)
    const humanRow = page?.messages.find((m) => m.id === humanMessageId)
    expect(humanRow?.parentMessageId).toBeNull()
  })

  it("listMessages omits no existing field when parentMessageId is added", async () => {
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId, limit: 50 }),
    )
    const row = page?.messages.find((m) => m.id === agentMessageId)
    expect(row).toBeDefined()
    // The projection's keys before P3b-T02, named literally: adding the nesting
    // column may never cost the read path a field it already answered with.
    const before = [
      "id",
      "threadId",
      "authorId",
      "authorAgentId",
      "authorName",
      "authorAvatarUrl",
      "authorType",
      "content",
      "mentions",
      "metadata",
      "reactions",
      "attachments",
      "editedAt",
      "deletedAt",
      "createdAt",
    ]
    const keys = Object.keys(row as object)
    expect(before.filter((k) => !keys.includes(k))).toEqual([])
    expect(keys).toContain("parentMessageId")
  })
})

describe("agentAuthorDisplayName", () => {
  it("a personal agent signs as its owner's, over any persisted copy of a name", () => {
    for (const persistedLabel of ["Personal agent", "Alice Martin's agent", null]) {
      expect(
        agentAuthorDisplayName({
          persistedLabel,
          liveAgentName: "Personal agent",
          liveAgentKind: "personal",
          liveAgentOwnerName: "Alice Martin",
        }),
      ).toBe("Alice's agent")
    }
  })

  it("a routine run keeps its attribution and a named agent its live name", () => {
    expect(
      agentAuthorDisplayName({
        persistedLabel: "Routine daily-digest",
        liveAgentName: "Personal agent",
        liveAgentKind: "personal",
        liveAgentOwnerName: "Alice",
      }),
    ).toBe("Routine daily-digest")
    expect(
      agentAuthorDisplayName({
        persistedLabel: "Finance",
        liveAgentName: "Finance Desk",
        liveAgentKind: "role",
      }),
    ).toBe("Finance Desk")
  })
})
