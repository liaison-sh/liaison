// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D2: the route behind the withheld card's "Share anyway".
//
// The card is private to the requester, so the route is too: only the member
// whose turn withheld may rerun it, the rerun runs with write tools disabled
// (share-anyway.ts owns that), and an item a rerun could not lift (a
// scope-taint refusal) is refused here with a reason rather than rerun for
// nothing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "Shared answer" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ORG = crypto.randomUUID()
const REQUESTER = crypto.randomUUID()
const OTHER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const ROLE = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const CEILING = "wshare:alpha:read"

let requesterToken: string
let otherToken: string
let turnId: string
let replyId: string
let taintedReplyId: string

async function plantTurn(items: unknown[]): Promise<{ turnId: string; replyId: string }> {
  const [turn] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${ROOM}, ${ORG}, ${REQUESTER}, 'user', 'what do the payouts say', '{}'::text[])
    RETURNING id`
  const metadata = {
    modelId: "test-model",
    withheld: { requesterId: REQUESTER, turnId: turn.id, items },
  }
  const [reply] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
    VALUES (${ROOM}, ${ORG}, ${REQUESTER}, 'agent', ${AGENT}, 'I left some out', ${JSON.stringify(metadata)}::jsonb, '{}'::text[])
    RETURNING id`
  return { turnId: turn.id, replyId: reply.id }
}

const shareAnywayPath = (messageId: string) =>
  `/api/threads/${ROOM}/messages/${messageId}/share-anyway`

describe("POST /api/threads/:threadId/messages/:messageId/share-anyway", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'SA Org', ${`sa-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REQUESTER}, ${ORG}, ${`sa-req-${tag}@t.com`}, 'Requester')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER}, ${ORG}, ${`sa-oth-${tag}@t.com`}, 'Other')`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, ${`sa-role-${tag}`}, 'all')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, '*')`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${REQUESTER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${OTHER}, ${ROLE}, ${ORG})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@sa-${tag}`}, 'SA Agent', ${REQUESTER}, ${`["${CEILING}"]`}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${ROOM}, ${ORG}, ${`sa-room-${tag}`}, 'thread', ${REQUESTER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${REQUESTER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${OTHER}, ${ORG})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${`claude-haiku-sa-${tag}`}, 'Claude Haiku SA', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"

    const planted = await plantTurn([{ label: "a capability", scopeName: CEILING }])
    turnId = planted.turnId
    replyId = planted.replyId
    taintedReplyId = (
      await plantTurn([{ label: "a capability", scopeName: CEILING, scopeTainted: true }])
    ).replyId

    const claims = { authVersion: 1, permissionVersion: 1, scopes: ["*"] }
    requesterToken = await signAccessToken(
      { userId: REQUESTER, orgId: ORG, name: "Requester", ...claims },
      env.JWT_SECRET,
    )
    otherToken = await signAccessToken(
      { userId: OTHER, orgId: ORG, name: "Other", ...claims },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("another member of the room cannot share the requester's withheld turn", async () => {
    const res = await app.request(shareAnywayPath(replyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  it("a scope-taint item is refused with a reason, never rerun", async () => {
    const res = await app.request(shareAnywayPath(taintedReplyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${requesterToken}`, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(JSON.stringify(body)).toContain("E_SCOPE_TAINT_BLOCKED")
  })

  it("the requester reruns the turn and the disclosure is recorded", async () => {
    const res = await app.request(shareAnywayPath(replyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${requesterToken}`, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const ids: string[] = body?.data?.messageIds ?? body?.messageIds
    expect(Array.isArray(ids)).toBe(true)
    expect(ids.length).toBeGreaterThan(0)
    const rows = await sql<{ action: string; disclosure_list: string[] | null }[]>`
      SELECT a.action, m.disclosure_list
      FROM kernel.audit_log a, kernel.messages m
      WHERE a.org_id = ${ORG} AND a.action = 'share_anyway' AND m.id = ${ids[0]}`
    expect(rows.length).toBe(1)
    expect(rows[0].disclosure_list?.sort()).toEqual([REQUESTER, OTHER].sort())
    expect(turnId).toBeTruthy()
  })

  it("pressing Share anyway again returns the same messages, never a second answer", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${ROOM} AND disclosure_list IS NOT NULL`
    const res = await app.request(shareAnywayPath(replyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${requesterToken}`, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const ids: string[] = body?.data?.messageIds ?? body?.messageIds
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${ROOM} AND disclosure_list IS NOT NULL ORDER BY created_at`
    expect(ids.sort()).toEqual(existing.map((m) => m.id).sort())
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${ROOM} AND disclosure_list IS NOT NULL`
    expect(after[0].n).toBe(before[0].n)
    // One disclosure, one audit row: a second press records nothing new.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = 'share_anyway'`
    expect(n).toBe(1)
  })
})
