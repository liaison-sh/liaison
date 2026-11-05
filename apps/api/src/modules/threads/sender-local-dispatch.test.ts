// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A MESSAGE ITS SENDER RUNS ON THEIR OWN MACHINE IS NEVER ANSWERED HERE.
//
// The desktop's "This machine" runtime posts a DM message with `localAgentId`
// once its local session is running. The server must then not start that
// agent's turn, claim or no claim: before this, a desktop that had chosen
// "This machine" but held no claim yet got the server's agent answering on the
// server's model, silently.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  DISPATCH_SKIPPED_SENDER_LOCAL,
  dispatchForPostedMessage,
} from "~/modules/threads/posted-message-dispatch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const OTHER_AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let token: string
let dmId: string

const authed = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

async function humanMessage(content: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${dmId}, ${ORG}, ${USER}, 'user', ${content}, '{}')
    RETURNING id`
  return row.id
}

const skipAudits = (messageId: string) =>
  sql<Array<{ agent_id: string; metadata: Record<string, unknown> }>>`
    SELECT agent_id, metadata FROM kernel.audit_log
    WHERE org_id = ${ORG} AND action = ${DISPATCH_SKIPPED_SENDER_LOCAL}
      AND entity_id = ${messageId}`

function dispatch(messageId: string, content: string, localAgentId?: string) {
  return dispatchForPostedMessage(
    (fn) => withPrivilegedDb(ORG, "sender-local-test", fn as never) as never,
    {
      orgId: ORG,
      threadId: dmId,
      message: {
        id: messageId,
        content,
        mentions: null,
        authorAgentId: null,
        authorName: "User",
        parentMessageId: null,
        threadType: "agent_chat",
      },
      actor: { userId: USER, orgId: ORG, scopes: ["*"] },
      ...(localAgentId ? { localAgentId } : {}),
    },
  )
}

describe("a DM message whose sender runs the turn locally", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Local Send Org', ${`ls-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`ls-${tag}@t.com`}, 'User')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', ${`@ls-data-${tag}`}, 'Data', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${OTHER_AGENT}, ${ORG}, 'role', ${`@ls-ops-${tag}`}, 'Ops', NULL, '[]'::jsonb)`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    const res = await authed("/api/threads/dm", { agentId: AGENT })
    expect(res.status).toBe(201)
    dmId = ((await res.json()) as { data: { id: string } }).data.id
  })

  afterAll(async () => {
    // Let any fire-and-forget turn the control case started settle first.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("starts no server turn for the DM's agent, and says so in the audit", async () => {
    const messageId = await humanMessage("make the monthly report")
    const result = await dispatch(messageId, "make the monthly report", AGENT)
    expect(result.dispatchedAgentIds).toEqual([])
    const audits = await skipAudits(messageId)
    expect(audits).toHaveLength(1)
    expect(audits[0].agent_id).toBe(AGENT)
    expect(audits[0].metadata).toMatchObject({ threadId: dmId, runLocation: "local" })
  })

  it("still dispatches the DM's agent for a message that does not say it runs locally", async () => {
    const messageId = await humanMessage("what is the status?")
    const result = await dispatch(messageId, "what is the status?")
    expect(result.dispatchedAgentIds).toEqual([AGENT])
    expect(await skipAudits(messageId)).toHaveLength(0)
  })

  it("holds back only the named agent: another agent the message names still answers", async () => {
    const messageId = await humanMessage(`@[Ops](agent:${OTHER_AGENT}) and you?`)
    const result = await dispatchForPostedMessage(
      (fn) => withPrivilegedDb(ORG, "sender-local-test", fn as never) as never,
      {
        orgId: ORG,
        threadId: dmId,
        message: {
          id: messageId,
          content: "and you?",
          mentions: [{ type: "agent", id: OTHER_AGENT }],
          authorAgentId: null,
          authorName: "User",
          parentMessageId: null,
          threadType: "agent_chat",
        },
        actor: { userId: USER, orgId: ORG, scopes: ["*"] },
        localAgentId: AGENT,
      },
    )
    expect(result.dispatchedAgentIds).toEqual([OTHER_AGENT])
  })

  it("carries localAgentId from the message route to the dispatch", async () => {
    const res = await authed(`/api/threads/${dmId}/messages`, {
      content: "run this on my machine",
      localAgentId: AGENT,
    })
    expect(res.status).toBeLessThan(300)
    const posted = ((await res.json()) as { data: { id: string } }).data
    const audits = await skipAudits(posted.id)
    expect(audits).toHaveLength(1)
    expect(audits[0].agent_id).toBe(AGENT)
  })

  it("refuses a localAgentId that is not an agent id", async () => {
    const res = await authed(`/api/threads/${dmId}/messages`, {
      content: "hello",
      localAgentId: "not-a-uuid",
    })
    expect(res.status).toBe(400)
  })
})
