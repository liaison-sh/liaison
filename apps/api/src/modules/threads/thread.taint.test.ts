// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

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

const ORG_ID = "00000000-0000-0000-0000-0000000b0001"
const USER_ID = "00000000-0000-0000-0000-0000000b0002"
const ROLE_ID = "00000000-0000-0000-0000-0000000b0003"
let CHAT_ID: string
let authToken: string

describe("tainted field propagation", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'TaintOrg', 'taint-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'taint@t.com', 'TaintUser')`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ID}, ${ORG_ID}, 'member', 'Member')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel:threads:read')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel:threads:write')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER_ID}, ${ROLE_ID}, ${ORG_ID})`

    const [t] = await sql`
      INSERT INTO kernel.threads (org_id, handle, type, title, created_by)
      VALUES (${ORG_ID}, 'taint-chat', 'agent_chat', 'Taint Chat', ${USER_ID})
      RETURNING id
    `
    CHAT_ID = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${CHAT_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER_ID}, ${CHAT_ID}, ${ORG_ID})`

    authToken = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "TaintUser",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await releaseTestLock()
  })

  it("GET /api/threads/:id returns tainted field", async () => {
    const res = await app.request(`/api/threads/${CHAT_ID}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect("tainted" in body.data).toBe(true)
  })
})
