// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approved READ that fails answers the agent with its error.
//
// A demo agent guessed a page URL that answers 404. Its web_fetch was held for
// approval and approved; the fetch ran and got the 404, and decide reverted the
// request to pending as if the run had never happened. Every later approve (a
// guided tour's "Do it for me", a person's Approve) fetched the same missing
// page again, the thread collected a "Handler failed ... reverted to pending"
// notice per attempt, and the agent never learned the page was missing.
//
// A read has no effect to protect: once it ran, its error IS its answer. The
// request resolves (approved, executed with an error), the error goes back to
// the agent as the call's result, and nothing is left to approve again. Only a
// transient failure of our own database before the call ran, where approving
// again can succeed, still reverts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { WebToolsTestAccess } from "~/modules/agent/tools/web-tools"
import { AlreadyDecidedError, decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000062001"
const USER = "00000000-0000-4000-8000-000000062002"
const THREAD = "00000000-0000-4000-8000-000000062003"
const MISSING_HOST = "missing-page.example"

const SCOPES = ["kernel:agent:web", "kernel:approve", "read_test:read", "read_test:approve"]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}

let fetches = 0

async function propose(toolName: string, params: Record<string, unknown>): Promise<string> {
  const result = await executeTool({
    toolName,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    // An agent's call: held for the person, not run on their own click.
    origin: "in-app-agent",
  })
  const id = result.blocked?.approvalRequestId
  expect(id).toBeString()
  return id!
}

async function approve(id: string) {
  const [row] =
    await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${id}`
  return decideApproval({
    orgId: ORG,
    requestId: id,
    actor,
    decision: "approve",
    payloadHash: approvalPayloadHash(row.tool_name as string, row.current_payload),
  })
}

async function statusOf(id: string): Promise<string> {
  const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return row.status as string
}

async function noticesOfType(type: string) {
  return sql<{ content: string; metadata: Record<string, unknown> }[]>`
    SELECT content, metadata FROM kernel.messages
    WHERE org_id = ${ORG} AND metadata->>'type' = ${type}
    ORDER BY created_at`
}

describe("an approved read that fails answers the agent with its error", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approved Read Error Org', 'approved-read-error-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'approved-read@test.com', 'Reader', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'approved-read-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }

    // The real web_fetch, held for approval on every call (live, the turn's
    // taint held it; how it got held does not matter to what an approval does).
    await registerKernelAgentTools(ORG)
    const webFetch = toolRegistry.get([ORG, "kernel", "web_fetch"])
    expect(webFetch).toBeDefined()
    toolRegistry.set([ORG, "kernel", "web_fetch"], { ...webFetch!, gated: true })
    // The page the agent guessed: the site answers 404.
    WebToolsTestAccess.setWebFetchMockHosts((host) => host === MISSING_HOST)
    WebToolsTestAccess.setWebFetch((async () => {
      fetches++
      return new Response("not here", { status: 404, statusText: "Not Found" })
    }) as unknown as typeof fetch)

    // A read whose handler hits a transient failure of our own database
    // (a deadlock): the read never ran, so approving again can succeed.
    let transientCalls = 0
    toolRegistry.set([ORG, "read_test", "transientRead"], {
      appName: "read_test",
      name: "transientRead",
      description: "A read that first hits a deadlock",
      requiredScopes: ["read_test:read"],
      gated: true,
      readOnly: true,
      handler: async () => {
        transientCalls++
        if (transientCalls === 1) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" })
        }
        return { rows: ["first"] }
      },
    } as never)
    // A read whose handler throws an ordinary error (an upstream not-found the
    // app rethrows): the read ran and that is its answer.
    toolRegistry.set([ORG, "read_test", "throwingRead"], {
      appName: "read_test",
      name: "throwingRead",
      description: "A read that throws not-found",
      requiredScopes: ["read_test:read"],
      gated: true,
      readOnly: true,
      handler: async () => {
        throw new Error("order 1042 not found")
      },
    } as never)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    WebToolsTestAccess.setWebFetch(null)
    WebToolsTestAccess.setWebFetchMockHosts(null)
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("an approved web_fetch answered 404 resolves, hands the agent the 404, and is never approved again", async () => {
    const id = await propose("kernel:web_fetch", { url: `https://${MISSING_HOST}/pricing` })
    fetches = 0

    const decided = await approve(id)
    expect(decided.status).toBe("approved")
    expect(await statusOf(id)).toBe("approved")
    expect(fetches).toBe(1)

    // The run is recorded as executed, its result the error the site gave.
    const [exec] = await sql`SELECT status, result FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${id}`
    expect(exec.status).toBe("succeeded")
    expect(JSON.stringify(exec.result)).toContain("HTTP 404")

    // The agent is handed the error as the call's result.
    const results = await noticesOfType("approval-result")
    expect(results.length).toBe(1)
    expect(String(results[0].metadata.result)).toContain("HTTP 404")

    // No revert, no failure notice, and the decision line does not claim success.
    expect((await noticesOfType("approval-error")).length).toBe(0)
    const decisions = await noticesOfType("approval-decision")
    expect(decisions.length).toBe(1)
    expect(decisions[0].content).not.toContain("executed successfully")
    expect(decisions[0].content).toContain("returned an error")

    // Nothing is left to approve: a second approve is refused and fetches nothing.
    await expect(approve(id)).rejects.toBeInstanceOf(AlreadyDecidedError)
    expect(fetches).toBe(1)
  })

  it("an approved read that throws an ordinary error resolves with that error for the agent", async () => {
    const id = await propose("read_test:throwingRead", {})
    const decided = await approve(id)
    expect(decided.status).toBe("approved")
    const results = await noticesOfType("approval-result")
    expect(results.length).toBe(1)
    expect(String(results[0].metadata.result)).toContain("order 1042 not found")
    expect((await noticesOfType("approval-error")).length).toBe(0)
  })

  it("a transient database failure before the read ran still reverts, and approving again succeeds", async () => {
    const id = await propose("read_test:transientRead", {})
    await expect(approve(id)).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("pending")
    expect((await noticesOfType("approval-error")).length).toBe(1)

    const decided = await approve(id)
    expect(decided.status).toBe("approved")
    const results = await noticesOfType("approval-result")
    expect(String(results.at(-1)?.metadata.result)).toContain("first")
  })
})
