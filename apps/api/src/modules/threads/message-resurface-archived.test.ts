// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A new message brings an archived conversation back to its members' lists.
//
// Archiving used to take a thread out of the member's list for good: a channel
// they had archived kept receiving messages (from colleagues and from agents)
// and never showed again, so they found it only through a link. Now a new
// channel line by a person OR an agent clears the archive flag of every member
// who had archived it, except a member who also muted it, and tells that
// member's devices (`thread_state`, isArchived false) so the list reloads live.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { sendMessage } from "~/modules/threads/message"
import { seedMessageRow } from "~/seed/factories/threads/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let authorId: string
let authorToken: string
let memberId: string
let memberToken: string

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function setState(token: string, threadId: string, body: Record<string, boolean>) {
  const res = await app.request(`/api/threads/${threadId}/state`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
}

/** The thread ids in the member's own sidebar list (or archived view). */
async function memberList(archived = false): Promise<string[]> {
  const res = await app.request(`/api/threads?limit=100${archived ? "&archived=true" : ""}`, {
    headers: headers(memberToken),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: Array<{ id: string }> }
  return body.data.map((t) => t.id)
}

async function postAsPerson(threadId: string, content: string): Promise<string> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: headers(authorToken),
    body: JSON.stringify({ content }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** The `thread_state` frames queued for one user on one thread, as the outbox holds them. */
async function stateFrames(
  userId: string,
  threadId: string,
): Promise<Array<{ isArchived: boolean }>> {
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId}
      AND payload->>'entity' = 'read_state'
      AND payload->'data'->>'kind' = 'thread_state'
      AND payload->'data'->>'forUserId' = ${userId}
      AND payload->'data'->>'threadId' = ${threadId}`
  return rows.map((r) => {
    const p = (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as {
      data: { isArchived: boolean }
    }
    return p.data
  })
}

async function archivedThread(opts: { muted?: boolean } = {}): Promise<string> {
  const threadId = await minimal.thread(orgId, authorId, { participantIds: [memberId] })
  await setState(memberToken, threadId, {
    isArchived: true,
    ...(opts.muted ? { isMuted: true } : {}),
  })
  expect(await memberList()).not.toContain(threadId)
  return threadId
}

describe("a new message resurfaces a thread its member archived", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    const author = await minimal.session(orgId)
    const member = await minimal.session(orgId)
    authorId = author.userId
    memberId = member.userId
    authorToken = author.bearer
    memberToken = member.bearer
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a person's message puts it back in the member's list and tells their devices", async () => {
    const threadId = await archivedThread()
    await postAsPerson(threadId, "new news in here")

    expect(await memberList()).toContain(threadId)
    expect(await memberList(true)).not.toContain(threadId)
    expect(await stateFrames(memberId, threadId)).toEqual([
      expect.objectContaining({ isArchived: false }),
    ])
  })

  it("an agent's message does the same, on a request transaction", async () => {
    const threadId = await archivedThread()
    const actor: UserContext = {
      actorType: "user",
      userId: authorId,
      orgId,
      scopes: ["kernel:threads:read", "kernel:threads:write"],
      dimensionGrants: {},
    }
    await withRlsContext(actor, (tx) =>
      sendMessage(tx, {
        orgId,
        userId: authorId,
        threadId,
        content: "a summary from the agent",
        authorType: "agent",
        agentAuthorLabel: "Author's agent",
        requiredScopes: [],
      }),
    )
    expect(await memberList()).toContain(threadId)
  })

  it("an agent's message does the same, on a privileged transaction", async () => {
    const threadId = await archivedThread()
    await withPrivilegedDb(orgId, "test-resurface-agent", (tx) =>
      sendMessage(tx as never, {
        orgId,
        userId: authorId,
        threadId,
        content: "a routine's post",
        authorType: "agent",
        agentAuthorLabel: "Routine digest",
        requiredScopes: [],
      }),
    )
    expect(await memberList()).toContain(threadId)
  })

  it("a member who also muted the thread keeps it archived", async () => {
    const threadId = await archivedThread({ muted: true })
    await postAsPerson(threadId, "still quiet for you")
    expect(await memberList()).not.toContain(threadId)
    expect(await memberList(true)).toContain(threadId)
    expect(await stateFrames(memberId, threadId)).toEqual([])
  })

  it("a reply the channel does not show resurfaces nothing", async () => {
    const threadId = await archivedThread()
    // The root predates the archive: written straight into the table.
    const rootId = await seedMessageRow({
      threadId,
      orgId,
      authorId,
      authorType: "user",
      content: "root",
      requiredScopes: [],
    })
    await withRlsContext(
      {
        actorType: "user",
        userId: authorId,
        orgId,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        dimensionGrants: {},
      },
      (tx) =>
        sendMessage(tx, {
          orgId,
          userId: authorId,
          threadId,
          content: "a side reply",
          replyRootId: rootId,
          requiredScopes: [],
        }),
    )
    expect(await memberList()).not.toContain(threadId)
  })

  it("the database function does nothing for a transaction that wrote no message there", async () => {
    const threadId = await archivedThread()
    const changed = await withPrivilegedDb(orgId, "test-resurface-direct", (tx) =>
      tx.execute(drizzleSql`SELECT * FROM kernel.resurface_thread_for_members(${threadId}::uuid)`),
    )
    expect(Array.from(changed as unknown as unknown[])).toHaveLength(0)
    expect(await memberList()).not.toContain(threadId)
  })
})
