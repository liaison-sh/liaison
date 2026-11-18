// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One agent turn staging the same gated tool many times (one ask over ten projects) makes ONE
// request: the first call is its head, every later one a step after it. Home shows and counts it
// once; approving the head runs every step; one step can be declined and the rest still run.
// Two tools, or two turns, stay separate requests.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000b7001"
const USER = "00000000-0000-4000-8000-0000000b7002"
const THREAD = "00000000-0000-4000-8000-0000000b7003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["bulk_test:write", "bulk_test:approve"],
  dimensionGrants: {},
}

const ran: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Turn Bundle Org', 'turn-bundle-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'turn-bundle@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'turn-bundle-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["bulk_test:write", "bulk_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
  for (const name of ["update", "archive"]) {
    toolRegistry.set([ORG, "bulk_test", name], {
      appName: "bulk_test",
      name,
      description: name,
      requiredScopes: ["bulk_test:write"],
      gated: true,
      handler: async (p: { project?: string }) => {
        ran.push(`${name}:${p.project}`)
        return { ok: true }
      },
    } as never)
  }
})
afterEach(async () => {
  ran.length = 0
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

let turns = 0
/** A fresh agent turn's frame. */
function turn(): RunContext {
  turns++
  const id = `00000000-0000-4000-8000-${String(turns).padStart(12, "0")}`
  // A turn that has read nothing yet: no outside text, nothing tainting its writes.
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  return {
    runId: id,
    parentRunId: null,
    rootRunId: id,
    nestingDepth: 0,
    effectiveScope: actor.scopes,
    turnScopeAccumulator,
  }
}

async function stage(tool: string, project: string): Promise<string> {
  const r = await executeTool({
    toolName: `bulk_test:${tool}`,
    orgId: ORG,
    actor,
    params: { project },
    threadId: THREAD,
    origin: "in-app-agent",
  })
  const id = r.blocked?.approvalRequestId
  if (!id) throw new Error(`not parked: ${JSON.stringify(r)}`)
  return id
}

/** Ten calls of one tool in one turn, made in parallel as a model's one step makes them. */
async function tenInOneTurn(tool = "update"): Promise<string[]> {
  const frame = turn()
  const projects = Array.from({ length: 10 }, (_, i) => `P${i + 1}`)
  return runContextStore.run(frame, () => Promise.all(projects.map((p) => stage(tool, p))))
}

async function homeItems() {
  const items = await withRlsContext(actor, (tx) => computeApprovalAttentionItems(tx, ORG, USER))
  return items.filter((i) => i.kind === "approval_pending")
}

async function statuses(ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM kernel.approval_requests WHERE id = ANY(${ids}::uuid[])`
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  return ids.map((id) => byId.get(id) ?? "missing")
}

describe("one turn's calls of one gated tool", () => {
  it("ten calls in one turn are one request and one Home item of ten steps", async () => {
    const ids = await tenInOneTurn()
    expect(new Set(ids).size).toBe(10)
    const rows = await sql<{ status: string; bundle_id: string | null }[]>`
      SELECT status, bundle_id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1)
    expect(rows.filter((r) => r.status === "deferred")).toHaveLength(9)
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1)
    const items = await homeItems()
    expect(items).toHaveLength(1)
    expect(items[0]?.metadata?.bundleSteps).toBe(10)
  })

  it("two tools in one turn, or one tool in two turns, stay separate requests", async () => {
    const frame = turn()
    await runContextStore.run(frame, async () => {
      await stage("update", "P1")
      await stage("archive", "P2")
      await stage("update", "P3")
    })
    expect(await homeItems()).toHaveLength(2)
    await runContextStore.run(turn(), () => stage("update", "P4"))
    expect(await homeItems()).toHaveLength(3)
  })

  it("approving the request runs every step", async () => {
    const ids = await tenInOneTurn()
    const head = (await homeItems())[0]?.entityId
    expect(ids).toContain(String(head))
    await decideApproval({ orgId: ORG, requestId: String(head), actor, decision: "approve" })
    expect(await statuses(ids)).toEqual(ids.map(() => "approved"))
    expect(ran.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `update:P${i + 1}`).sort())
  })

  it("one step declined, approving the request runs the other nine", async () => {
    const ids = await tenInOneTurn()
    const head = String((await homeItems())[0]?.entityId)
    const declined = ids.find((id) => id !== head) as string
    const declinedProject = `update:P${ids.indexOf(declined) + 1}`
    await decideApproval({
      orgId: ORG,
      requestId: declined,
      actor,
      decision: "deny",
      reason: "keep this one",
    })
    expect((await homeItems())[0]?.metadata?.bundleSteps).toBe(9)
    await decideApproval({ orgId: ORG, requestId: head, actor, decision: "approve" })
    const after = await statuses(ids)
    expect(after[ids.indexOf(declined)]).toBe("denied")
    expect(after.filter((s) => s === "approved")).toHaveLength(9)
    expect(ran).toHaveLength(9)
    expect(ran).not.toContain(declinedProject)
  })

  it("a call after the request was decided starts a new one", async () => {
    const frame = turn()
    const first = await runContextStore.run(frame, () => stage("update", "P1"))
    await decideApproval({ orgId: ORG, requestId: first, actor, decision: "deny" })
    const second = await runContextStore.run(frame, () => stage("update", "P2"))
    expect(await statuses([second])).toEqual(["pending"])
    const items = await homeItems()
    expect(items.map((i) => i.entityId)).toEqual([second])
  })
})
