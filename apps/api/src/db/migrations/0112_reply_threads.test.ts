// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1, A19, A2: 0112 gives kernel.messages a reply root that can only name a
// message of the SAME thread, and adds kernel.reply_thread_followers under
// FORCE RLS, whose insert policy only admits a follower who is a member of the
// root's thread. Read against the live, migrated schema.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as d } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const ROOM = crypto.randomUUID()
const OTHER_ROOM = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let rootId: string
let otherRoomMsg: string

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ""
  } catch (err) {
    // drizzle wraps the driver error; the SQLSTATE sits on its cause.
    const e = err as { code?: string; cause?: { code?: string } }
    return String(e.code ?? e.cause?.code ?? err)
  }
}

describe("0112 reply threads", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'RT Org', ${`rt-${tag}`})`
    for (const [id, name] of [
      [MEMBER, "member"],
      [OUTSIDER, "outsider"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${`rt-${name}-${tag}@t.com`}, ${name})`
    }
    for (const id of [ROOM, OTHER_ROOM]) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by) VALUES (${id}, ${ORG}, ${`rt-${id.slice(0, 8)}`}, 'Room', ${MEMBER})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${id}, ${MEMBER}, ${ORG})`
    }
    const [root] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${ROOM}, ${ORG}, ${MEMBER}, 'root', '{}') RETURNING id`
    rootId = root.id
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${OTHER_ROOM}, ${ORG}, ${MEMBER}, 'elsewhere', '{}') RETURNING id`
    otherRoomMsg = other.id
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.reply_thread_followers WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a reply names a root of its own thread, and a root of another thread is refused", async () => {
    const [reply] = await sql<{ reply_root_id: string; also_in_channel: boolean }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, reply_root_id)
      VALUES (${ROOM}, ${ORG}, ${MEMBER}, 'a reply', '{}', ${rootId})
      RETURNING reply_root_id, also_in_channel`
    expect(reply.reply_root_id).toBe(rootId)
    expect(reply.also_in_channel).toBe(false)
    const code = await refusal(
      () => sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, reply_root_id)
        VALUES (${ROOM}, ${ORG}, ${MEMBER}, 'cross', '{}', ${otherRoomMsg})`,
    )
    expect(code).toBe("23503")
  })

  it("also_in_channel needs a root", async () => {
    const code = await refusal(
      () => sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, also_in_channel)
        VALUES (${ROOM}, ${ORG}, ${MEMBER}, 'flag alone', '{}', true)`,
    )
    expect(code).toBe("23514")
  })

  it("the followers table is FORCE RLS, and only a member of the room can be made a follower", async () => {
    const [flags] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'kernel.reply_thread_followers'::regclass`
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true })

    const member = {
      actorType: "user" as const,
      userId: MEMBER,
      orgId: ORG,
      scopes: ["kernel:threads:read"],
      dimensionGrants: {},
    }
    await withRlsContext(member, (tx) =>
      tx.execute(d`INSERT INTO kernel.reply_thread_followers (root_message_id, thread_id, user_id, org_id)
        VALUES (${rootId}, ${ROOM}, ${MEMBER}, ${ORG})`),
    )
    const outsiderCode = await refusal(() =>
      withRlsContext(member, (tx) =>
        tx.execute(d`INSERT INTO kernel.reply_thread_followers (root_message_id, thread_id, user_id, org_id)
          VALUES (${rootId}, ${ROOM}, ${OUTSIDER}, ${ORG})`),
      ),
    )
    expect(outsiderCode).toBe("42501")
    const rows =
      await sql`SELECT user_id FROM kernel.reply_thread_followers WHERE root_message_id = ${rootId}`
    expect(rows.map((r) => r.user_id)).toEqual([MEMBER])
  })

  it("a follower row cannot claim a thread other than its root's", async () => {
    const code = await refusal(
      () => sql`INSERT INTO kernel.reply_thread_followers (root_message_id, thread_id, user_id, org_id)
        VALUES (${rootId}, ${OTHER_ROOM}, ${OUTSIDER}, ${ORG})`,
    )
    expect(code).toBe("23503")
  })
})
