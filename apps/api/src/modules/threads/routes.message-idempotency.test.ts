// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A RETRIED MESSAGE POST IS APPLIED ONCE (A27, S11).
//
// A client that lost the answer to `POST /threads/:id/messages` (a network
// blip) sends it again with the same `correlationId`. The server answers with
// the message it already wrote: one row, one agent dispatch. The posts carry
// `localAgentId`, so every dispatch leaves one sender-local audit row: that row
// count is the dispatch spy, with no agent turn ever started.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { DISPATCH_SKIPPED_SENDER_LOCAL } from "~/modules/threads/posted-message-dispatch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const OTHER_USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let token: string
let otherToken: string
let dmId: string
let otherThreadId: string

const post = (threadId: string, body: Record<string, unknown>) =>
  app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ localAgentId: AGENT, ...body }),
  })

const userRows = (threadId: string, content: string) =>
  sql<{ id: string }[]>`
    SELECT id FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'user' AND content = ${content}`

const dispatches = (messageId: string) =>
  sql`SELECT id FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = ${DISPATCH_SKIPPED_SENDER_LOCAL} AND entity_id = ${messageId}`

const corr = () => `pending-${crypto.randomUUID()}`

describe("POST /threads/:id/messages with a correlationId", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Idem Org', ${`idem-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`idem-${tag}@t.com`}, 'Idem User')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', ${`@idem-${tag}`}, 'Idem', NULL, '[]'::jsonb)`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Idem User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/threads/dm", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT }),
    })
    expect(res.status).toBe(201)
    dmId = ((await res.json()) as { data: { id: string } }).data.id
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, ${`idem-other-${tag}`}, 'Other', ${USER}) RETURNING id`
    otherThreadId = t!.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${otherThreadId}, ${USER}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${otherThreadId}, ${ORG})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER}, ${ORG}, ${`idem-other-${tag}@t.com`}, 'Other Idem User')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${otherThreadId}, ${OTHER_USER}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${OTHER_USER}, ${otherThreadId}, ${ORG})`
    otherToken = await signAccessToken(
      {
        userId: OTHER_USER,
        orgId: ORG,
        name: "Other Idem User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
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

  it("a retried post with the same correlationId creates one message and dispatches one turn", async () => {
    const correlationId = corr()
    const first = await post(dmId, { content: "retry me", correlationId })
    expect(first.status).toBe(200)
    const firstBody = ((await first.json()) as { data: Record<string, unknown> }).data
    const second = await post(dmId, { content: "retry me", correlationId })
    expect(second.status).toBe(200)
    const secondBody = ((await second.json()) as { data: Record<string, unknown> }).data
    expect(secondBody.id).toBe(firstBody.id)
    // The replay answers in the first post's shape.
    expect(Object.keys(secondBody).sort()).toEqual(Object.keys(firstBody).sort())
    expect(secondBody).toMatchObject({
      threadId: dmId,
      authorId: USER,
      authorName: "Idem User",
      content: "retry me",
      threadType: firstBody.threadType,
      attachments: [],
    })
    expect(await userRows(dmId, "retry me")).toHaveLength(1)
    expect(await dispatches(firstBody.id as string)).toHaveLength(1)
  })

  it("the same correlationId with different content answers 422 and writes nothing", async () => {
    const correlationId = corr()
    const first = await post(dmId, { content: "original", correlationId })
    expect(first.status).toBe(200)
    const second = await post(dmId, { content: "something else", correlationId })
    expect(second.status).toBe(422)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    )
    expect(await userRows(dmId, "something else")).toHaveLength(0)
    expect(await userRows(dmId, "original")).toHaveLength(1)
  })

  it("concurrent duplicates create one message", async () => {
    const correlationId = corr()
    const [a, b] = await Promise.all([
      post(dmId, { content: "at once", correlationId }),
      post(dmId, { content: "at once", correlationId }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const idA = ((await a.json()) as { data: { id: string } }).data.id
    const idB = ((await b.json()) as { data: { id: string } }).data.id
    expect(idA).toBe(idB)
    expect(await userRows(dmId, "at once")).toHaveLength(1)
    expect(await dispatches(idA)).toHaveLength(1)
  })

  it("a post without correlationId is never deduplicated", async () => {
    expect((await post(dmId, { content: "no key" })).status).toBe(200)
    expect((await post(dmId, { content: "no key" })).status).toBe(200)
    expect(await userRows(dmId, "no key")).toHaveLength(2)
  })

  it("the key is scoped by thread: the same correlationId in another thread is a new message", async () => {
    const correlationId = corr()
    const a = await post(dmId, { content: "same words", correlationId })
    const b = await post(otherThreadId, { content: "same words", correlationId })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const idA = ((await a.json()) as { data: { id: string } }).data.id
    const idB = ((await b.json()) as { data: { id: string } }).data.id
    expect(idA).not.toBe(idB)
  })

  it("two people posting the same correlationId and words in one thread each get their own message", async () => {
    const correlationId = corr()
    const mine = await post(otherThreadId, { content: "same from both", correlationId })
    const theirs = await app.request(`/api/threads/${otherThreadId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ localAgentId: AGENT, content: "same from both", correlationId }),
    })
    expect(mine.status).toBe(200)
    expect(theirs.status).toBe(200)
    const a = ((await mine.json()) as { data: { id: string; authorId: string } }).data
    const b = ((await theirs.json()) as { data: { id: string; authorId: string } }).data
    expect(a.id).not.toBe(b.id)
    expect(a.authorId).toBe(USER)
    expect(b.authorId).toBe(OTHER_USER)
    expect(await userRows(otherThreadId, "same from both")).toHaveLength(2)
  })

  it("a post refused before its commit frees the key: the corrected retry is written", async () => {
    const correlationId = corr()
    const refused = await post(dmId, {
      content: "nested",
      correlationId,
      parentMessageId: crypto.randomUUID(),
    })
    expect(refused.status).toBe(404)
    // Same key, other payload: accepted, because the refused post wrote nothing
    // and kept nothing.
    const ok = await post(dmId, { content: "nested", correlationId })
    expect(ok.status).toBe(200)
    expect(await userRows(dmId, "nested")).toHaveLength(1)
  })
})
