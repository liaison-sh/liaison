// SPDX-License-Identifier: FSL-1.1-ALv2
//
// threads_reply and threads_create's initial message may quote what the calling
// turn read. When the turn's taint is not on the frame, they fail closed like
// the sandbox bridge's messages.post: the frame's effective scope, then the
// caller's scopes, and a refusal (scope_unknown) when none is known. Never `[]`.
// The room here is a direct message (the author and one other person): since rule 14
// (2026-11-12) such a post is written with both of them on its disclosure list, so the person it
// addresses reads it whatever the stamp; the stamp itself is unchanged.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { handleThreadsCreate, handleThreadsReply } from "~/modules/agent/tools/chat-tools"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SECRET = "ctf:deals:read"
const ORG = crypto.randomUUID()
const AUTHOR = crypto.randomUUID()
const LACKER = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const CALLER_SCOPES = ["kernel:threads:write", SECRET]

const actor = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

function bareFrame(extra: Partial<RunContext> = {}): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

async function reply(content: string, ctxScopes: string[] | undefined, frame?: RunContext) {
  const call = () =>
    withRlsContext(actor(AUTHOR, CALLER_SCOPES), (tx) =>
      handleThreadsReply({ threadId: ROOM, content }, {
        userId: AUTHOR,
        orgId: ORG,
        db: tx,
        scopes: ctxScopes,
      } as never),
    )
  return frame ? runContextStore.run(frame, call) : call()
}

async function rowFor(content: string) {
  const [row] = await sql<{ id: string; required_scopes: string[] }[]>`
    SELECT id, required_scopes FROM kernel.messages WHERE org_id = ${ORG} AND content = ${content}`
  return row
}

async function visibleIds(userId: string, scopes: string[]): Promise<string[]> {
  return withRlsContext(actor(userId, scopes), async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE org_id = ${ORG}`),
    ).map((r) => r.id),
  )
}

describe("chat tools fail closed when the run frame's taint is lost", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'CTF Org', ${`ctf-${tag}`})`
    for (const [id, name] of [
      [AUTHOR, "Author"],
      [LACKER, "Lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
        VALUES (${id}, ${ORG}, ${`ctf-${name}-${tag}@test.com`}, ${name}, 'x', 'active')`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${ROOM}, ${ORG}, ${`ctf-room-${tag}`}, 'thread', ${AUTHOR})`
    for (const userId of [AUTHOR, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${ROOM}, ${userId}, ${ORG})`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("threads_reply with no frame is tagged with the caller's scopes, and its DM addressee reads it", async () => {
    const result = await reply("Deal 42 closes Friday (no frame)", CALLER_SCOPES)
    expect((result as { message?: unknown }).message).toBeDefined()
    const row = await rowFor("Deal 42 closes Friday (no frame)")
    expect(row?.required_scopes).toEqual([...CALLER_SCOPES].sort())
    expect(await visibleIds(LACKER, ["kernel:threads:read"])).toContain(row?.id)
    expect(await visibleIds(AUTHOR, CALLER_SCOPES)).toContain(row?.id)
  })

  it("threads_reply under a frame without an accumulator uses the frame's effective scope", async () => {
    await reply(
      "Deal 42 closes Friday (effective)",
      undefined,
      bareFrame({ effectiveScope: [SECRET] }),
    )
    const row = await rowFor("Deal 42 closes Friday (effective)")
    expect(row?.required_scopes).toEqual([SECRET])
    expect(await visibleIds(LACKER, ["kernel:threads:read"])).toContain(row?.id)
  })

  it("threads_reply refuses with scope_unknown when neither the frame nor the caller says", async () => {
    const result = await reply("Deal 42 closes Friday (unknown)", undefined, bareFrame())
    expect(JSON.stringify(result)).toContain("scope_unknown")
    expect(await rowFor("Deal 42 closes Friday (unknown)")).toBeUndefined()
  })

  it("threads_create's initial message with no frame is tagged with the caller's scopes", async () => {
    const result = await withRlsContext(actor(AUTHOR, CALLER_SCOPES), (tx) =>
      handleThreadsCreate(
        {
          participantIds: [LACKER],
          title: "ctf create",
          initialMessage: "Deal 42 closes Friday (create)",
          forceCreate: true,
        },
        { userId: AUTHOR, orgId: ORG, db: tx, scopes: CALLER_SCOPES } as never,
      ),
    )
    expect((result as { thread?: unknown }).thread).toBeDefined()
    const row = await rowFor("Deal 42 closes Friday (create)")
    expect(row?.required_scopes).toEqual([...CALLER_SCOPES].sort())
    expect(await visibleIds(LACKER, ["kernel:threads:read"])).toContain(row?.id)
  })
})
