// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D3: `listMessages` has computed where the viewer's hidden messages sit
// since 2b, and the route dropped it. The marker the client draws cannot exist
// without it, so the list meta carries it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const HOLDER = crypto.randomUUID()
const LACKER = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const ROLE = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const SECRET = "hrm:deals:read"

let lackerToken: string

async function plant(seq: number, content: string, scopes: string[]) {
  await sql`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
    VALUES (${ROOM}, ${ORG}, ${HOLDER}, 'user', ${content}, ${scopes}::text[],
            ${`2026-01-01T00:00:0${seq}Z`}::timestamptz)`
}

describe("GET /api/threads/:threadId/messages meta", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'HRM Org', ${`hrm-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${HOLDER}, ${ORG}, ${`hrm-h-${tag}@t.com`}, 'Holder')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${LACKER}, ${ORG}, ${`hrm-l-${tag}@t.com`}, 'Lacker')`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, ${`hrm-role-${tag}`}, 'threads')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel:threads:read')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel:threads:write')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${LACKER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${ROOM}, ${ORG}, ${`hrm-room-${tag}`}, 'thread', ${HOLDER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${HOLDER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${LACKER}, ${ORG})`
    await plant(1, "open one", [])
    await plant(2, "scoped", [SECRET])
    await plant(3, "open two", [])
    lackerToken = await signAccessToken(
      {
        userId: LACKER,
        orgId: ORG,
        name: "Lacker",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("carries hiddenRuns so the client can mark where history is hidden", async () => {
    const res = await app.request(`/api/threads/${ROOM}/messages`, {
      headers: { Authorization: `Bearer ${lackerToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.length).toBe(2)
    expect(Array.isArray(body.meta?.hiddenRuns)).toBe(true)
    expect(body.meta.hiddenRuns.length).toBe(1)
    expect(body.meta.hiddenRuns[0].count).toBe(1)
    // The run says WHERE and HOW MANY, never what: no scope name, no content.
    expect(JSON.stringify(body.meta.hiddenRuns)).not.toContain("hrm:")
  })
})
