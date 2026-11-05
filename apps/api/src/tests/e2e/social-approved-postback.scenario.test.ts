// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An AGENT's gated social post-back (reply_to_finding), approved by a person,
// executes exactly once, and its POST reaches the platform (the e2e social
// mock). Approvals are for agents: the call is staged through the agent's tool
// gate (`/api/_test/agent-tool-call`) and replayed by the kernel on approve.
//
// The Playwright social scenarios saw "no POST after approve" for both
// platforms. The replay ran (approved_handler_executions: one succeeded row),
// but the post-back never reached the social mock: the Meta Ads mock, first in
// the harness fetch chain, answered every graph.facebook.com POST with its
// unhandled-path 404 ("gone"), and graph.instagram.com was not mocked at all
// (the call went out to the real API). This pins the whole path at api level.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { decide, ks, pollUntil } from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let url: string

interface MockRequest {
  url: string
  method: string
}

async function mockRequests(): Promise<MockRequest[]> {
  const res = await api(url, "/api/_test/social/mock/requests", {
    method: "GET",
    token: world.admin.token,
  })
  expect(res.status).toBe(200)
  return (res.body as { requests: MockRequest[] }).requests
}

const posts = (reqs: MockRequest[], path: RegExp) =>
  reqs.filter((r) => r.method === "POST" && path.test(new URL(r.url).pathname))

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

async function agentDm(): Promise<string> {
  const res = await api(url, "/api/threads/dm", {
    method: "POST",
    token: world.admin.token,
    body: {},
  })
  return (res.body as { data: { id: string } }).data.id
}

describe("an approved agent social post-back", () => {
  for (const platform of ["facebook", "instagram"] as const) {
    it(`${platform}: reply_to_finding parks, and on approve posts exactly once`, async () => {
      const seeded = await api(url, "/api/_test/social/seed-finding", {
        method: "POST",
        token: world.admin.token,
        body: {
          orgId: world.org.id,
          platform,
          relation: "comment_on_our_content",
          contentText: "Lovely post",
        },
      })
      expect(seeded.status, JSON.stringify(seeded.body)).toBe(200)
      const findingId = (seeded.body as { findingId: string }).findingId
      const before = posts(await mockRequests(), /\/(comments|replies)$/).length

      const staged = await api(url, "/api/_test/agent-tool-call", {
        method: "POST",
        token: world.admin.token,
        body: {
          toolName: "social:reply_to_finding",
          params: { finding_id: findingId, reply_text: `Thanks (${platform})` },
          threadId: await agentDm(),
        },
      })
      expect(staged.status, JSON.stringify(staged.body)).toBe(200)
      const requestId = (staged.body as { data: { blocked?: { approvalRequestId?: string } } }).data
        .blocked?.approvalRequestId
      expect(requestId, JSON.stringify(staged.body)).toBeTruthy()
      // Parked: nothing reached the platform yet.
      expect(posts(await mockRequests(), /\/(comments|replies)$/).length).toBe(before)

      const decided = await decide(url, world.admin.token, requestId!, { decision: "approve" })
      expect(decided.status, JSON.stringify(decided.body)).toBe(200)

      // Exactly one execution, which succeeded and posted once.
      const rows = await pollUntil(async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT status, result FROM ${ks(env)}.approved_handler_executions WHERE approval_request_id = $1`,
          [requestId!],
        )) as unknown as Array<{ status: string; result: { status?: string } | null }>
        return r.length > 0 && r[0]!.status !== "running" ? r : null
      }, 15_000)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("succeeded")
      expect(rows[0]!.result?.status, JSON.stringify(rows[0]!.result)).toBe("completed")
      expect(posts(await mockRequests(), /\/(comments|replies)$/).length).toBe(before + 1)
    }, 60_000)
  }
})
