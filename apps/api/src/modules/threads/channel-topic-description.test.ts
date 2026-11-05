// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Slack/Buzz model for channels: a short TOPIC that travels with the name
// and a longer DESCRIPTION that lives in the channel details.
//
// The rules this pins, all three of them the same shape as `discoverable`
// (8acc3231), because the pair is the same class of decision:
//   1. both ride the thread PATCH, under the rename's own gate;
//   2. both come back on the read AND on the unjoined discoverable row, which
//      is the one place a topic has to work for somebody who is not a member;
//   3. a DM has neither, and asking is a 400 rather than a silent drop.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "550e8400-e29b-41d4-a716-4466554409b0"
const OWNER = "550e8400-e29b-41d4-a716-4466554409b1"
const OUTSIDER = "550e8400-e29b-41d4-a716-4466554409b2"
const ROLE = "550e8400-e29b-41d4-a716-4466554409b3"

let ownerToken: string
let outsiderToken: string

async function token(userId: string) {
  return signAccessToken(
    {
      userId,
      orgId: ORG,
      name: "Topic Test",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel"],
    },
    env.JWT_SECRET,
  )
}

/** A room owned by OWNER. A null title is the DM shape: no title, no topic. */
async function seedRoom(handle: string, title: string | null, discoverable = false) {
  const [row] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, discoverable, created_by)
    VALUES (${ORG}, ${handle}, ${title}, ${discoverable}, ${OWNER}) RETURNING id`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
            VALUES (${row.id}, ${OWNER}, ${ORG}, 'admin')`
  return row.id as string
}

const patch = (id: string, body: unknown, bearer: string) =>
  app.request(`/api/threads/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const readThread = (id: string, bearer: string) =>
  app.request(`/api/threads/${id}`, { headers: { Authorization: `Bearer ${bearer}` } })

describe("channel topic and description", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
              VALUES (${ORG}, 'TopicOrg', 'topic-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${OWNER}, ${ORG}, 'topic-owner@t.com', 'Owner') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${OUTSIDER}, ${ORG}, 'topic-outsider@t.com', 'Outsider') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
              VALUES (${ROLE}, ${ORG}, 'topic-member', 'Topic member') ON CONFLICT (id) DO NOTHING`
    for (const scope of ["kernel", "kernel:threads:read", "kernel:threads:write"]) {
      await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
                VALUES (${ROLE}, ${scope}) ON CONFLICT DO NOTHING`
    }
    for (const user of [OWNER, OUTSIDER]) {
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
                VALUES (${user}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    ownerToken = await token(OWNER)
    outsiderToken = await token(OUTSIDER)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("PATCH sets both fields on a channel and the thread read gives them back", async () => {
    const id = await seedRoom("topic-set-channel", "Shipping")

    const res = await patch(
      id,
      { topic: "Shipping the 0.9 beta", description: "Where the beta gets cut and shipped." },
      ownerToken,
    )
    expect(res.status).toBe(200)
    const patched = (await res.json()) as any
    expect(patched.data.topic).toBe("Shipping the 0.9 beta")
    expect(patched.data.description).toBe("Where the beta gets cut and shipped.")

    // The DATABASE, not just the response echo.
    const [row] = await sql`SELECT topic, description FROM kernel.threads WHERE id = ${id}`
    expect(row.topic).toBe("Shipping the 0.9 beta")
    expect(row.description).toBe("Where the beta gets cut and shipped.")

    const read = (await (await readThread(id, ownerToken)).json()) as any
    expect(read.data.topic).toBe("Shipping the 0.9 beta")
    expect(read.data.description).toBe("Where the beta gets cut and shipped.")
  })

  it("a channel that has set neither reads them as null, never as an empty line", async () => {
    const id = await seedRoom("topic-unset-channel", "Quiet")
    const read = (await (await readThread(id, ownerToken)).json()) as any
    expect(read.data.topic).toBeNull()
    expect(read.data.description).toBeNull()
  })

  it("null clears a topic that was set", async () => {
    const id = await seedRoom("topic-clear-channel", "Clearable")
    expect((await patch(id, { topic: "temporary" }, ownerToken)).status).toBe(200)

    const res = await patch(id, { topic: null }, ownerToken)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data.topic).toBeNull()
    const [row] = await sql`SELECT topic FROM kernel.threads WHERE id = ${id}`
    expect(row.topic).toBeNull()
  })

  it("the unjoined discoverable row carries the topic and the description", async () => {
    const id = await seedRoom("topic-discoverable", "Open house", true)
    expect(
      (await patch(id, { topic: "Anyone welcome", description: "Say hello here." }, ownerToken))
        .status,
    ).toBe(200)

    // OUTSIDER is not a participant, so this is the unjoined projection.
    const listing = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    })
    expect(listing.status).toBe(200)
    const row = ((await listing.json()) as any).data.find((r: any) => r.id === id)
    expect(row).toBeDefined()
    expect(row.topic).toBe("Anyone welcome")
    expect(row.description).toBe("Say hello here.")
  })

  it("PATCH topic or description on a DM (an untitled room) is refused", async () => {
    const id = await seedRoom("topic-dm-room", null)

    const withTopic = await patch(id, { topic: "not a channel" }, ownerToken)
    expect(withTopic.status).toBe(400)
    expect(((await withTopic.json()) as any).error.code).toBe("channel_details_require_title")

    const withDescription = await patch(id, { description: "still not a channel" }, ownerToken)
    expect(withDescription.status).toBe(400)
    expect(((await withDescription.json()) as any).error.code).toBe("channel_details_require_title")

    // Clearing is a claim too: a DM has no topic to clear.
    const clearing = await patch(id, { topic: null }, ownerToken)
    expect(clearing.status).toBe(400)

    const [row] = await sql`SELECT topic, description FROM kernel.threads WHERE id = ${id}`
    expect(row.topic).toBeNull()
    expect(row.description).toBeNull()
  })

  it("a rename and a topic in one request land under the NEW title", async () => {
    const id = await seedRoom("topic-rename-together", null)

    const res = await patch(id, { title: "Named now", topic: "and described" }, ownerToken)
    expect(res.status).toBe(200)
    const [row] = await sql`SELECT title, topic FROM kernel.threads WHERE id = ${id}`
    expect(row.title).toBe("Named now")
    expect(row.topic).toBe("and described")
  })

  it("a plain member cannot set the topic: it rides the rename's gate", async () => {
    const id = await seedRoom("topic-member-gated", "Member gated")
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${id}, ${OUTSIDER}, ${ORG}, 'member')`

    const res = await patch(id, { topic: "mine now" }, outsiderToken)
    expect(res.status).toBe(403)
    const [row] = await sql`SELECT topic FROM kernel.threads WHERE id = ${id}`
    expect(row.topic).toBeNull()
  })

  it("an over-long topic is refused at the edge", async () => {
    const id = await seedRoom("topic-too-long", "Long")
    const res = await patch(id, { topic: "x".repeat(251) }, ownerToken)
    expect(res.status).toBe(400)
    const [row] = await sql`SELECT topic FROM kernel.threads WHERE id = ${id}`
    expect(row.topic).toBeNull()
  })

  // A channel name is written without its leading "#": stripped server-side on
  // create and rename; a name that is only "#" and spaces is refused.
  const create = (body: unknown, bearer: string) =>
    app.request("/api/threads", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("create strips a leading # and surrounding whitespace, keeps inner ones", async () => {
    for (const [raw, want] of [
      ["#general", "general"],
      [" ## a b ", "a b"],
    ] as const) {
      const res = await create({ title: raw, participantIds: [], forceCreate: true }, ownerToken)
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.title).toBe(want)
      const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${body.data.id}`
      expect(row.title).toBe(want)
    }
  })

  it("create refuses a name that is only #", async () => {
    const res = await create({ title: "#", participantIds: [] }, ownerToken)
    expect(res.status).toBe(400)
  })

  it("create reads a fullwidth # and drops invisible marks before it", async () => {
    for (const [raw, want] of [
      ["\uFF03ops", "ops"],
      ["\u200B#ops two", "ops two"],
      ["\u200F#ops three", "ops three"],
    ] as const) {
      const res = await create({ title: raw, participantIds: [], forceCreate: true }, ownerToken)
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${body.data.id}`
      expect(row.title).toBe(want)
    }
    const invisible = await create({ title: "\u200B#\u200F", participantIds: [] }, ownerToken)
    expect(invisible.status).toBe(400)
  })

  it("an agent chat's title keeps its #: only a channel name drops it", async () => {
    const id = await seedRoom("title-agent-chat", null)
    await sql`UPDATE kernel.threads SET type = 'agent_chat' WHERE id = ${id}`
    const res = await patch(id, { title: "#1 priority" }, ownerToken)
    expect(res.status).toBe(200)
    const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${id}`
    expect(row.title).toBe("#1 priority")
  })

  it("rename strips the same way and refuses an empty result", async () => {
    const id = await seedRoom("title-rename", "Old")
    const ok = await patch(id, { title: "#launch plan " }, ownerToken)
    expect(ok.status).toBe(200)
    const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${id}`
    expect(row.title).toBe("launch plan")
    const bad = await patch(id, { title: "  # " }, ownerToken)
    expect(bad.status).toBe(400)
    const [after] = await sql`SELECT title FROM kernel.threads WHERE id = ${id}`
    expect(after.title).toBe("launch plan")
  })
})
