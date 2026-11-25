// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tainted agent turn staging the same ungated write many times (one ask over ten projects,
// after the turn read something some of the target's readers may not see) parks each call for a
// holder of what the turn read (scope-taint.ts, rule 8). Those calls make ONE request too, as an
// untainted turn's do: Home shows it once, approving it runs every step, one step can be declined
// alone, and each step keeps its own payload. Only calls parked for the same audience join: a
// call whose turn has read more since the head starts a request of its own, and nobody outside
// the taint's holders sees any of it.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** What the turn read: held by the admin, not by the member who also reads the target. */
const SECRET = "bulk_taint:secrets:read"
const OTHER_SECRET = "bulk_taint:ledger:read"

let ORG = ""
let ADMIN = ""
let MEMBER = ""
let THREAD = ""
let actor: ActorContext & UserContext
let memberActor: ActorContext & UserContext

const ran: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  ADMIN = (await minimal.orgAdmin(ORG)).id
  MEMBER = (await minimal.person(ORG)).id
  THREAD = await minimal.thread(ORG, ADMIN)
  actor = { actorType: "user", userId: ADMIN, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
  memberActor = {
    actorType: "user",
    userId: MEMBER,
    orgId: ORG,
    scopes: ["kernel:contacts:read", "kernel:approvals:read"],
    dimensionGrants: {},
  }
  // An ungated write whose readers (every holder of kernel:contacts:read, the member among them)
  // are declared: a turn that read SECRET makes it park, since the member lacks SECRET.
  toolRegistry.set([ORG, "bulk_taint", "update"], {
    appName: "bulk_taint",
    name: "update",
    description: "update",
    requiredScopes: ["kernel:contacts:read"],
    writesToTable: "app_bulk_taint.items",
    sinkReadScope: "kernel:contacts:read",
    params: z.object({ project: z.string() }).passthrough(),
    handler: async (p: { project?: string }) => {
      ran.push(`update:${p.project}`)
      return { ok: true }
    },
  } as never)
})
afterEach(async () => {
  ran.length = 0
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

/** A fresh agent turn's frame that has read `read`. */
function turn(read: string[]): RunContext {
  const id = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(read)
  return {
    runId: id,
    parentRunId: null,
    rootRunId: id,
    nestingDepth: 0,
    effectiveScope: actor.scopes,
    turnScopeAccumulator,
  }
}

async function stage(project: string): Promise<string> {
  const r = await executeTool({
    toolName: "bulk_taint:update",
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

async function tenInOneTaintedTurn(): Promise<string[]> {
  const projects = Array.from({ length: 10 }, (_, i) => `P${i + 1}`)
  return runContextStore.run(turn([SECRET]), () => Promise.all(projects.map((p) => stage(p))))
}

async function homeItems(who: ActorContext & UserContext) {
  const items = await withRlsContext(who, (tx) =>
    computeApprovalAttentionItems(tx, ORG, who.userId),
  )
  return items.filter((i) => i.kind === "approval_pending")
}

async function statuses(ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM kernel.approval_requests WHERE id = ANY(${ids}::uuid[])`
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  return ids.map((id) => byId.get(id) ?? "missing")
}

describe("one tainted turn's calls of one write", () => {
  it("park for the taint's holders as one request of ten steps, each with its own payload", async () => {
    const ids = await tenInOneTaintedTurn()
    expect(new Set(ids).size).toBe(10)
    const rows = await sql<
      {
        status: string
        bundle_id: string | null
        approve_scope: string | null
        must_hold: string[] | null
        project: string
      }[]
    >`
      SELECT status, bundle_id, approve_scope,
             metadata->'taintAudienceMustHold' AS must_hold,
             current_payload->>'project' AS project
      FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1)
    expect(rows.filter((r) => r.status === "deferred")).toHaveLength(9)
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1)
    // Every step demands what the turn read and is decided by a holder of it.
    for (const r of rows) {
      expect(r.must_hold).toEqual([SECRET])
      expect(r.approve_scope).toBe(SECRET)
    }
    expect(rows.map((r) => r.project).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `P${i + 1}`).sort(),
    )
    const items = await homeItems(actor)
    expect(items).toHaveLength(1)
    expect(items[0]?.metadata?.bundleSteps).toBe(10)
    // The member reads the target but not what the turn read: no card, no step.
    expect(await homeItems(memberActor)).toHaveLength(0)
    expect(ran).toEqual([])
  })

  it("one step declined, approving the request runs the other nine", async () => {
    const ids = await tenInOneTaintedTurn()
    const head = String((await homeItems(actor))[0]?.entityId)
    const declined = ids.find((id) => id !== head) as string
    await decideApproval({
      orgId: ORG,
      requestId: declined,
      actor,
      decision: "deny",
      reason: "keep this one",
    })
    expect((await homeItems(actor))[0]?.metadata?.bundleSteps).toBe(9)
    await decideApproval({ orgId: ORG, requestId: head, actor, decision: "approve" })
    const after = await statuses(ids)
    expect(after[ids.indexOf(declined)]).toBe("denied")
    expect(after.filter((s) => s === "approved")).toHaveLength(9)
    expect(ran).toHaveLength(9)
    expect(ran).not.toContain(`update:P${ids.indexOf(declined) + 1}`)
  })

  it("a call after the turn read more starts a request of its own", async () => {
    const frame = turn([SECRET])
    await runContextStore.run(frame, async () => {
      await stage("alpha")
      await stage("bravo")
      frame.turnScopeAccumulator?.recordInjected([OTHER_SECRET])
      await stage("charlie")
    })
    const rows = await sql<{ status: string; must_hold: string[] | null }[]>`
      SELECT status, metadata->'taintAudienceMustHold' AS must_hold
      FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at`
    expect(rows.map((r) => r.status)).toEqual(["pending", "deferred", "pending"])
    expect(rows[2]?.must_hold).toEqual([OTHER_SECRET, SECRET].sort())
    expect(await homeItems(actor)).toHaveLength(2)
  })

  it("an untainted call and a tainted one of the same tool in one turn stay apart", async () => {
    const frame = turn([])
    await runContextStore.run(frame, async () => {
      // Untainted: the write runs at once, nothing parks.
      await executeTool({
        toolName: "bulk_taint:update",
        orgId: ORG,
        actor,
        params: { project: "clean" },
        threadId: THREAD,
        origin: "in-app-agent",
      })
      frame.turnScopeAccumulator?.recordInjected([SECRET])
      await stage("tainted")
    })
    expect(ran).toEqual(["update:clean"])
    expect(await homeItems(actor)).toHaveLength(1)
  })
})
