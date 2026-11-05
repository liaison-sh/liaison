// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A35, the missing half of "discoverable channels": something in the PRODUCT
// has to be able to set the flag. Surface 3 listed and joined discoverable
// channels, but the only way to make one was an UPDATE on the box, so a channel
// could never become public in real use.
//
// The rule this pins: `discoverable` rides the PATCH that renames, under the
// rename's own gate (thread-level admin), and only on a titled room. A DM has
// no title and is refused rather than silently published to the whole org.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "550e8400-e29b-41d4-a716-4466554409a0"
const OWNER = "550e8400-e29b-41d4-a716-4466554409a1"
const OUTSIDER = "550e8400-e29b-41d4-a716-4466554409a2"
const ROLE = "550e8400-e29b-41d4-a716-4466554409a3"

let ownerToken: string
let outsiderToken: string

async function token(userId: string) {
  return signAccessToken(
    {
      userId,
      orgId: ORG,
      name: "Discoverable Test",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel"],
    },
    env.JWT_SECRET,
  )
}

/** A titled room owned by OWNER, private until something publishes it. */
async function seedChannel(handle: string, title: string | null) {
  const [row] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, created_by)
    VALUES (${ORG}, ${handle}, ${title}, ${OWNER}) RETURNING id`
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

describe("thread discoverable flag", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
              VALUES (${ORG}, 'DiscoverableOrg', 'discoverable-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${OWNER}, ${ORG}, 'disc-owner@t.com', 'Owner') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${OUTSIDER}, ${ORG}, 'disc-outsider@t.com', 'Outsider') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
              VALUES (${ROLE}, ${ORG}, 'disc-member', 'Discoverable member') ON CONFLICT (id) DO NOTHING`
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

  it("PATCH discoverable=true on a titled channel publishes it to a non-member", async () => {
    const id = await seedChannel("disc-open-channel", "Growth lab")

    // Before: the outsider cannot see it in the discoverable listing at all.
    const before = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    })
    const beforeIds = ((await before.json()) as any).data.map((t: any) => t.id)
    expect(beforeIds).not.toContain(id)

    const res = await patch(id, { discoverable: true }, ownerToken)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data.discoverable).toBe(true)

    const [row] = await sql`SELECT discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.discoverable).toBe(true)

    const after = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    })
    expect(after.status).toBe(200)
    const afterIds = ((await after.json()) as any).data.map((t: any) => t.id)
    expect(afterIds).toContain(id)
  })

  it("PATCH discoverable=false takes a published channel back off the listing", async () => {
    const id = await seedChannel("disc-retract-channel", "Retract me")
    expect((await patch(id, { discoverable: true }, ownerToken)).status).toBe(200)

    const res = await patch(id, { discoverable: false }, ownerToken)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data.discoverable).toBe(false)

    const listing = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    })
    const ids = ((await listing.json()) as any).data.map((t: any) => t.id)
    expect(ids).not.toContain(id)
  })

  it("PATCH discoverable on a DM (an untitled room) is refused", async () => {
    const id = await seedChannel("disc-dm-room", null)

    const res = await patch(id, { discoverable: true }, ownerToken)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("discoverable_requires_title")

    const [row] = await sql`SELECT discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.discoverable).toBe(false)
  })

  it("a rename and a publish in one request publish under the NEW title", async () => {
    const id = await seedChannel("disc-rename-publish", null)

    const res = await patch(id, { title: "Named and published", discoverable: true }, ownerToken)
    expect(res.status).toBe(200)

    const [row] = await sql`SELECT title, discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.title).toBe("Named and published")
    expect(row.discoverable).toBe(true)
  })

  it("a non-participant cannot publish someone else's channel", async () => {
    const id = await seedChannel("disc-foreign-channel", "Not yours")

    const res = await patch(id, { discoverable: true }, outsiderToken)
    expect(res.status).toBe(404)

    const [row] = await sql`SELECT discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.discoverable).toBe(false)
  })

  it("a plain member of the channel cannot publish it", async () => {
    const id = await seedChannel("disc-member-gated", "Member gated")
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${id}, ${OUTSIDER}, ${ORG}, 'member')`

    const res = await patch(id, { discoverable: true }, outsiderToken)
    expect(res.status).toBe(403)

    const [row] = await sql`SELECT discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.discoverable).toBe(false)
  })

  it("POST /threads accepts discoverable on a titled channel and refuses it without a title", async () => {
    const created = await app.request("/api/threads", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        participantIds: [OUTSIDER],
        title: "Born public",
        discoverable: true,
        // These two already share rooms seeded above; the duplicate guard is
        // not what this case is about.
        forceCreate: true,
      }),
    })
    expect(created.status).toBe(200)
    const id = ((await created.json()) as any).data.id
    const [row] = await sql`SELECT discoverable FROM kernel.threads WHERE id = ${id}`
    expect(row.discoverable).toBe(true)

    const untitled = await app.request("/api/threads", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ participantIds: [OUTSIDER], discoverable: true, forceCreate: true }),
    })
    expect(untitled.status).toBe(400)
  })
})
