// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge moves the merged company's discussion messages into the
// survivor's discussion. Their search documents still name the old thread, so
// the merge event re-indexes every message of the survivor's discussion. Here
// the merge runs for real, its committed event goes through the durable
// consumers, and the live index queue is read back.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import * as jobsModule from "~/infra/jobs/jobs"
import { createCompany, mergeCompanies } from "~/modules/contacts/companies"
import { LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import {
  messageLiveIndexItem,
  registerMessageIndexerConsumer,
} from "~/modules/search/message-indexer"

const ORG = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
  "kernel:threads:read",
]
const anna: UserContext = {
  actorType: "user",
  userId: ANNA,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}
const spies: Array<{ mockRestore: () => void }> = []

async function company(name: string): Promise<string> {
  const { company: row } = await withRlsContext(anna, (tx) =>
    createCompany(tx, { orgId: ORG, userId: ANNA, input: { name } }),
  )
  return row.id
}

/** The company's discussion thread with one message; returns the message id. */
async function discussionWithMessage(companyId: string, text: string): Promise<string> {
  const thread = crypto.randomUUID()
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, hidden_from_list, created_by)
    VALUES (${thread}, ${ORG}, ${`entity:kernel:company:${companyId}`}, 'thread', true, ${ANNA})`
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${thread}, ${ORG}, ${ANNA}, ${text}, '{}'::text[])
    RETURNING id::text`
  return String(row?.id)
}

beforeAll(async () => {
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation((() => {}) as never))
  await LiveIndexTestAccess.clear()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'CompanyDiscussionReindex', ${`company-discussion-reindex-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${ANNA}, ${ORG}, ${`cdr-anna-${tag}@test.com`}, 'Anna', 'x')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await LiveIndexTestAccess.clear()
  DurableConsumersTestAccess.reset()
  for (const s of spies) s.mockRestore()
})

describe("a company merge re-indexes the discussion it moved", () => {
  it("every message of the survivor's discussion, moved or its own, is queued for re-indexing", async () => {
    const source = await company("Lumen Studio")
    const target = await company("Lumen Studios")
    const moved = await discussionWithMessage(source, "Asked for the annual plan")
    const own = await discussionWithMessage(target, "Renewal due in March")

    const result = await withRlsContext(anna, (tx) =>
      mergeCompanies(tx, { orgId: ORG, userId: ANNA, sourceId: source, targetId: target }),
    )
    expect(result.discussionMoved).toBe(true)

    const [event] = await sql<{ id: string; data: unknown }[]>`
      SELECT id::text, payload -> 'data' AS data FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload ->> 'app' = 'kernel'
         AND payload ->> 'entity' = 'company' AND payload ->> 'action' = 'merge'
       ORDER BY seq DESC LIMIT 1`
    expect(event).toBeDefined()
    await LiveIndexTestAccess.clear()
    DurableConsumersTestAccess.reset()
    registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: String(event?.id),
      event: {
        app: "kernel",
        entity: "company",
        action: "merge",
        entityId: target,
        orgId: ORG,
        data: event?.data,
      },
    })

    const queued = (await LiveIndexTestAccess.pendingItems()).map((i) => i.key).sort()
    const expected = [moved, own]
      .map((messageId) => messageLiveIndexItem({ action: "upsert", orgId: ORG, messageId }).key)
      .sort()
    expect(queued).toEqual(expected)
  })
})
