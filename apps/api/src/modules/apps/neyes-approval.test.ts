// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-268 — N-eyes (two-distinct-approver) ENFORCEMENT through the gate +
// decide path. A per-org approval-tightening policy escalates a tool call so it
// requires TWO distinct approvers; the first approval records the approver and
// keeps the request PENDING, and only the SECOND distinct approver executes the
// handler. Also pins the TIGHTEN-ONLY invariant end-to-end (a policy escalates a
// NON-gated action to gated; it can never un-gate or auto-approve N-eyes away).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { approvalPolicies } from "~/db/schema/kernel"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000b5001"
const REQUESTER = "00000000-0000-4000-8000-0000000b5002"
const THREAD = "00000000-0000-4000-8000-0000000b5003"
const APPROVER1 = "00000000-0000-4000-8000-0000000b5004"
const APPROVER2 = "00000000-0000-4000-8000-0000000b5005"
/** A person who sends the refund themselves (human-ui) and could decide it. */
const PERSON = "00000000-0000-4000-8000-0000000b5006"
/** A person who may send the refund but not approve it. */
const SENDER = "00000000-0000-4000-8000-0000000b5007"
/** A person who may approve refunds but not send them. */
const OUTSIDER = "00000000-0000-4000-8000-0000000b5008"

let executed = 0

// The operator (a real user) who triggers the refund. They hold write but NOT
// the approve scope, so they cannot self-approve — the approval routes to the
// eligible approvers. origin:"in-app-agent" keeps it on the agent gated path
// (no direct-human auto-execute).
const agentActor: ActorContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: ["nty_test:write"],
  dimensionGrants: {},
}
const approverCtx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: ["nty_test:write", "nty_test:approve", "kernel:approve"],
  dimensionGrants: {},
})

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'N-eyes Org', 'n-eyes-org') ON CONFLICT DO NOTHING`
  for (const [id, email, name] of [
    [REQUESTER, "neyes-req@test.com", "Requester"],
    [APPROVER1, "neyes-a1@test.com", "Approver One"],
    [APPROVER2, "neyes-a2@test.com", "Approver Two"],
    [PERSON, "neyes-person@test.com", "Person"],
    [SENDER, "neyes-sender@test.com", "Sender"],
    [OUTSIDER, "neyes-outsider@test.com", "Outsider"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'hash') ON CONFLICT DO NOTHING`
  }
  // The requester must still hold the tool's write scope at EXECUTION time (the
  // approved handler runs under the requester's reloaded DB permissions).
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${REQUESTER}, ${ORG}, 'nty_test:write') ON CONFLICT DO NOTHING`
  // Both approvers hold nty_test:approve so they are eligible approvers in the
  // approval's audience (notify_user_ids).
  for (const id of [APPROVER1, APPROVER2, PERSON, OUTSIDER]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${id}, ${ORG}, 'nty_test:approve') ON CONFLICT DO NOTHING`
  }
  for (const id of [PERSON, SENDER]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${id}, ${ORG}, 'nty_test:write') ON CONFLICT DO NOTHING`
  }
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'neyes-thread', 'agent_chat', ${REQUESTER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${REQUESTER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`

  // A NON-gated tool — the tightening policy must escalate it to gated + N-eyes.
  toolRegistry.set([ORG, "nty_test", "refund"], {
    appName: "nty_test",
    name: "refund",
    description: "refund",
    requiredScopes: ["nty_test:write"],
    gated: false,
    handler: async () => {
      executed += 1
      return { ok: true }
    },
  } as any)

  // refund over €200 (amount_minor >= 20000) → require 2 distinct approvers.
  await withSystemDb("t", (db) =>
    db.insert(approvalPolicies).values({
      orgId: ORG,
      toolName: "nty_test:refund",
      enabled: true,
      conditions: [{ path: "params.amount_minor", op: "gte", value: 20000 }],
      requireApproval: true,
      minApprovers: 2,
      createdBy: REQUESTER,
    }),
  )

  // Two N-eyes tools whose audience can never reach two distinct approvers:
  // a personal tool (only its owner, PERSON, decides) and a tool with its own
  // deciding scope that only OUTSIDER holds.
  for (const [name, extra] of [
    ["personal", { ownerUserId: PERSON }],
    ["rare", { approveScope: "nty_test:rare_approve" }],
  ] as const) {
    toolRegistry.set([ORG, "nty_test", name], {
      appName: "nty_test",
      name,
      description: name,
      requiredScopes: ["nty_test:write"],
      gated: true,
      ...extra,
      handler: async () => {
        executed += 1
        return { ok: true }
      },
    } as any)
    await withSystemDb("t", (db) =>
      db.insert(approvalPolicies).values({
        orgId: ORG,
        toolName: `nty_test:${name}`,
        enabled: true,
        conditions: [],
        requireApproval: true,
        minApprovers: 2,
        createdBy: REQUESTER,
      }),
    )
  }
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${OUTSIDER}, ${ORG}, 'nty_test:rare_approve') ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  // approved_handler_executions FK-references approval_requests — delete the
  // child rows first or the cleanup violates the FK and leaks state.
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  executed = 0
})
afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG])
  await withSystemDb("t", (db) =>
    db.delete(approvalPolicies).where(sql`org_id = ${ORG}` as any),
  ).catch(() => {})
  await releaseTestLock()
})

describe("N-eyes enforcement (BL-268)", () => {
  it("a €250 refund escalates a NON-gated tool to GATED via the policy", async () => {
    const r = await executeTool({
      toolName: "nty_test:refund",
      orgId: ORG,
      actor: agentActor,
      params: { amount_minor: 25000 },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    expect(r.blocked).toBeDefined()
    expect(executed).toBe(0) // NOT executed — it gated
    const id = r.blocked!.approvalRequestId!
    const [row] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.metadata.minApprovers).toBe(2)
    expect(typeof row.metadata.tightenReason).toBe("string")
  })

  it("the FIRST approver does NOT execute — request stays pending; the SECOND executes", async () => {
    const r = await executeTool({
      toolName: "nty_test:refund",
      orgId: ORG,
      actor: agentActor,
      params: { amount_minor: 25000 },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const id = r.blocked!.approvalRequestId!

    // First distinct approver — records, stays pending, does NOT execute.
    const first = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER1),
      decision: "approve",
    })
    expect(first.status).toBe("pending")
    expect(first.approvalsRecorded).toBe(1)
    expect(first.approvalsRequired).toBe(2)
    expect(executed).toBe(0)
    const [mid] = await sql`SELECT status, metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(mid.status).toBe("pending")
    expect(mid.metadata.approvedBy).toEqual([APPROVER1])

    // Second DISTINCT approver — reaches the floor, executes the handler.
    const second = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER2),
      decision: "approve",
    })
    expect(second.status).toBe("approved")
    expect(executed).toBe(1)
    const [done] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(done.status).toBe("approved")
  })

  it("the SAME approver approving twice does NOT satisfy N-eyes (distinct required)", async () => {
    const r = await executeTool({
      toolName: "nty_test:refund",
      orgId: ORG,
      actor: agentActor,
      params: { amount_minor: 25000 },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const id = r.blocked!.approvalRequestId!

    const first = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER1),
      decision: "approve",
    })
    expect(first.status).toBe("pending")
    // Same approver again — refused, still 1 distinct, never executes.
    await expect(
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: approverCtx(APPROVER1),
        decision: "approve",
      }),
    ).rejects.toMatchObject({ status: 409, code: "already_signed_off" })
    const [row] = await sql`SELECT status, metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("pending")
    expect(row.metadata.approvedBy).toEqual([APPROVER1])
    expect(executed).toBe(0)
  })

  it("a €150 refund does NOT match the >€200 policy → the non-gated tool runs directly", async () => {
    const r = await executeTool({
      toolName: "nty_test:refund",
      orgId: ORG,
      actor: agentActor,
      params: { amount_minor: 15000 },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    // Below threshold: no escalation, the non-gated tool executes outright.
    expect(r.blocked).toBeUndefined()
    expect(executed).toBe(1)
  })

  it("an unrelated tool with no policy is unaffected (runs without gating)", async () => {
    let ran = 0
    toolRegistry.set([ORG, "nty_test", "other"], {
      appName: "nty_test",
      name: "other",
      description: "other",
      requiredScopes: ["nty_test:write"],
      gated: false,
      handler: async () => {
        ran += 1
        return { ok: true }
      },
    } as any)
    const r = await executeTool({
      toolName: "nty_test:other",
      orgId: ORG,
      actor: agentActor,
      params: { amount_minor: 99999 },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    expect(r.blocked).toBeUndefined()
    expect(ran).toBe(1)
  })

  // A person's OWN call (human-ui) under the N-eyes policy: the one case where a
  // person's call parks. It needs the tool's own scope; holding the deciding
  // scope too, their click is the first sign-off and one more DISTINCT person
  // must approve. They can never approve their own request again.
  const personActor = (userId: string, scopes: string[]): ActorContext => ({
    actorType: "user",
    userId,
    orgId: ORG,
    scopes,
    dimensionGrants: {},
  })
  const personSend = (userId: string, scopes: string[], amount = 25000) =>
    executeTool({
      toolName: "nty_test:refund",
      orgId: ORG,
      actor: personActor(userId, scopes),
      params: { amount_minor: amount },
      origin: "human-ui",
    })

  it("a person who could decide parks at 1 of 2, nothing runs", async () => {
    const r = await personSend(PERSON, ["nty_test:write", "nty_test:approve"])
    expect(r.blocked?.approvalRequestId).toBeTruthy()
    expect(executed).toBe(0)
    const [row] =
      await sql`SELECT status, requested_by, metadata FROM kernel.approval_requests WHERE id = ${r.blocked!.approvalRequestId!}`
    expect(row.status).toBe("pending")
    expect(row.requested_by).toBe(PERSON)
    expect(row.metadata.minApprovers).toBe(2)
    expect(row.metadata.approvedBy).toEqual([PERSON])
  })

  it("the requester cannot approve their own request; a second distinct approver executes it once", async () => {
    const r = await personSend(PERSON, ["nty_test:write", "nty_test:approve"])
    const id = r.blocked!.approvalRequestId!
    await expect(
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: approverCtx(PERSON),
        decision: "approve",
      }),
    ).rejects.toMatchObject({ status: 409, code: "already_signed_off" })
    expect(executed).toBe(0)
    const done = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER1),
      decision: "approve",
    })
    expect(done.status).toBe("approved")
    expect(executed).toBe(1)
    const [row] = await sql`SELECT status, metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("approved")
    expect(row.metadata.approvedBy).toEqual([PERSON, APPROVER1])
  })

  it("two approvers clicking at once execute it exactly once", async () => {
    const r = await personSend(PERSON, ["nty_test:write", "nty_test:approve"])
    const id = r.blocked!.approvalRequestId!
    const results = await Promise.allSettled([
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: approverCtx(APPROVER1),
        decision: "approve",
      }),
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: approverCtx(APPROVER2),
        decision: "approve",
      }),
    ])
    expect(results.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1)
    expect(executed).toBe(1)
    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("approved")
  })

  it("a person who may send but not decide parks with no sign-off: two others must approve", async () => {
    const r = await personSend(SENDER, ["nty_test:write"])
    const id = r.blocked!.approvalRequestId!
    const [row] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.metadata.approvedBy).toBeUndefined()
    const first = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER1),
      decision: "approve",
    })
    expect(first.status).toBe("pending")
    expect(executed).toBe(0)
    const second = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor: approverCtx(APPROVER2),
      decision: "approve",
    })
    expect(second.status).toBe("approved")
    expect(executed).toBe(1)
  })

  it("a person without the tool's own scope is refused 403 and nothing parks, approve scope or not", async () => {
    await expect(personSend(OUTSIDER, ["nty_test:approve"])).rejects.toMatchObject({
      status: 403,
    })
    const [{ n }] =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(n).toBe(0)
    expect(executed).toBe(0)
  })

  it("below the policy's threshold a person's own call runs straight away", async () => {
    const r = await personSend(SENDER, ["nty_test:write"], 15000)
    expect(r.blocked).toBeUndefined()
    expect(executed).toBe(1)
  })

  // An N-eyes floor the audience can never meet is refused at once (409), for
  // a person and an agent alike: parking it would wait for a second approver
  // who cannot exist until it expires.
  const neverMet = async (
    toolName: string,
    actor: ActorContext,
    origin: "human-ui" | "in-app-agent",
  ) => {
    let caught: any = null
    try {
      await executeTool({
        toolName,
        orgId: ORG,
        actor,
        params: {},
        ...(origin === "in-app-agent" ? { threadId: THREAD } : {}),
        origin,
      })
    } catch (err) {
      caught = err
    }
    expect(caught?.status).toBe(409)
    expect(caught?.code).toBe("approvers_unavailable")
    const [{ n }] =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG} AND tool_name = ${toolName}`
    expect(n).toBe(0)
    expect(executed).toBe(0)
    return String(caught?.message)
  }

  it("a person's own call on their personal resource under N-eyes is refused at once, nothing parks", async () => {
    const msg = await neverMet(
      "nty_test:personal",
      personActor(PERSON, ["nty_test:write", "nty_test:approve"]),
      "human-ui",
    )
    expect(msg).toContain("personal resource")
  })

  it("an agent's call on its owner's personal resource under N-eyes is refused at once, nothing parks", async () => {
    await neverMet(
      "nty_test:personal",
      personActor(PERSON, ["nty_test:write", "nty_test:approve"]),
      "in-app-agent",
    )
  })

  it("an N-eyes tool fewer people may approve than required is refused at once, for a person and an agent", async () => {
    const msg = await neverMet("nty_test:rare", personActor(SENDER, ["nty_test:write"]), "human-ui")
    expect(msg).toContain("only 1 person")
    await neverMet("nty_test:rare", agentActor, "in-app-agent")
  })
})
