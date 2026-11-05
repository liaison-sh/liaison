// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `enqueueJob({ dedupe: true })`: a resumed mail sync re-runs the envelope
// triggers of a message it had already stored, and must not queue the same
// client job twice (design audit 2026-09-30, #3 review).

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { enqueueJob } from "~/modules/mailbox-jobs/service"

let orgId: string
let userId: string

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  ;[{ id: orgId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Job dedupe', ${`job-dedupe-${suffix}`}) RETURNING id`),
  )
  ;[{ id: userId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`j-${suffix}@x.example`}, 'J', 'active', 'h')
      RETURNING id`),
  )
})

describe("client job dedupe", () => {
  it("returns the existing job for an identical dedupe enqueue, and queues distinct ones", async () => {
    const input = {
      kind: "triage_label",
      payload: { ruleId: "r1", messageIds: ["00000000-0000-0000-0000-000000000001"] },
      dedupe: true,
    }
    const enqueue = (overrides: Record<string, unknown> = {}) =>
      withSystemDb("job-dedupe-test", (tx) =>
        enqueueJob(tx as never, userId, orgId, { ...input, ...overrides }),
      )
    const first = await enqueue()
    expect((await enqueue()).jobId).toBe(first.jobId)
    const other = await enqueue({
      payload: { ruleId: "r1", messageIds: ["00000000-0000-0000-0000-000000000002"] },
    })
    expect(other.jobId).not.toBe(first.jobId)
    // Without dedupe the queue behaves as before.
    expect((await enqueue({ dedupe: false })).jobId).not.toBe(first.jobId)
  })
})
