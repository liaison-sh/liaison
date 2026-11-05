// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "00000000-0000-4000-8000-000000063001"
const USER = "00000000-0000-4000-8000-000000063002"
const REGULAR_THREAD = "00000000-0000-4000-8000-000000063003"
const APPROVAL_THREAD = "00000000-0000-4000-8000-000000063004"

describe("approval thread public API guards", () => {
  let token: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Approval Thread Org', 'approval-thread-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
      VALUES (${USER}, ${ORG}, 'approval-thread@test.local', 'Approval Thread User', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by) VALUES
      (${REGULAR_THREAD}, ${ORG}, 'regular-thread', 'Regular Thread', 'thread', ${USER}),
      (${APPROVAL_THREAD}, ${ORG}, 'approval-thread', 'Approval Thread', 'approval', ${USER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
      (${REGULAR_THREAD}, ${USER}, ${ORG}, 'admin'),
      (${APPROVAL_THREAD}, ${USER}, ${ORG}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES
      (${USER}, ${REGULAR_THREAD}, ${ORG}),
      (${USER}, ${APPROVAL_THREAD}, ${ORG})
      ON CONFLICT DO NOTHING`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Approval Thread User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("rejects creating or transitioning approval threads through public routes", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ participantIds: [USER], type: "approval" }),
    })
    expect(createRes.status).toBe(400)

    const patchRes = await app.request(`/api/threads/${REGULAR_THREAD}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "approval" }),
    })
    expect(patchRes.status).toBe(400)
  })

  it("excludes approval threads from list but returns them to participants by id", async () => {
    const listRes = await app.request("/api/threads", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as any
    expect(listBody.data.map((t: any) => t.id)).toContain(REGULAR_THREAD)
    expect(listBody.data.map((t: any) => t.id)).not.toContain(APPROVAL_THREAD)

    const getRes = await app.request(`/api/threads/${APPROVAL_THREAD}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(getRes.status).toBe(200)
    expect(((await getRes.json()) as any).data.type).toBe("approval")
  })

  it("rejects public edits to an existing approval thread", async () => {
    const res = await app.request(`/api/threads/${APPROVAL_THREAD}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "New Title" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("invalid_thread_type")
  })
})
