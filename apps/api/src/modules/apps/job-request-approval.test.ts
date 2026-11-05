// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A scheduled job can ASK for approval (ctx.requestApproval) for one of its own app's tools: the
// request is filed under a real org user (the one the app names when active, else the org's
// earliest active user), carries the tool's declared expiry, and is never decided by the job.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalExpiryRegistry } from "~/modules/apps/app-registries"
import { buildJobBridge } from "~/modules/apps/runtime"

const ORG = randomUUID()
const FIRST = randomUUID()
const ADMIN = randomUUID()
const GONE = randomUUID()
const APP = "jobapp"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Job Approval Org', ${`ja-${ORG.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, created_at) VALUES
    (${FIRST}, ${ORG}, ${`first-${ORG.slice(0, 8)}@test.com`}, 'First', 'active', now() - interval '2 days'),
    (${ADMIN}, ${ORG}, ${`admin-${ORG.slice(0, 8)}@test.com`}, 'Admin', 'active', now()),
    (${GONE}, ${ORG}, ${`gone-${ORG.slice(0, 8)}@test.com`}, 'Gone', 'deactivated', now() - interval '3 days')`
  approvalExpiryRegistry.set([ORG, APP, "book_batch"], 24)
})

afterAll(async () => {
  approvalExpiryRegistry.delete([ORG, APP, "book_batch"])
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

async function ask(input: Record<string, unknown>): Promise<{ approval_id?: string } | Error> {
  return withPrivilegedDb(ORG, "test", async (tx) => {
    const bridge = buildJobBridge(APP, `system:${APP}:daily`, ORG, { _tx: tx }, manifest, [
      `${APP}:*`,
    ])
    return JSON.parse(await bridge.requestApproval(JSON.stringify(input))) as {
      approval_id?: string
    }
  }).catch((e: Error) => e)
}

describe("job approval requests", () => {
  it("files the request under the named active user, with the tool's expiry, pending", async () => {
    const out = await ask({
      tool_name: `${APP}:book_batch`,
      summary: "Book 3 documents",
      current_payload: { document_ids: ["a", "b", "c"] },
      on_behalf_of: ADMIN,
    })
    const id = (out as { approval_id: string }).approval_id
    expect(id).toBeTruthy()
    const [row] = await sql<
      Array<{ requested_by: string; status: string; tool_name: string; hours: number }>
    >`
      SELECT requested_by::text, status, tool_name, round(extract(epoch from (expires_at - created_at)) / 3600)::int AS hours
      FROM kernel.approval_requests WHERE id = ${id}`
    expect(row).toEqual({
      requested_by: ADMIN,
      status: "pending",
      tool_name: `${APP}:book_batch`,
      hours: 24,
    })
  })

  it("falls back to the earliest ACTIVE user when the named one is not active", async () => {
    const out = await ask({
      tool_name: `${APP}:book_batch`,
      summary: "s",
      current_payload: {},
      on_behalf_of: GONE,
    })
    const [row] = await sql<Array<{ requested_by: string }>>`
      SELECT requested_by::text FROM kernel.approval_requests WHERE id = ${(out as { approval_id: string }).approval_id}`
    expect(row!.requested_by).toBe(FIRST)
  })

  it("refuses a request for another app's tool", async () => {
    const out = await ask({ tool_name: "otherapp:send", summary: "s", current_payload: {} })
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toContain("own app's tools")
  })
})
