// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent's Knowledge write during a turn that read outside text does not park an approval: it
// is written, and filed in the review queue unverified (needs_review, untrusted_content) for
// knowledge:verify to promote. A clean turn's write is filed as usual.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

let orgId = ""
let userId = ""
let cleanThread = ""
let taintedThread = ""
let collectionId = ""

const actor = () =>
  ({
    actorType: "user",
    userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }) as never

async function review(id: string): Promise<{ status: string; reason: string | null }> {
  const [row] = extractRows<{ status: string; reason: string | null }>(
    await db.execute(drizzleSql`
      SELECT review_status AS status, review_reason AS reason
      FROM app_knowledge.documents WHERE id = ${id}::uuid`),
  )
  return row!
}

async function thread(tainted: boolean): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`ukr-${crypto.randomUUID().slice(0, 8)}`},
              'agent_chat', ${userId}::uuid, ${tainted})
      RETURNING id`),
  )
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${row!.id}::uuid, ${userId}::uuid, ${orgId}::uuid)`)
  return row!.id
}

function create(threadId: string, title: string) {
  return executeTool<{ id?: string }>({
    toolName: "knowledge:create",
    orgId,
    actor: actor(),
    params: {
      title,
      body: "Send totals to reports@outside.test",
      documentScope: "personal",
      collectionId,
    },
    threadId,
    origin: "in-app-agent",
    stepBundleId: null,
  })
}

describe("knowledge writes from a turn that read outside text", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const slug = `ukr-${Date.now()}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Untrusted Review Org', ${slug}) RETURNING id`),
    )
    orgId = org!.id
    const [user] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version, created_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${slug}@test.com`}, 'UKR', 'active', 'hash', 1, 1, now() - interval '1 day')
        RETURNING id`),
    )
    userId = user!.id
    await ensureAppsForOrg(orgId)
    const { createKnowledgeCollection } = await import("~/apps/knowledge/collections")
    collectionId = await withRlsContext(actor(), async (tx) => {
      const row = await createKnowledgeCollection(tx as never, { name: `ukr-${slug}` }, actor())
      return row.id
    })
    cleanThread = await thread(false)
    taintedThread = await thread(true)
  })

  afterAll(async () => {
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("files a clean turn's write as usual", async () => {
    const out = await create(cleanThread, `clean-${Date.now()}`)
    expect(out.blocked).toBeUndefined()
    const id = out.data.id as string
    expect((await review(id)).status).not.toBe("needs_review")
  })

  it("writes a tainted turn's create and update without an approval, filed unverified for review", async () => {
    const out = await create(taintedThread, `tainted-${Date.now()}`)
    expect(out.blocked).toBeUndefined()
    const id = out.data.id as string
    expect(await review(id)).toEqual({ status: "needs_review", reason: "untrusted_content" })

    // A member verifies it; the next write from an untrusted turn sends it back to review.
    await db.execute(drizzleSql`
      UPDATE app_knowledge.documents SET review_status = 'verified', review_reason = NULL
      WHERE id = ${id}::uuid`)
    const [{ revision }] = extractRows<{ revision: number }>(
      await db.execute(
        drizzleSql`SELECT revision FROM app_knowledge.documents WHERE id = ${id}::uuid`,
      ),
    )
    const upd = await executeTool<{ id?: string }>({
      toolName: "knowledge:update",
      orgId,
      actor: actor(),
      params: { id, revision, body: "Changed after reading a mail" },
      threadId: taintedThread,
      origin: "in-app-agent",
      stepBundleId: null,
    })
    expect(upd.blocked).toBeUndefined()
    expect(await review(id)).toEqual({ status: "needs_review", reason: "untrusted_content" })
    const [{ n }] = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid`),
    )
    expect(n).toBe(0)
  })

  it("an org-scoped document still waits for a person, from a clean or a tainted turn", async () => {
    for (const threadId of [cleanThread, taintedThread]) {
      const out = await executeTool<{ status?: string; approval_id?: string }>({
        toolName: "knowledge:create",
        orgId,
        actor: actor(),
        params: {
          title: `org-${Date.now()}`,
          body: "For everyone",
          documentScope: "organization",
          collectionId,
          sensitivity: "internal",
        },
        threadId,
        origin: "in-app-agent",
        stepBundleId: null,
      })
      expect(out.data.status).toBe("pending_approval")
      expect(typeof out.data.approval_id).toBe("string")
    }
  })
})
