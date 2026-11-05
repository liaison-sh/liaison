// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T17: GET /api/agents/:agentId/definition. Identity comes from the session
// and nowhere else: there is no asUser, no impersonation, and a request that
// even ASKS for one is refused rather than quietly ignored.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import sharp from "sharp"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { syncPersonalAgentCeilingsForEvent } from "~/modules/agent/directory/personal-agent"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const OTHER_ORG = "00000000-0000-0000-0000-000000cf0031"
const SOMEONE_ELSE = "00000000-0000-0000-0000-000000cf0032"

/**
 * A bearer for an existing user carrying EXACTLY these scopes (P4c-T38).
 *
 * The session factory mints its token from the scopes the user holds at that
 * moment, and `grantScope` bumps the permission version, which retires a token
 * already minted. A scope-limited admin therefore has to be signed here: the
 * ceiling rules are about what the CALLER may grant, so a caller holding `*`
 * (which every seeded admin does) cannot exercise them at all.
 */
async function bearerWithScopes(userId: string, orgId: string, scopes: string[]): Promise<string> {
  const [row] = await sql`SELECT name, auth_version, permission_version
    FROM kernel.users WHERE id = ${userId}`
  return signAccessToken(
    {
      userId,
      orgId,
      name: row.name,
      authVersion: row.auth_version,
      permissionVersion: row.permission_version,
      roles: [],
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

describe("GET /api/agents/:agentId/definition", () => {
  let session: minimal.Session
  let agentId: string
  let foreignAgentId: string
  let archivedAgentId: string
  let baseAgentId: string
  let member: minimal.Session
  let otherMember: minimal.Session
  let memberPersonalAgentId: string
  let otherPersonalAgentId: string
  // P4c-T31 fixtures: one role agent with something to count, one room the
  // whole org can see and one room only `member` is in.
  let pageAgentId: string
  let openChannelId: string
  let memberChannelId: string
  let dmChannelId: string
  let agentChatDmId: string
  let knowledgeCollectionId: string
  let knowledgePointerId: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    // A second org, inserted directly: a second createTestOrg would truncate
    // the shared tables and take the first org with it.
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'OtherOrg', ${`other-org-${OTHER_ORG.slice(0, 8)}`}) ON CONFLICT DO NOTHING`

    const [own] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${session.orgId}, 'role', '@def-route', 'Def Route', '["*"]'::jsonb,
        ${"Answers route questions.\nROUTE_AGENT_PROMPT"}) RETURNING id`
    agentId = own.id
    const [archived] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, archived_at)
      VALUES (${session.orgId}, 'role', '@def-route-archived', 'Archived', '["*"]'::jsonb, now()) RETURNING id`
    archivedAgentId = archived.id
    const [foreign] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER_ORG}, 'role', '@def-route-foreign', 'Foreign', '["*"]'::jsonb) RETURNING id`
    foreignAgentId = foreign.id

    // A member may read the definition of any agent it could DM: the
    // mentionable listing IS the gate now, so the fixtures cover every branch
    // of that listing's predicate.
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${session.orgId}, 'system', '@base', 'Base', '["*"]'::jsonb)
      ON CONFLICT (org_id, handle) DO NOTHING`
    const [base] =
      await sql`SELECT id FROM kernel.agents WHERE org_id = ${session.orgId} AND handle = '@base'`
    baseAgentId = base.id

    member = await minimal.session(session.orgId, { role: "member" })
    otherMember = await minimal.session(session.orgId, { role: "member" })
    const [mine] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id, system_prompt)
      VALUES (${session.orgId}, 'personal', '@def-route-mine', 'Mine', '["*"]'::jsonb, ${member.userId}, 'MY_PERSONAL_PROMPT') RETURNING id`
    memberPersonalAgentId = mine.id
    const [theirs] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id, system_prompt)
      VALUES (${session.orgId}, 'personal', '@def-route-theirs', 'Theirs', '["*"]'::jsonb, ${otherMember.userId}, 'THEIR_PERSONAL_PROMPT') RETURNING id`
    otherPersonalAgentId = theirs.id

    // --- P4c-T31: the agent page's fixtures ---------------------------------
    const [page] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${session.orgId}, 'role', '@page-agent', 'Page Agent',
        '["kernel:threads:read","tickets:tickets:read"]'::jsonb,
        ${"Keeps the shipping queue moving.\nSecond line, not the purpose."}) RETURNING id`
    pageAgentId = page.id

    await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, created_by_actor_type)
      VALUES (${session.orgId}, ${pageAgentId}, 'page-skill', 'A skill', 'BODY', 'user')`
    // `visibility = 'shared'` is what makes a role agent's routine readable by
    // anyone but its owner (routines_select, 0048).
    await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
      VALUES (${session.orgId}, ${session.userId}, ${pageAgentId}, 'page-routine', 'A routine', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC')`
    await sql`INSERT INTO kernel.agent_memory (org_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${session.orgId}, ${pageAgentId}, 'reference', 'page-fact', 'A fact', 'CONTENT', '{}'::text[])`
    // Superseded rows are history, never files the Memory tab shows.
    await sql`INSERT INTO kernel.agent_memory (org_id, owner_agent_id, type, name, description, content, required_scopes, superseded_at)
      VALUES (${session.orgId}, ${pageAgentId}, 'reference', 'page-fact-old', 'An old fact', 'OLD', '{}'::text[], now())`
    // A real collection so the knowledge tab's join has a name to return
    // (P4c-T32).
    const [collection] =
      await sql`INSERT INTO app_knowledge.collections (org_id, name) VALUES (${session.orgId}, 'Page Agent Docs') RETURNING id`
    knowledgeCollectionId = collection.id
    const [pointer] =
      await sql`INSERT INTO kernel.agent_knowledge_pointers (org_id, agent_id, collection_id)
      VALUES (${session.orgId}, ${pageAgentId}, ${knowledgeCollectionId}) RETURNING id`
    knowledgePointerId = pointer.id

    const [open] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'page-open', 'Shipping', 'thread', true, ${session.userId}) RETURNING id`
    openChannelId = open.id
    const [priv] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'page-private', 'Members only', 'thread', false, ${member.userId}) RETURNING id`
    memberChannelId = priv.id
    // An UNTITLED 1-human-1-agent room: the DM shape `isDmShapedThread`
    // recognizes on its own (P4c-T32). Never a channel, however many of these
    // the viewer shares with the agent.
    const [dm] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'page-dm', NULL, 'thread', false, ${member.userId}) RETURNING id`
    dmChannelId = dm.id
    // The SAME room, typed `agent_chat`: what `POST /threads/dm` writes. A35
    // rule 1 calls it a DM named by its agent, so the Overview must not list
    // it as a channel called `page-agent-dm`.
    const [agentDm] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'page-agent-dm', NULL, 'agent_chat', false, ${member.userId}) RETURNING id`
    agentChatDmId = agentDm.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
      VALUES (${agentChatDmId}, ${session.orgId}, 'user', ${member.userId})`
    for (const threadId of [openChannelId, memberChannelId, dmChannelId, agentChatDmId]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
        VALUES (${threadId}, ${session.orgId}, 'agent', ${pageAgentId})`
    }
    // TWO humans in the private room, so it stays a genuine group channel
    // rather than tripping the 1-human+1-agent DM rule itself.
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
      VALUES (${memberChannelId}, ${session.orgId}, 'user', ${member.userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
      VALUES (${memberChannelId}, ${session.orgId}, 'user', ${otherMember.userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
      VALUES (${dmChannelId}, ${session.orgId}, 'user', ${member.userId})`
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
      VALUES (${openChannelId}, ${session.orgId}, ${pageAgentId}, 'agent', ${pageAgentId}, 'on it', '{}'::text[])`

    // --- P4c-T37: the Activity tab's audit rows ------------------------------
    // One of each kind the timeline maps, oldest first, plus two rows that must
    // never reach the page: another agent's, and an action nothing maps.
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 13, 10, minutes)).toISOString()
    // A local session reply: the one row that ran on somebody's desktop.
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, metadata, agent_id)
      VALUES (${session.orgId}, ${at(1)}, ${session.userId}, 'agent', 'kernel', 'message', ${crypto.randomUUID()},
        'agent.local_session.reply',
        ${JSON.stringify({ threadId: openChannelId, runLocation: "local", sessionId: "s-1" })}::jsonb, ${pageAgentId})`
    // An ask: an ordinary message row carrying an agent mention.
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, changes, agent_id)
      VALUES (${session.orgId}, ${at(2)}, ${session.userId}, 'agent', 'kernel', 'message', ${crypto.randomUUID()},
        'message.create',
        ${JSON.stringify({ threadId: openChannelId, mentions: [{ type: "agent", id: agentId }] })}::jsonb, ${pageAgentId})`
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, metadata, agent_id)
      VALUES (${session.orgId}, ${at(3)}, ${session.userId}, 'system', 'kernel', 'routine', ${crypto.randomUUID()},
        'routine.run_completed', ${JSON.stringify({ threadId: openChannelId })}::jsonb, ${pageAgentId})`
    // A plain turn whose payload carries a tool result and a message preview:
    // the row the "no tool result content" test is about.
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, changes, metadata, agent_id)
      VALUES (${session.orgId}, ${at(4)}, ${session.userId}, 'agent', 'kernel', 'message', ${crypto.randomUUID()},
        'message.create',
        ${JSON.stringify({
          threadId: openChannelId,
          preview: "PREVIEW_SECRET the customer said",
          metadata: { toolCalls: [{ name: "tickets_reply", result: "TOOL_RESULT_SECRET" }] },
        })}::jsonb,
        ${JSON.stringify({ toolResult: "TOOL_RESULT_SECRET" })}::jsonb, ${pageAgentId})`
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, metadata, agent_id)
      VALUES (${session.orgId}, ${at(5)}, NULL, 'system', 'kernel', 'thread', ${openChannelId},
        'memory_fact_written', ${JSON.stringify({ name: "a fact" })}::jsonb, ${pageAgentId})`
    // Never shown: an action the timeline does not map...
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, agent_id)
      VALUES (${session.orgId}, ${at(6)}, NULL, 'system', 'kernel', 'thread', ${openChannelId},
        'memory_recalled', ${pageAgentId})`
    // ...and another agent's row, in another conversation.
    await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, changes, agent_id)
      VALUES (${session.orgId}, ${at(7)}, ${session.userId}, 'agent', 'kernel', 'thread', ${dmChannelId},
        'message.create', ${JSON.stringify({ threadId: dmChannelId, preview: "OTHER_AGENT_ROW" })}::jsonb, ${agentId})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE agent_id IN (${pageAgentId}, ${agentId})`
    await sql`DELETE FROM kernel.threads WHERE id IN (${openChannelId}, ${memberChannelId}, ${dmChannelId}, ${agentChatDmId})`
    await sql`DELETE FROM kernel.skills WHERE owner_agent_id = ${pageAgentId}`
    await sql`DELETE FROM kernel.routines WHERE owner_agent_id = ${pageAgentId}`
    await sql`DELETE FROM kernel.agent_memory WHERE owner_agent_id = ${pageAgentId}`
    await sql`DELETE FROM kernel.agent_knowledge_pointers WHERE agent_id = ${pageAgentId}`
    await sql`DELETE FROM app_knowledge.collections WHERE id = ${knowledgeCollectionId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${pageAgentId}`
    await sql`DELETE FROM kernel.agents WHERE handle LIKE '@t38-%'`
    await sql`DELETE FROM kernel.agents WHERE id IN (${agentId}, ${archivedAgentId}, ${foreignAgentId}, ${baseAgentId}, ${memberPersonalAgentId}, ${otherPersonalAgentId})`
    await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER_ORG}`
    await releaseTestLock()
  })

  const get = (path: string, bearer: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${bearer}` } })

  // P4c FX-F3: the directory is the roster, so the `kind='system'` row is on
  // it for an ADMIN (drawn dimmed, no actions) and for nobody else. Before
  // this the route answered from the addressable listing for everyone, the
  // System group was permanently empty and `/agents/@base` resolved to
  // nothing at all.
  it("an admin's directory listing carries @base, a member's does not", async () => {
    const adminRes = await get("/api/agents", session.bearer)
    expect(adminRes.status).toBe(200)
    const adminBody = (await adminRes.json()) as { data: Array<{ handle: string; kind: string }> }
    const base = adminBody.data.find((a) => a.handle === "@base")
    expect(base).toBeDefined()
    expect(base!.kind).toBe("system")

    const memberRes = await get("/api/agents", member.bearer)
    expect(memberRes.status).toBe(200)
    const memberBody = (await memberRes.json()) as { data: Array<{ handle: string }> }
    expect(memberBody.data.some((a) => a.handle === "@base")).toBe(false)
  })

  it("GET /api/agents lists the org's addressable agents and excludes @base and archived ones", async () => {
    const res = await get("/api/agents", member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ id: string; handle: string; displayName: string; avatarUrl: string | null }>
    }
    const listed = body.data.find((a) => a.id === agentId)
    expect(listed).toBeDefined()
    expect(listed!.handle).toBe("@def-route")
    expect(listed!.displayName).toBe("Def Route")
    expect(listed!.avatarUrl).toBeNull()
    // @base is a real row, never an addressable one; so is an archived agent,
    // and another org's agent is not visible at all.
    expect(body.data.some((a) => a.handle === "@base")).toBe(false)
    expect(body.data.some((a) => a.id === archivedAgentId)).toBe(false)
    expect(body.data.some((a) => a.id === foreignAgentId)).toBe(false)
    // Metadata only: no system prompt, no ceiling. The card's `purpose` is the
    // prompt's FIRST line and nothing after it (P4c-T31), which is what this
    // fixture's second line pins.
    expect(JSON.stringify(body)).not.toContain("ROUTE_AGENT_PROMPT")
  })

  // "MY LIAISON" HAS TO BE NAMEABLE. The desktop shell offers a local session
  // from the agent panel, which chats with the caller's own personal agent, and
  // could not tell it from a role agent without this field. A41 narrowed the
  // listing since: a colleague's personal agent is not in it at all, so there
  // is no longer an owner to withhold.
  it("GET /api/agents names the caller's own personal agent and nobody else's owner", async () => {
    const res = await get("/api/agents", member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ id: string; kind: string; ownerUserId: string | null }>
    }
    const mine = body.data.find((a) => a.id === memberPersonalAgentId)
    expect(mine?.kind).toBe("personal")
    expect(mine?.ownerUserId).toBe(member.userId)
    expect(body.data.some((a) => a.id === otherPersonalAgentId)).toBe(false)
    expect(JSON.stringify(body)).not.toContain(otherMember.userId)
  })

  it("returns the composed definition for the authenticated user", async () => {
    const res = await get(`/api/agents/${agentId}/definition`, session.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual([
      "mcpToolList",
      "scopedMemory",
      "skillIndex",
      "systemPrompt",
    ])
    expect(body.data.systemPrompt).toContain("ROUTE_AGENT_PROMPT")
  })

  it("?runtime=node composes the node job's definition (P4, A30); anything else is refused", async () => {
    const node = await get(`/api/agents/${agentId}/definition?runtime=node`, session.bearer)
    expect(node.status).toBe(200)
    const nodePrompt = ((await node.json()) as { data: { systemPrompt: string } }).data.systemPrompt
    expect(nodePrompt).toContain("## You run on the person's computer")
    expect(nodePrompt).not.toContain("## You run on this computer")
    const local = await get(`/api/agents/${agentId}/definition`, session.bearer)
    const localPrompt = ((await local.json()) as { data: { systemPrompt: string } }).data
      .systemPrompt
    expect(localPrompt).toContain("## You run on this computer")
    expect(
      (await get(`/api/agents/${agentId}/definition?runtime=cloud`, session.bearer)).status,
    ).toBe(400)
  })

  it("rejects a userId or asUser query parameter instead of honoring it", async () => {
    const withUserId = await get(
      `/api/agents/${agentId}/definition?userId=${SOMEONE_ELSE}`,
      session.bearer,
    )
    expect(withUserId.status).toBe(400)
    const withAsUser = await get(
      `/api/agents/${agentId}/definition?asUser=${SOMEONE_ELSE}`,
      session.bearer,
    )
    expect(withAsUser.status).toBe(400)
  })

  it("404s for an agentId the caller's org does not own, and for an archived one", async () => {
    expect((await get(`/api/agents/${foreignAgentId}/definition`, session.bearer)).status).toBe(404)
    // Archived reads as missing, the slice-wide rule.
    expect((await get(`/api/agents/${archivedAgentId}/definition`, session.bearer)).status).toBe(
      404,
    )
  })

  // A user may read the definition of any agent they can DM: the gate is the
  // mentionable listing's own predicate, not the admin scope. A member holds
  // kernel:threads:read and no kernel:agents:read, and the role agent is one
  // the listing returns for them.
  it("composes a role agent's definition for a plain member who can DM it", async () => {
    const res = await get(`/api/agents/${agentId}/definition`, member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { systemPrompt: string } }
    expect(body.data.systemPrompt).toContain("ROUTE_AGENT_PROMPT")
  })

  it("404s for a member on an agent the listing does not return: @base and an archived one", async () => {
    expect((await get(`/api/agents/${baseAgentId}/definition`, member.bearer)).status).toBe(404)
    expect((await get(`/api/agents/${archivedAgentId}/definition`, member.bearer)).status).toBe(404)
    expect((await get(`/api/agents/${foreignAgentId}/definition`, member.bearer)).status).toBe(404)
  })

  it("composes a member's OWN personal agent for them", async () => {
    const res = await get(`/api/agents/${memberPersonalAgentId}/definition`, member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { systemPrompt: string } }
    expect(body.data.systemPrompt).toContain("MY_PERSONAL_PROMPT")
  })

  // A personal agent's definition carries that owner's own agent memory rows.
  // Since A41 the listing does not disclose that the agent exists either, so
  // the refusal is the plain 404 every unlisted agent gets.
  it("refuses another owner's personal agent to a member, and still composes it for an admin", async () => {
    const denied = await get(`/api/agents/${otherPersonalAgentId}/definition`, member.bearer)
    expect(denied.status).toBe(404)
    expect(await denied.text()).not.toContain("THEIR_PERSONAL_PROMPT")
    const allowed = await get(`/api/agents/${otherPersonalAgentId}/definition`, session.bearer)
    expect(allowed.status).toBe(200)
  })

  // --- P4c-T31: GET /api/agents/:agentId, the agent page's one read ---------

  it("GET /agents/:id returns counts, channels and capability categories for a role agent", async () => {
    const res = await get(`/api/agents/${pageAgentId}`, session.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        id: string
        handle: string
        displayName: string
        kind: string
        ownerUserId: string | null
        purpose: string
        avatarUrl: string | null
        state: string
        lastActivityAt: string | null
        channels: Array<{ id: string; handle: string; name: string }>
        counts: {
          skills: number
          routines: number
          memoryFiles: number
          knowledgePointers: number
        }
        capabilityCategories: string[]
        runsOn: string
      }
    }
    expect(Object.keys(body.data).sort()).toEqual([
      "avatarColor",
      "avatarUrl",
      "capabilityCategories",
      "channels",
      "counts",
      "displayName",
      "handle",
      "id",
      "kind",
      "lastActivityAt",
      "ownerUserId",
      "purpose",
      "runsOn",
      "state",
    ])
    expect(body.data.handle).toBe("@page-agent")
    expect(body.data.kind).toBe("role")
    expect(body.data.state).toBe("active")
    expect(body.data.purpose).toBe("Keeps the shipping queue moving.")
    // The superseded memory row is history, not a file.
    expect(body.data.counts).toEqual({
      skills: 1,
      routines: 1,
      memoryFiles: 1,
      knowledgePointers: 1,
    })
    // The discoverable room is visible to every member; the private one is
    // not this caller's.
    expect(body.data.channels.map((ch) => ch.handle)).toEqual(["page-open"])
    expect(body.data.channels[0]?.name).toBe("Shipping")
    expect(body.data.capabilityCategories).toEqual(["kernel", "tickets"])
    // No live local claim anywhere: the server is what answers it.
    expect(body.data.runsOn).toBe("liaison")
    expect(body.data.lastActivityAt).not.toBeNull()
  })

  it("a plain member cannot read @base", async () => {
    expect((await get(`/api/agents/${baseAgentId}`, member.bearer)).status).toBe(404)
    // The admin read answers for it, so the 404 is a disclosure rule and not
    // a missing row.
    expect((await get(`/api/agents/${baseAgentId}`, session.bearer)).status).toBe(200)
  })

  it("another user's personal agent is not listed and its page is 404", async () => {
    const page = await get(`/api/agents/${otherPersonalAgentId}`, member.bearer)
    expect(page.status).toBe(404)
    expect(await page.text()).not.toContain("THEIR_PERSONAL_PROMPT")
    // The mention picker and the DM picker read the same listing endpoint, so
    // the page and the pickers cannot disagree about whose Liaison exists.
    const listing = await get("/api/agents", member.bearer)
    const body = (await listing.json()) as { data: Array<{ id: string }> }
    expect(body.data.some((a) => a.id === otherPersonalAgentId)).toBe(false)
    expect(body.data.some((a) => a.id === memberPersonalAgentId)).toBe(true)
    // Its owner still has a page.
    expect((await get(`/api/agents/${otherPersonalAgentId}`, otherMember.bearer)).status).toBe(200)
  })

  it("a member sees no scope names in the response", async () => {
    const res = await get(`/api/agents/${pageAgentId}`, member.bearer)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("kernel:")
    expect(raw).not.toContain("tickets:")
    const body = (await JSON.parse(raw)) as { data: { capabilityCategories: string[] } }
    expect(body.data.capabilityCategories).toEqual(["kernel", "tickets"])
  })

  it("the listing carries purpose, state and channelCount", async () => {
    const res = await get("/api/agents", member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{
        id: string
        kind: string
        purpose: string
        state: string
        channelCount: number
      }>
    }
    const card = body.data.find((a) => a.id === pageAgentId)
    expect(card).toBeDefined()
    expect(card!.kind).toBe("role")
    expect(card!.purpose).toBe("Keeps the shipping queue moving.")
    expect(card!.state).toBe("active")
    // The member is in the private room AND may see the discoverable one.
    // The 1-human+1-agent DM thread they also share with this agent does not
    // count (P4c-T32, see "a DM is not counted as a channel" below).
    expect(card!.channelCount).toBe(2)
  })

  // --- P4c-T32: a DM shares no channel slot with the room roster -----------

  it("a DM is not counted as a channel", async () => {
    const page = await get(`/api/agents/${pageAgentId}`, member.bearer)
    expect(page.status).toBe(200)
    const pageBody = (await page.json()) as {
      data: { channels: Array<{ id: string; handle: string }> }
    }
    expect(pageBody.data.channels.some((ch) => ch.id === dmChannelId)).toBe(false)
    // An agent_chat DM is a DM too: it was listed as a channel whose name was
    // its auto handle.
    expect(pageBody.data.channels.some((ch) => ch.id === agentChatDmId)).toBe(false)
    expect(JSON.stringify(pageBody.data.channels)).not.toContain("page-agent-dm")
    expect(pageBody.data.channels.map((ch) => ch.handle).sort()).toEqual([
      "page-open",
      "page-private",
    ])

    const listing = await get("/api/agents", member.bearer)
    const listingBody = (await listing.json()) as {
      data: Array<{ id: string; channelCount: number }>
    }
    const card = listingBody.data.find((a) => a.id === pageAgentId)
    expect(card?.channelCount).toBe(2)
  })

  // --- P4c-T32: GET /api/agents/:agentId/knowledge --------------------------

  it("GET /agents/:id/knowledge lists the agent's pointers with collection names", async () => {
    const res = await get(`/api/agents/${pageAgentId}/knowledge`, session.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{
        id: string
        collectionId: string
        collectionName: string | null
        createdAt: string
      }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(knowledgePointerId)
    expect(body.data[0].collectionId).toBe(knowledgeCollectionId)
    expect(body.data[0].collectionName).toBe("Page Agent Docs")
    expect(body.data[0].createdAt).toBeDefined()
  })

  // A pointer row carrying only a name said nothing about what the agent reads.
  it("a pointer row carries the collection's document count and last update", async () => {
    const fresh = new Date(Date.UTC(2026, 8, 12, 9, 0)).toISOString()
    const older = new Date(Date.UTC(2026, 7, 1, 9, 0)).toISOString()
    const docIds: string[] = []
    for (const updatedAt of [older, fresh]) {
      const [doc] =
        await sql`INSERT INTO app_knowledge.documents (org_id, title, body, created_by, updated_at, required_scopes, sensitivity)
        VALUES (${session.orgId}, 'A page', 'BODY', ${session.userId}, ${updatedAt}, '{}'::text[], 'internal') RETURNING id`
      docIds.push(doc.id)
      await sql`INSERT INTO app_knowledge.collection_memberships (org_id, collection_id, target_type, target_id, created_by)
        VALUES (${session.orgId}, ${knowledgeCollectionId}, 'document', ${doc.id}, ${session.userId})`
    }
    // An archived document is not on the shelf and must not be counted.
    const [archived] =
      await sql`INSERT INTO app_knowledge.documents (org_id, title, body, created_by, archived_at, required_scopes, sensitivity)
      VALUES (${session.orgId}, 'Retired', 'BODY', ${session.userId}, now(), '{}'::text[], 'internal') RETURNING id`
    docIds.push(archived.id)
    await sql`INSERT INTO app_knowledge.collection_memberships (org_id, collection_id, target_type, target_id, created_by)
      VALUES (${session.orgId}, ${knowledgeCollectionId}, 'document', ${archived.id}, ${session.userId})`

    try {
      const res = await get(`/api/agents/${pageAgentId}/knowledge`, session.bearer)
      const body = (await res.json()) as {
        data: Array<{ documentCount: number | null; lastUpdatedAt: string | null }>
      }
      expect(body.data[0].documentCount).toBe(2)
      expect(new Date(body.data[0].lastUpdatedAt as string).toISOString()).toBe(fresh)
    } finally {
      await sql`DELETE FROM app_knowledge.collection_memberships
        WHERE collection_id = ${knowledgeCollectionId}`
      await sql`DELETE FROM app_knowledge.documents WHERE id = ANY(${docIds})`
    }
  })

  it("an empty collection reports zero documents and no last update", async () => {
    const res = await get(`/api/agents/${pageAgentId}/knowledge`, session.bearer)
    const body = (await res.json()) as {
      data: Array<{ documentCount: number | null; lastUpdatedAt: string | null }>
    }
    expect(body.data[0].documentCount).toBe(0)
    expect(body.data[0].lastUpdatedAt).toBeNull()
  })

  it("GET /:agentId/knowledge follows the same A41 gate as the agent page", async () => {
    // @base: never in the listing, admin-only.
    expect((await get(`/api/agents/${baseAgentId}/knowledge`, member.bearer)).status).toBe(404)
    expect((await get(`/api/agents/${baseAgentId}/knowledge`, session.bearer)).status).toBe(200)
    // Another org's agent: 404 regardless of caller.
    expect((await get(`/api/agents/${foreignAgentId}/knowledge`, session.bearer)).status).toBe(404)
    // Unknown/malformed id: 404, not a 500.
    expect((await get("/api/agents/not-a-uuid/knowledge", session.bearer)).status).toBe(404)
    // A role agent with no pointers at all: empty list, not an error.
    expect((await get(`/api/agents/${agentId}/knowledge`, session.bearer)).status).toBe(200)
    const emptyBody = (await (
      await get(`/api/agents/${agentId}/knowledge`, session.bearer)
    ).json()) as { data: unknown[] }
    expect(emptyBody.data).toEqual([])
  })

  // --- P4c-T37: GET /api/agents/:agentId/activity ---------------------------

  it("activity returns the agent's turns, ticks and asks newest first and nothing from other agents", async () => {
    const res = await get(`/api/agents/${pageAgentId}/activity`, session.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{
        at: string
        kind: string
        threadId: string | null
        threadName: string | null
        summary: string
        runLocation: string
      }>
    }
    expect(body.data.map((r) => r.kind)).toEqual([
      "memory_write",
      "turn",
      "routine_tick",
      "ask",
      "turn",
    ])
    // Newest first, and the other agent's row is not in the page at all.
    const times = body.data.map((r) => Date.parse(r.at))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    // The decoy row belongs to another agent and names another conversation.
    expect(body.data.some((r) => r.threadId === dmChannelId)).toBe(false)
    // The local session reply is the one row that ran on a desktop.
    const local = body.data.filter((r) => r.runLocation === "local")
    expect(local).toHaveLength(1)
    expect(local[0].kind).toBe("turn")
    expect(body.data.every((r) => r.runLocation === "local" || r.runLocation === "liaison")).toBe(
      true,
    )
    // Each row that names a conversation deep links to it, and the room this
    // caller can see is named.
    const withThread = body.data.filter((r) => r.threadId === openChannelId)
    expect(withThread.length).toBeGreaterThan(0)
    expect(withThread[0].threadName).toBe("Shipping")
    // A page is capped at 50 rows however large a limit is asked for.
    const capped = await get(`/api/agents/${pageAgentId}/activity?limit=500`, session.bearer)
    const cappedBody = (await capped.json()) as { data: unknown[] }
    expect(cappedBody.data.length).toBeLessThanOrEqual(50)
    // `before` pages backwards from a row already seen.
    const older = await get(
      `/api/agents/${pageAgentId}/activity?before=${encodeURIComponent(body.data[0].at)}`,
      session.bearer,
    )
    const olderBody = (await older.json()) as { data: Array<{ at: string }> }
    expect(olderBody.data).toHaveLength(body.data.length - 1)
    expect(olderBody.data[0].at).toBe(body.data[1].at)
  })

  it("a plain member is refused", async () => {
    // The role agent IS visible to a member (the page read answers for it), so
    // the refusal is a 403 and not a 404: the timeline is the administration
    // half of the page.
    expect((await get(`/api/agents/${pageAgentId}`, member.bearer)).status).toBe(200)
    const denied = await get(`/api/agents/${pageAgentId}/activity`, member.bearer)
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain("page-open")
    // An agent the member cannot see at all stays a 404, never an oracle.
    expect((await get(`/api/agents/${baseAgentId}/activity`, member.bearer)).status).toBe(404)
    expect((await get(`/api/agents/${otherPersonalAgentId}/activity`, member.bearer)).status).toBe(
      404,
    )
    // Its own owner administers it.
    expect(
      (await get(`/api/agents/${otherPersonalAgentId}/activity`, otherMember.bearer)).status,
    ).toBe(200)
  })

  it("no row carries tool result content", async () => {
    const res = await get(`/api/agents/${pageAgentId}/activity`, session.bearer)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("TOOL_RESULT_SECRET")
    expect(raw).not.toContain("PREVIEW_SECRET")
    const body = (await JSON.parse(raw)) as { data: Array<Record<string, unknown>> }
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([
        "at",
        "kind",
        "runLocation",
        "summary",
        "summaryKey",
        "threadId",
        "threadName",
      ])
      // The catalog key is derived from the ACTION alone, like the summary: a
      // French reader sees "A répondu dans une conversation", and no payload
      // word can reach the key either.
      expect(String(row.summaryKey)).toMatch(/^(ask|[a-z0-9_]+)$/)
    }
    expect(body.data.map((r) => r.summaryKey)).toContain("message_create")
  })

  // The timeline printed `kernel.threads.handle` for every untitled room, so a
  // DM read "thread-22": a database key that names nobody. A DM is named by the
  // people (and agents) in it, exactly as the Chats list names it.
  it("names a DM by its participants, never by the thread handle", async () => {
    const [agentDm] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'thread-9001', NULL, 'thread', false, ${session.userId}) RETURNING id`
    const [peopleDm] =
      await sql`INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${session.orgId}, 'thread-9002', NULL, 'thread', false, ${session.userId}) RETURNING id`
    for (const threadId of [agentDm.id, peopleDm.id]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
        VALUES (${threadId}, ${session.orgId}, 'user', ${session.userId})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
        VALUES (${threadId}, ${session.orgId}, 'agent', ${pageAgentId})`
    }
    // A second human makes the room people-shaped rather than a 1:1 with the
    // agent, so both naming branches are exercised.
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, user_id)
      VALUES (${peopleDm.id}, ${session.orgId}, 'user', ${member.userId})`
    const [memberRow] = await sql`SELECT name FROM kernel.users WHERE id = ${member.userId}`
    const memberFirstName = (memberRow.name as string).split(" ")[0]

    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 14, 10, minutes)).toISOString()
    for (const [i, threadId] of [agentDm.id, peopleDm.id].entries()) {
      await sql`INSERT INTO kernel.audit_log (org_id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, changes, agent_id)
        VALUES (${session.orgId}, ${at(i)}, ${session.userId}, 'agent', 'kernel', 'message', ${crypto.randomUUID()},
          'message.create', ${JSON.stringify({ threadId })}::jsonb, ${pageAgentId})`
    }

    try {
      const res = await get(`/api/agents/${pageAgentId}/activity`, session.bearer)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: Array<{ threadId: string | null; threadName: string | null }>
      }
      const agentRow = body.data.find((r) => r.threadId === agentDm.id)
      const peopleRow = body.data.find((r) => r.threadId === peopleDm.id)
      // A 1:1 with the agent is named by the agent.
      expect(agentRow?.threadName).toBe("Page Agent")
      // A room with another human names its people, the agent among them.
      expect(peopleRow?.threadName).toContain(memberFirstName)
      expect(peopleRow?.threadName).toContain("Page")
      // And no row anywhere on the page leaks a raw thread handle.
      expect(body.data.map((r) => r.threadName)).not.toContain("thread-9001")
      expect(body.data.map((r) => r.threadName)).not.toContain("thread-9002")
      // The titled channel still reads as its title.
      expect(body.data.find((r) => r.threadId === openChannelId)?.threadName).toBe("Shipping")
    } finally {
      await sql`DELETE FROM kernel.audit_log WHERE (changes->>'threadId') IN (${agentDm.id}, ${peopleDm.id})`
      await sql`DELETE FROM kernel.threads WHERE id IN (${agentDm.id}, ${peopleDm.id})`
    }
  })

  // --- the agent's picture: uploaded, not a URL typed by hand ---------------

  async function makePng(): Promise<Buffer> {
    return sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 150, b: 90 } },
    })
      .png()
      .toBuffer()
  }

  const postAvatar = (agent: string, bearer: string, body: Buffer) =>
    app.request(`/api/agents/${agent}/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "image/png" },
      body: new Uint8Array(body),
    })

  it("uploads, serves and removes an agent's picture", async () => {
    const up = await postAvatar(pageAgentId, session.bearer, await makePng())
    expect(up.status).toBe(200)
    const upBody = (await up.json()) as { data: { avatarUrl: string } }
    expect(upBody.data.avatarUrl).toMatch(/^\/api\/avatars\/[A-Za-z0-9_-]{16,64}$/)
    const key = upBody.data.avatarUrl.split("/").pop() as string

    // The same public capability URL a person's picture gets, and it SERVES:
    // the serve lookup resolves an agent key as well as a user one.
    const served = await app.request(`/api/avatars/${key}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/webp")

    // A second upload rotates the key and retires the old object.
    const again = await postAvatar(pageAgentId, session.bearer, await makePng())
    const againBody = (await again.json()) as { data: { avatarUrl: string } }
    const secondKey = againBody.data.avatarUrl.split("/").pop() as string
    expect(secondKey).not.toBe(key)
    expect((await app.request(`/api/avatars/${key}`)).status).toBe(404)

    const removed = await app.request(`/api/agents/${pageAgentId}/avatar`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.bearer}` },
    })
    expect(removed.status).toBe(200)
    expect(((await removed.json()) as { data: { avatarUrl: unknown } }).data.avatarUrl).toBeNull()
    expect((await app.request(`/api/avatars/${secondKey}`)).status).toBe(404)
  })

  it("refuses a non-image, an empty body and a caller who may not edit the agent", async () => {
    const notAnImage = await postAvatar(
      pageAgentId,
      session.bearer,
      Buffer.from("<svg onload=alert(1)>"),
    )
    expect(notAnImage.status).toBe(400)
    expect((await postAvatar(pageAgentId, session.bearer, Buffer.alloc(0))).status).toBe(400)
    // A plain member may not edit a role agent: 403, the same split the PATCH
    // answers with.
    expect((await postAvatar(pageAgentId, member.bearer, await makePng())).status).toBe(403)
    // Somebody else's personal agent stays a 404, never an oracle.
    expect((await postAvatar(otherPersonalAgentId, member.bearer, await makePng())).status).toBe(
      404,
    )
    // Its own owner may set it.
    expect(
      (await postAvatar(otherPersonalAgentId, otherMember.bearer, await makePng())).status,
    ).toBe(200)
  })

  it("rejects an unauthenticated request", async () => {
    const res = await app.request(`/api/agents/${agentId}/definition`)
    expect(res.status).toBe(401)
  })

  // --- P4c-T38: the definition writes the Settings tab makes ----------------
  const send = (method: string, path: string, bearer: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("a purpose longer than a card is whole on the page and the editor, bounded at a sentence on the card", async () => {
    // Third QA walk: the page read cut a stored purpose at 200 characters mid-word
    // ("... Données brutes : toujours via la"), and the Settings form loads that read.
    const long =
      "Lit toute la base métier et l'entrepôt Redshift, explique le calcul de chaque KPI, discute des décisions et propose des changements de définition soumis à approbation. Données brutes : toujours via la passerelle de lecture, jamais en direct."
    expect(long.length).toBeGreaterThan(200)
    const [before] = await sql`SELECT purpose FROM kernel.agents WHERE id = ${pageAgentId}`
    try {
      const res = await send("PATCH", `/api/agents/${pageAgentId}`, session.bearer, {
        purpose: long,
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: { purpose: string } }).data.purpose).toBe(long)
      const page = await get(`/api/agents/${pageAgentId}`, session.bearer)
      expect(((await page.json()) as { data: { purpose: string } }).data.purpose).toBe(long)

      const list = await get("/api/agents", member.bearer)
      const card = (
        (await list.json()) as { data: Array<{ id: string; purpose: string }> }
      ).data.find((a) => a.id === pageAgentId)
      expect(card!.purpose).toBe(
        "Lit toute la base métier et l'entrepôt Redshift, explique le calcul de chaque KPI, discute des décisions et propose des changements de définition soumis à approbation. …",
      )
    } finally {
      await sql`UPDATE kernel.agents SET purpose = ${before?.purpose ?? null} WHERE id = ${pageAgentId}`
    }
  })

  it("PATCH /agents/:id updates the prompt and the ceiling for an admin", async () => {
    const res = await send("PATCH", `/api/agents/${pageAgentId}`, session.bearer, {
      displayName: "Shipping Desk",
      purpose: "Keeps the shipping queue moving.",
      avatarUrl: "/api/avatars/shipping.png",
      systemPrompt: "T38_EDITED_PROMPT\nSecond line.",
      modelPreference: "claude-haiku-4-5",
      scopeCeiling: ["kernel:threads:read"],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { displayName: string; purpose: string; modelPreference: string | null }
    }
    expect(body.data.displayName).toBe("Shipping Desk")
    expect(body.data.purpose).toBe("Keeps the shipping queue moving.")
    expect(body.data.modelPreference).toBe("claude-haiku-4-5")
    // The row itself carries the write, ceiling included.
    const [row] = await sql`SELECT display_name, purpose, avatar_url, model_preference,
      system_prompt, scope_ceiling FROM kernel.agents WHERE id = ${pageAgentId}`
    expect(row.system_prompt).toContain("T38_EDITED_PROMPT")
    expect(row.scope_ceiling).toEqual(["kernel:threads:read"])
    expect(row.avatar_url).toBe("/api/avatars/shipping.png")
    // And the page read answers with the edited fields, not the derived ones.
    const page = await get(`/api/agents/${pageAgentId}`, session.bearer)
    const pageBody = (await page.json()) as {
      data: { purpose: string; avatarUrl: string | null }
    }
    expect(pageBody.data.purpose).toBe("Keeps the shipping queue moving.")
    expect(pageBody.data.avatarUrl).toBe("/api/avatars/shipping.png")

    // The editor's own read is what the form loads: the prompt and the ceiling
    // the page read refuses to carry, behind the same gate as the write. A
    // member sees neither, on a role agent they can otherwise read.
    const editor = await get(`/api/agents/${pageAgentId}/settings`, session.bearer)
    expect(editor.status).toBe(200)
    const editorBody = (await editor.json()) as {
      data: { systemPrompt: string; scopeCeiling: string[]; modelPreference: string | null }
    }
    expect(editorBody.data.systemPrompt).toContain("T38_EDITED_PROMPT")
    expect(editorBody.data.scopeCeiling).toEqual(["kernel:threads:read"])
    expect(editorBody.data.modelPreference).toBe("claude-haiku-4-5")
    const refused = await get(`/api/agents/${pageAgentId}/settings`, member.bearer)
    expect(refused.status).toBe(403)
    expect(await refused.text()).not.toContain("kernel:threads:read")
  })

  it("an admin's narrowing of a person's own agent survives the recompute a grant change runs", async () => {
    const [before] = await sql`SELECT scope_ceiling, ceiling_restriction FROM kernel.agents
      WHERE id = ${memberPersonalAgentId}`
    try {
      const res = await send("PATCH", `/api/agents/${memberPersonalAgentId}`, session.bearer, {
        scopeCeiling: ["kernel:threads:read"],
      })
      expect(res.status).toBe(200)
      const [narrowed] = await sql`SELECT scope_ceiling, ceiling_restriction FROM kernel.agents
        WHERE id = ${memberPersonalAgentId}`
      expect(narrowed.ceiling_restriction).toEqual(["kernel:threads:read"])
      expect(narrowed.scope_ceiling).toEqual(["kernel:threads:read"])

      // An app turned On or Off names every member (user_scope:org_app): the
      // recompute it triggers keeps the narrowing instead of resetting it.
      await syncPersonalAgentCeilingsForEvent({
        app: "kernel",
        entity: "user_scope",
        orgId: session.orgId,
        data: { targetUserIds: [member.userId] },
      })
      const [kept] = await sql`SELECT scope_ceiling FROM kernel.agents
        WHERE id = ${memberPersonalAgentId}`
      expect(kept.scope_ceiling).toEqual(["kernel:threads:read"])

      // A ceiling covering everything the owner holds narrows nothing: the
      // restriction is cleared and the ceiling is the owner's scopes again.
      const wide = await send("PATCH", `/api/agents/${memberPersonalAgentId}`, session.bearer, {
        scopeCeiling: ["*"],
      })
      expect(wide.status).toBe(200)
      const [cleared] = await sql`SELECT scope_ceiling, ceiling_restriction FROM kernel.agents
        WHERE id = ${memberPersonalAgentId}`
      expect(cleared.ceiling_restriction).toBeNull()
      expect(cleared.scope_ceiling).not.toContain("*")
      expect(cleared.scope_ceiling).toContain("kernel:threads:read")
    } finally {
      await sql`UPDATE kernel.agents
        SET scope_ceiling = ${JSON.stringify(before.scope_ceiling)}::jsonb,
            ceiling_restriction = ${before.ceiling_restriction === null ? null : JSON.stringify(before.ceiling_restriction)}::jsonb
        WHERE id = ${memberPersonalAgentId}`
    }
  })

  it("an owner may edit the personal agent's name and prompt but not its ceiling", async () => {
    const allowed = await send("PATCH", `/api/agents/${memberPersonalAgentId}`, member.bearer, {
      displayName: "My Liaison",
      avatarUrl: "/api/avatars/mine.png",
      systemPrompt: "T38_OWNER_PROMPT",
    })
    expect(allowed.status).toBe(200)
    const [row] = await sql`SELECT display_name, system_prompt, scope_ceiling
      FROM kernel.agents WHERE id = ${memberPersonalAgentId}`
    expect(row.display_name).toBe("My Liaison")
    expect(row.system_prompt).toBe("T38_OWNER_PROMPT")

    // Anything else in the body is refused outright, and refused with a code:
    // a ceiling, a purpose or a model quietly dropped would read as saved.
    for (const forbidden of [
      { scopeCeiling: ["*"] },
      { purpose: "Something else" },
      { modelPreference: "claude-opus-4-6" },
    ]) {
      const denied = await send("PATCH", `/api/agents/${memberPersonalAgentId}`, member.bearer, {
        displayName: "My Liaison",
        ...forbidden,
      })
      expect(denied.status).toBe(403)
      const body = (await denied.json()) as { error: { code?: string } }
      expect(body.error.code).toBe("owner_field_forbidden")
    }
    // The ceiling is untouched by every one of those calls.
    const [after] = await sql`SELECT scope_ceiling FROM kernel.agents
      WHERE id = ${memberPersonalAgentId}`
    expect(after.scope_ceiling).toEqual(row.scope_ceiling)

    // A colleague is not the owner, and a role agent has no owner branch.
    expect(
      (
        await send("PATCH", `/api/agents/${memberPersonalAgentId}`, otherMember.bearer, {
          displayName: "Not yours",
        })
      ).status,
    ).toBe(404)
    expect(
      (await send("PATCH", `/api/agents/${pageAgentId}`, member.bearer, { displayName: "Nope" }))
        .status,
    ).toBe(403)
  })

  it("POST /agents creates a role agent with a validated ceiling", async () => {
    // An admin whose OWN grantable scopes are two: the ceiling it may hand an
    // agent is bounded by them, the way sub-agent-definitions.ts bounds a
    // sub-agent role's.
    const limited = await minimal.session(session.orgId, { role: "member" })
    const limitedBearer = await bearerWithScopes(limited.userId, session.orgId, [
      "kernel:agents:admin",
      "kernel:threads:read",
    ])

    const tooWide = await send("POST", "/api/agents", limitedBearer, {
      handle: "@t38-too-wide",
      displayName: "Too Wide",
      scopeCeiling: ["tickets:tickets:write"],
    })
    expect(tooWide.status).toBe(403)
    expect(((await tooWide.json()) as { error: { code?: string } }).error.code).toBe(
      "scope_ceiling_exceeded",
    )
    const [absent] = await sql`SELECT count(*)::int AS n FROM kernel.agents
      WHERE org_id = ${session.orgId} AND handle = '@t38-too-wide'`
    expect(absent.n).toBe(0)

    const created = await send("POST", "/api/agents", limitedBearer, {
      handle: "t38-created",
      displayName: "Created Agent",
      purpose: "Answers shipping questions.",
      systemPrompt: "T38_CREATED_PROMPT",
      scopeCeiling: ["kernel:threads:read"],
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      data: { id: string; handle: string; kind: string; purpose: string }
    }
    expect(body.data.handle).toBe("@t38-created")
    expect(body.data.kind).toBe("role")
    expect(body.data.purpose).toBe("Answers shipping questions.")
    const [row] = await sql`SELECT kind, owner_user_id, scope_ceiling, system_prompt
      FROM kernel.agents WHERE id = ${body.data.id}`
    expect(row.kind).toBe("role")
    expect(row.owner_user_id).toBeNull()
    expect(row.scope_ceiling).toEqual(["kernel:threads:read"])
    expect(row.system_prompt).toBe("T38_CREATED_PROMPT")

    // The handle is one per org: a second create on the same one is a conflict,
    // never a silent overwrite of the agent already answering under it.
    const duplicate = await send("POST", "/api/agents", limitedBearer, {
      handle: "@t38-created",
      displayName: "Second",
      scopeCeiling: [],
    })
    expect(duplicate.status).toBe(409)

    // A member without the admin scope creates nothing at all.
    const denied = await send("POST", "/api/agents", member.bearer, {
      handle: "@t38-denied",
      displayName: "Denied",
      scopeCeiling: [],
    })
    expect(denied.status).toBe(403)

    await sql`DELETE FROM kernel.agents WHERE org_id = ${session.orgId} AND handle LIKE '@t38-%'`
  })
})
