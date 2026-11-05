// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { listMessages, sendMessage } from "~/modules/threads/message"

const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async () => {}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async () => {}
    return fn(tx)
  })
}

const ORG = "00000000-0000-0000-0000-000000000091"
const USER = "00000000-0000-0000-0000-000000000092"
let threadId: string

describe("listMessages metadata projection", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'MetaOrg', 'meta-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'meta@t.com', 'Meta') ON CONFLICT (id) DO NOTHING`
    await sql`SELECT setval('kernel.thread_handle_seq', 900, false)`
    const [t] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'thread-900', 'Meta Test', ${USER})
      RETURNING id
    `
    threadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${threadId}, ${ORG})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
  })

  it("listMessages response includes metadata field on each message", async () => {
    await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER,
      threadId,
      content: "Hello",
      requiredScopes: [],
    })
    const result = await listMessages(rlsDb, { orgId: ORG, userId: USER, threadId, limit: 10 })
    expect(result).not.toBeNull()
    expect(Array.isArray(result!.messages)).toBe(true)
    expect(result!.messages.length).toBeGreaterThan(0)
    for (const msg of result!.messages) {
      expect("metadata" in msg).toBe(true)
    }
  })
})
