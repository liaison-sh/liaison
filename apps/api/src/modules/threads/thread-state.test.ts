// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { updateThreadState } from "~/modules/threads/thread-state"

const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async () => {}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async () => {}
    return fn(tx)
  })
}

const ORG_ID = "00000000-0000-0000-0000-000000007001"
const USER_ID = "00000000-0000-0000-0000-000000007002"
let THREAD_ID: string

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'StateTestOrg', 'state-test-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'state-test@test.com', 'StateUser') ON CONFLICT DO NOTHING`
  const [thread] =
    await sql`INSERT INTO kernel.threads (org_id, handle, title, created_by) VALUES (${ORG_ID}, 'state-test-thread', 'Test Thread', ${USER_ID}) RETURNING id`
  THREAD_ID = thread.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("updateThreadState", () => {
  it("writes and announces nothing when no state fields are provided (no-op)", async () => {
    const result = await updateThreadState(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
    })
    expect(result).toEqual({ state: null })
  })

  it("updates isArchived when provided", async () => {
    const result = await updateThreadState(rlsDb, {
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      isArchived: true,
    })
    expect(result?.state?.isArchived).toBe(true)
  })
})
