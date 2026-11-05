// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D4: the add-member dialog's warning. `wouldRevealHiddenHistory` has
// existed since 2b with no way to call it; this is that way.
//
// The answer is a bare boolean, and the route is gated exactly as the add
// itself is: a member of the room with add rights, naming a user of the same
// org. Anything else is 404, so the endpoint is not an oracle on rooms the
// caller is not in nor on people who are not colleagues.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const CANDIDATE = crypto.randomUUID()
const FOREIGNER = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const ROLE = crypto.randomUUID()
const NO_WRITE_ROLE = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const SECRET = "hhc:deals:read"

let memberToken: string
let outsiderToken: string
let readOnlyToken: string

const check = (userId: string, token: string) =>
  app.request(`/api/threads/${ROOM}/hidden-history-check?userId=${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

describe("GET /api/threads/:threadId/hidden-history-check", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'HHC Org', ${`hhc-${tag}`})`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'HHC Other', ${`hhc2-${tag}`})`
    for (const [id, name, org] of [
      [MEMBER, "Member", ORG],
      [OUTSIDER, "Outsider", ORG],
      [CANDIDATE, "Candidate", ORG],
      [FOREIGNER, "Foreigner", OTHER_ORG],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${org}, ${`${name}-${tag}@t.com`}, ${name})`
    }
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, ${`hhc-role-${tag}`}, 'threads')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel:threads:read')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel:threads:write')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${MEMBER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${OUTSIDER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${NO_WRITE_ROLE}, ${ORG}, ${`hhc-read-${tag}`}, 'read only')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${NO_WRITE_ROLE}, 'kernel:threads:read')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${ROOM}, ${ORG}, ${`hhc-room-${tag}`}, 'thread', ${MEMBER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${MEMBER}, ${ORG})`
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${ROOM}, ${ORG}, ${MEMBER}, 'user', 'scoped history', ${[SECRET]}::text[])`

    const claims = { authVersion: 1, permissionVersion: 1 }
    memberToken = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Member",
        ...claims,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    outsiderToken = await signAccessToken(
      {
        userId: OUTSIDER,
        orgId: ORG,
        name: "Outsider",
        ...claims,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    readOnlyToken = await signAccessToken(
      { userId: MEMBER, orgId: ORG, name: "Member", ...claims, scopes: ["kernel:threads:read"] },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ROLE}, ${NO_WRITE_ROLE})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
    await releaseTestLock()
  })

  it("a member adding a colleague who lacks the scope is warned", async () => {
    const res = await check(CANDIDATE, memberToken)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect((body.data ?? body).wouldHideHistory).toBe(true)
    // A bare boolean: never how much, under what scope, or from whom.
    expect(JSON.stringify(body)).not.toContain("hhc:")
  })

  it("a non member of the room gets 404, never an answer about it", async () => {
    const res = await check(CANDIDATE, outsiderToken)
    expect(res.status).toBe(404)
  })

  it("a user of another org is 404, so the route is not a directory", async () => {
    const res = await check(FOREIGNER, memberToken)
    expect(res.status).toBe(404)
  })

  it("a caller without add rights is refused", async () => {
    const res = await check(CANDIDATE, readOnlyToken)
    expect(res.status).toBe(403)
  })
})
