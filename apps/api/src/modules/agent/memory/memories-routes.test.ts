// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8200-00000000c001"
const ALICE_ID = "00000000-0000-4000-8200-00000000c002"
const BOB_ID = "00000000-0000-4000-8200-00000000c003"
const READONLY_ID = "00000000-0000-4000-8200-00000000c004"

const FULL_SCOPES = ["kernel:agent:memory:read", "kernel:agent:memory:write"]
const READ_ONLY_SCOPES = ["kernel:agent:memory:read"]

async function tokenFor(userId: string, scopes: string[]): Promise<string> {
  return signAccessToken(
    {
      userId,
      orgId: ORG_ID,
      name: `User ${userId.slice(-4)}`,
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

describe("/api/agent/memories REST routes", () => {
  let aliceToken: string
  let bobToken: string
  let readonlyToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MemRouteOrg', 'mem-route-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${ALICE_ID}, ${ORG_ID}, 'alice-mem@test.com', 'Alice Mem') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${BOB_ID}, ${ORG_ID}, 'bob-mem@test.com', 'Bob Mem') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${READONLY_ID}, ${ORG_ID}, 'ro-mem@test.com', 'RO Mem') ON CONFLICT (id) DO NOTHING`
    // Personal agents — memory.ts resolves the acting user's owner_agent_id
    // from this table on every write (migration 0055 rekey).
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id)
      VALUES (${ORG_ID}, 'personal', '@alice-mem', 'Liaison', ${ALICE_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id)
      VALUES (${ORG_ID}, 'personal', '@bob-mem', 'Liaison', ${BOB_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id)
      VALUES (${ORG_ID}, 'personal', '@ro-mem', 'Liaison', ${READONLY_ID}) ON CONFLICT DO NOTHING`
    aliceToken = await tokenFor(ALICE_ID, FULL_SCOPES)
    bobToken = await tokenFor(BOB_ID, FULL_SCOPES)
    readonlyToken = await tokenFor(READONLY_ID, READ_ONLY_SCOPES)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  const jsonHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  })

  it("POST creates an entry and GET lists it", async () => {
    const created = await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "user",
        name: "role",
        description: "Senior platform eng",
        content: "Taylor leads platform reliability work.",
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as any
    expect(createdBody.data).toMatchObject({
      type: "user",
      name: "role",
      description: "Senior platform eng",
    })

    const list = await app.request("/api/agent/memories", {
      headers: { Authorization: `Bearer ${aliceToken}` },
    })
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as any
    const entry = listBody.data.find((e: any) => e.name === "role")
    expect(entry).toBeDefined()
    expect(entry.description).toBe("Senior platform eng")
    expect(listBody.data.find((e: any) => e.name === "_index")).toBeUndefined()
  })

  it("PATCH updates description and content", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "feedback",
        name: "no-emoji",
        description: "Never use emoji",
        content: "...",
      }),
    })
    const patched = await app.request("/api/agent/memories/feedback/no-emoji", {
      method: "PATCH",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        description: "No emoji ever",
        content: "User explicitly requested no emoji.",
      }),
    })
    expect(patched.status).toBe(200)
    const body = (await patched.json()) as any
    expect(body.data.description).toBe("No emoji ever")
    expect(body.data.content).toContain("explicitly")
  })

  it("PATCH on missing entry returns 404", async () => {
    const r = await app.request("/api/agent/memories/feedback/missing", {
      method: "PATCH",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({ description: "no" }),
    })
    expect(r.status).toBe(404)
  })

  it("DELETE removes entry; subsequent GET excludes it", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "project",
        name: "tmp",
        description: "tmp",
        content: "tmp",
      }),
    })
    const del = await app.request("/api/agent/memories/project/tmp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    })
    expect(del.status).toBe(204)

    const list = await app.request("/api/agent/memories", {
      headers: { Authorization: `Bearer ${aliceToken}` },
    })
    const body = (await list.json()) as any
    expect(body.data.find((e: any) => e.name === "tmp")).toBeUndefined()
  })

  it("rejects type='_index' at the Zod boundary (400)", async () => {
    const r = await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({ type: "_index", name: "x", description: "x", content: "x" }),
    })
    expect(r.status).toBe(400)
  })

  it("rejects malformed slug (400)", async () => {
    const r = await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({ type: "user", name: "BAD UPPER", description: "x", content: "x" }),
    })
    expect(r.status).toBe(400)
  })

  it("rejects request without kernel:agent:memory:write scope (403)", async () => {
    const r = await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(readonlyToken),
      body: JSON.stringify({ type: "user", name: "x", description: "x", content: "x" }),
    })
    expect(r.status).toBe(403)
  })

  it("DELETE removes a scoped entry the caller holds the scope for", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "project",
        name: "scoped-row",
        description: "tagged by an earlier agent turn",
        content: "body",
      }),
    })
    await sql`UPDATE kernel.agent_memory SET required_scopes = ARRAY['finance:read']
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-row'`

    const scopedToken = await tokenFor(ALICE_ID, [...FULL_SCOPES, "finance:read"])
    const res = await app.request("/api/agent/memories/project/scoped-row", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${scopedToken}` },
    })
    expect(res.status).toBe(204)

    const rows = await sql`SELECT 1 FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-row'`
    expect(rows.length).toBe(0)
  })

  // FX2 item 7: PATCH had no visibility pre-check, unlike DELETE. A row the
  // caller cannot READ could still be rewritten by naming it, and the union of
  // required_scopes on the write meant the caller never saw what they replaced.
  // Same silent-omission semantics as get and delete: it reads as "no such
  // entry" (404), never as "access denied".
  it("PATCH cannot rewrite a scoped entry the caller cannot read, and the row survives", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "project",
        name: "scoped-patch-row",
        description: "tagged by an earlier agent turn",
        content: "ORIGINAL_BODY",
      }),
    })
    await sql`UPDATE kernel.agent_memory SET required_scopes = ARRAY['finance:read']
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-patch-row'`

    const blind = await app.request("/api/agent/memories/project/scoped-patch-row", {
      method: "PATCH",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({ content: "OVERWRITTEN" }),
    })
    expect(blind.status).toBe(404)
    const after = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-patch-row'`
    expect(after[0]?.content).toBe("ORIGINAL_BODY")

    // A caller who DOES hold the scope patches it normally.
    const scopedToken = await tokenFor(ALICE_ID, [...FULL_SCOPES, "finance:read"])
    const allowed = await app.request("/api/agent/memories/project/scoped-patch-row", {
      method: "PATCH",
      headers: jsonHeaders(scopedToken),
      body: JSON.stringify({ content: "OVERWRITTEN" }),
    })
    expect(allowed.status).toBe(200)
    const rewritten = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-patch-row'`
    expect(rewritten[0]?.content).toBe("OVERWRITTEN")
  })

  it("GET hides a scoped entry from a caller without the scope", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "project",
        name: "scoped-list-row",
        description: "tagged by an earlier agent turn",
        content: "body",
      }),
    })
    await sql`UPDATE kernel.agent_memory SET required_scopes = ARRAY['finance:read']
      WHERE org_id = ${ORG_ID} AND user_id = ${ALICE_ID} AND type = 'project' AND name = 'scoped-list-row'`

    const unscoped = await app.request("/api/agent/memories", {
      headers: { Authorization: `Bearer ${aliceToken}` },
    })
    const unscopedBody = (await unscoped.json()) as any
    expect(unscopedBody.data.find((e: any) => e.name === "scoped-list-row")).toBeUndefined()

    const scopedToken = await tokenFor(ALICE_ID, [...FULL_SCOPES, "finance:read"])
    const scoped = await app.request("/api/agent/memories", {
      headers: { Authorization: `Bearer ${scopedToken}` },
    })
    const scopedBody = (await scoped.json()) as any
    expect(scopedBody.data.find((e: any) => e.name === "scoped-list-row")).toBeDefined()
  })

  it("RLS isolates per-user — bob cannot read alice's memories", async () => {
    await app.request("/api/agent/memories", {
      method: "POST",
      headers: jsonHeaders(aliceToken),
      body: JSON.stringify({
        type: "user",
        name: "secret",
        description: "alice's secret",
        content: "...",
      }),
    })
    const list = await app.request("/api/agent/memories", {
      headers: { Authorization: `Bearer ${bobToken}` },
    })
    const body = (await list.json()) as any
    expect(body.data.find((e: any) => e.name === "secret")).toBeUndefined()
  })
})
