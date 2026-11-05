// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A finding reads "awaiting approval" while an agent's staged reply to it is pending, derived at
// read time from the live approval, and its stored status again once the approval is denied or
// expires. The kernel gate parks an agent's `social:reply_to_finding` before the social handler
// runs, so nothing is written on the finding: findings_get / findings_list / counts overlay the
// pending request (its draft and id) on the row it targets, through `ctx.approvals.pendingFor`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { decide, ks, pollUntil } from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let url: string

interface FindingView {
  id: string
  status: string
  suggested_reply?: string | null
  approval_request_id?: string | null
}

beforeAll(async () => {
  ;({ env, world } = await setupScenario())
  url = env.serverUrl
  const install = await api(url, "/api/_test/social/install-for-test", {
    method: "POST",
    token: world.admin.token,
    body: { orgId: world.org.id },
  })
  expect(install.status, JSON.stringify(install.body)).toBe(200)
  await api(url, "/api/_test/social/mock/reset", { method: "POST", token: world.admin.token })
}, 120_000)

afterAll(async () => {
  await teardownScenario(env, world)
})

async function tool<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const res = await api(url, `/api/apps/social/tools/${name}`, {
    method: "POST",
    token: world.admin.token,
    body: { params },
  })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body as { data: T }).data
}

const getFinding = async (id: string) =>
  (await tool<{ finding: FindingView | null }>("findings_get", { finding_id: id })).finding!

async function seedFinding(): Promise<string> {
  const seeded = await api(url, "/api/_test/social/seed-finding", {
    method: "POST",
    token: world.admin.token,
    body: {
      orgId: world.org.id,
      platform: "facebook",
      relation: "comment_on_our_content",
      contentText: "Lovely post",
      status: "triaged",
    },
  })
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200)
  return (seeded.body as { findingId: string }).findingId
}

async function agentStagesReply(findingId: string, replyText: string): Promise<string> {
  const thread = await api(url, "/api/threads/dm", {
    method: "POST",
    token: world.admin.token,
    body: {},
  })
  const staged = await api(url, "/api/_test/agent-tool-call", {
    method: "POST",
    token: world.admin.token,
    body: {
      toolName: "social:reply_to_finding",
      params: { finding_id: findingId, reply_text: replyText },
      threadId: (thread.body as { data: { id: string } }).data.id,
    },
  })
  expect(staged.status, JSON.stringify(staged.body)).toBe(200)
  const requestId = (staged.body as { data: { blocked?: { approvalRequestId?: string } } }).data
    .blocked?.approvalRequestId
  expect(requestId, JSON.stringify(staged.body)).toBeTruthy()
  return requestId!
}

describe("a finding's approval state is derived from the live approval", () => {
  it("staged → awaiting with the draft; denied → its prior status; staged again and approved → handled", async () => {
    const findingId = await seedFinding()
    const first = await agentStagesReply(findingId, "Thanks, glad you like it!")

    const awaiting = await getFinding(findingId)
    expect(awaiting).toMatchObject({
      status: "awaiting_approval",
      suggested_reply: "Thanks, glad you like it!",
      approval_request_id: first,
    })
    const listed = await tool<{ findings: FindingView[]; totalCount: number }>("findings_list", {
      status: "awaiting_approval",
    })
    expect(listed.findings.map((f) => f.id)).toContain(findingId)
    const counts = await tool<{ awaiting_approval: number }>("counts", {})
    expect(counts.awaiting_approval).toBeGreaterThanOrEqual(1)
    // Nothing was written on the stored row.
    const [stored] = (await env.db.sql.unsafe(
      `SELECT status, approval_request_id FROM "${env.schemaPrefix ?? ""}app_social".finding WHERE id = $1`,
      [findingId],
    )) as unknown as Array<{ status: string; approval_request_id: string | null }>
    expect(stored).toEqual({ status: "triaged", approval_request_id: null })

    const denied = await decide(url, world.admin.token, first, {
      decision: "deny",
      reason: "not on brand",
    })
    expect(denied.status, JSON.stringify(denied.body)).toBe(200)
    const afterDeny = await getFinding(findingId)
    expect(afterDeny.status).toBe("triaged")
    expect(afterDeny.approval_request_id ?? null).toBeNull()
    const listedAfter = await tool<{ findings: FindingView[] }>("findings_list", {
      status: "awaiting_approval",
    })
    expect(listedAfter.findings.map((f) => f.id)).not.toContain(findingId)

    const second = await agentStagesReply(findingId, "Thank you!")
    expect(await getFinding(findingId)).toMatchObject({
      status: "awaiting_approval",
      suggested_reply: "Thank you!",
      approval_request_id: second,
    })
    const approved = await decide(url, world.admin.token, second, { decision: "approve" })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    const rows = await pollUntil(async () => {
      const r = (await env.db.sql.unsafe(
        `SELECT status FROM ${ks(env)}.approved_handler_executions WHERE approval_request_id = $1`,
        [second],
      )) as unknown as Array<{ status: string }>
      return r.length > 0 && r[0]!.status !== "running" && r[0]!.status !== "started" ? r : null
    }, 15_000)
    expect(rows[0]!.status).toBe("succeeded")
    expect((await getFinding(findingId)).status).toBe("handled")
  }, 90_000)

  it("an expired approval no longer holds the finding: it reads its prior status", async () => {
    const findingId = await seedFinding()
    const requestId = await agentStagesReply(findingId, "Cheers!")
    expect((await getFinding(findingId)).status).toBe("awaiting_approval")

    // Past its deadline: expired, whether or not the sweep has reached it yet.
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [requestId],
    )
    const after = await getFinding(findingId)
    expect(after.status).toBe("triaged")
    expect(after.approval_request_id ?? null).toBeNull()
  }, 60_000)
})
