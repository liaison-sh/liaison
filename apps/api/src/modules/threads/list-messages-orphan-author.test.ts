// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-FX10b defect 4: the hidden-runs window read must count exactly the rows
// the page query would show if the viewer could see them.
//
// The page query INNER JOINs `kernel.users` to resolve the author's name, so a
// message whose author row is gone is absent from the page for EVERY viewer.
// T14's privileged window read had no such join, so that same row was still
// counted, and the viewer was told a message was hidden from them at a
// position where in truth the thread shows nothing to anyone. That is both a
// wrong signal and a small leak: it advertises the existence of a scoped
// message the product would never render.
//
// `kernel.messages.author_id` carries no FK to `kernel.users` (checked against
// the live schema: the only FKs are org_id and thread_id), so an author row
// really can be gone while its messages remain.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SECRET = "loa:deals:read"
const ORG = crypto.randomUUID()
const VIEWER = crypto.randomUUID()
const HOLDER = crypto.randomUUID()
const GHOST = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let threadId: string
// m1 open, m2 scoped + authored by the ghost, m3 open, m4 scoped + live
// author, m5 open. Ids in thread order.
const ids: string[] = []
const m = (n: number) => ids[n - 1]

const ctx = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

async function list(userId: string, scopes: string[], limit = 50) {
  return withRlsContext(ctx(userId, scopes), (tx) =>
    listMessages(tx, { orgId: ORG, userId, threadId, limit }),
  )
}

async function plant(seq: number, content: string, authorId: string, scopes: string[]) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
    VALUES (
      ${threadId}, ${ORG}, ${authorId}, 'user', ${content}, ${scopes}::text[],
      ${`2026-03-01T00:00:0${seq}Z`}::timestamptz
    )
    RETURNING id`
  ids.push(row.id)
}

describe("listMessages hidden runs ignore a message whose author row is gone (FX10b)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Orphan Org', ${`loa-${tag}`})`
    for (const [id, name] of [
      [VIEWER, "viewer"],
      [HOLDER, "holder"],
      [GHOST, "ghost"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`loa-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, ${`loa-${tag}`}, 'Orphan author', ${VIEWER}) RETURNING id`
    threadId = t.id
    for (const userId of [VIEWER, HOLDER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${userId}, ${ORG})`
    }

    await plant(1, "kickoff", VIEWER, [])
    await plant(2, "ghost wrote about deal 42", GHOST, [SECRET])
    await plant(3, "thanks", VIEWER, [])
    await plant(4, "deal 42 margin is thin", VIEWER, [SECRET])
    await plant(5, "wrapping up", VIEWER, [])

    // The author is erased; the message row stays behind.
    await sql`DELETE FROM kernel.users WHERE id = ${GHOST}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a message with no author row is reported as hidden to nobody", async () => {
    const result = await list(VIEWER, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    expect(result!.messages.map((x: { content: string | null }) => x.content)).toEqual([
      "wrapping up",
      "thanks",
      "kickoff",
    ])
    // Only m4 is genuinely hidden from this viewer. m2 is shown to no one, so
    // it must not appear as a run: before the fix the window also counted it
    // and the viewer got an extra `{ afterMessageId: m1, count: 1 }`.
    expect(result!.hiddenRuns).toEqual([{ afterMessageId: m(3), count: 1 }])
  })

  it("the orphaned row reaches nobody's page, so it opens no run for a scope holder either", async () => {
    const result = await list(HOLDER, ["kernel:threads:read", SECRET])
    expect(result).not.toBeNull()
    // m2 is dropped by the page query's join even for a viewer holding SECRET.
    expect(result!.messages.map((x: { id: string }) => x.id)).toEqual([m(5), m(4), m(3), m(1)])
    expect(result!.hiddenRuns).toEqual([])
    expect(JSON.stringify(result)).not.toContain("ghost wrote")
  })

  it("a hidden run still reports a scoped message whose author is alive", async () => {
    // The control: the fix must not silence real runs.
    const result = await list(VIEWER, ["kernel:threads:read"])
    expect(result!.hiddenRuns).toHaveLength(1)
    expect(result!.hiddenRuns[0]).toEqual({ afterMessageId: m(3), count: 1 })
    expect(JSON.stringify(result)).not.toContain("deal 42")
  })
})
