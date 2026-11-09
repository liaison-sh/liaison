// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { runApprovalExpiry } from "~/modules/approvals/expiry"
import { listApprovals } from "~/modules/approvals/list"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000a8001"
const USER = "00000000-0000-4000-8000-0000000a8002"
const THREAD = "00000000-0000-4000-8000-0000000a8003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Bundle API Org', 'bundle-api-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'bundle-api@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'bundle-api-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["seq_test:write", "seq_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }

  toolRegistry.set([ORG, "seq_test", "step1"], {
    appName: "seq_test",
    name: "step1",
    description: "s1",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => ({ value: "L" }),
  } as any)
  toolRegistry.set([ORG, "seq_test", "step2"], {
    appName: "seq_test",
    name: "step2",
    description: "s2",
    requiredScopes: ["seq_test:write"],
    gated: true,
    handler: async (p: any) => ({ sent: p.note }),
  } as any)
})
afterEach(async () => {
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  // The legitimate-decider test grants OUTSIDER seq_test:approve in the DB.
  // Clear it so a re-run starts clean (the outsider test asserts OUTSIDER has
  // no approve grant).
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function gated(tool: string, params: Record<string, unknown>) {
  const r = await executeTool({
    toolName: `seq_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    origin: "in-app-agent",
  })
  return r.blocked!.approvalRequestId!
}
async function statusOf(id: string) {
  const [r] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return r.status as string
}

describe("bundle API surface", () => {
  it("a bundle head's summary reports its step count; deferred steps are not in the feed", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })

    const items = await withRlsContext(actor, (tx) => computeApprovalAttentionItems(tx, ORG, USER))
    const ids = items.map((i) => i.entityId)
    expect(ids).toContain(a1)
    expect(ids).not.toContain(a2)
    const head = items.find((i) => i.entityId === a1)!
    expect(head.metadata?.bundleSteps).toBe(2)
  })

  it("a bundle head's row is named after its LAST step (the outcome); the decision stays the head's", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await sql`UPDATE kernel.approval_requests
      SET summary = ${JSON.stringify({ title: "Create contact in CRM: Ines Duarte", lines: [] })}::jsonb
      WHERE id = ${a1}`
    await sql`UPDATE kernel.approval_requests
      SET summary = ${JSON.stringify({
        title: "Your quote request",
        subtitle: "Reply to Ines Duarte via sales@example.com",
        lines: ["To: ines@example.com"],
      })}::jsonb
      WHERE id = ${a2}`

    const items = await withRlsContext(actor, (tx) => computeApprovalAttentionItems(tx, ORG, USER))
    const head = items.find((i) => i.entityId === a1)!
    expect(head.summary).toBe("Your quote request")
    expect(head.metadata?.baseTitle).toBe("Your quote request")
    expect(head.metadata?.subtitle).toBe("Reply to Ines Duarte via sales@example.com")
    expect(head.metadata?.summaryLines).toEqual(["To: ines@example.com"])
    expect(head.metadata?.bundleSteps).toBe(2)
    // The chip names the outcome; what acts on the request stays the head's.
    expect(head.metadata?.outcomeToolName).toBe("seq_test:step2")
    expect(head.metadata?.toolName).toBe("seq_test:step1")
    expect(head.action).toMatchObject({ type: "decide_approval", approvalId: a1 })
    // What happens, in order: each step by its own name.
    expect(head.metadata?.bundleSequence).toEqual([
      { toolName: "seq_test:step1", title: "Create contact in CRM: Ines Duarte" },
      { toolName: "seq_test:step2", title: "Your quote request" },
    ])
  })

  it("a staged step's summary reads its @ref tokens as the step they come from", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    const [row] = await sql<{ summary: { title: string; lines: string[] } }[]>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${a2}`
    const text = JSON.stringify(row?.summary)
    expect(text).not.toContain("@ref:")
    expect(text).toContain("value from step 1")
    // Not run yet: said so, with the request a person can find; never a bracketed stand-in.
    const [h] = await sql<{ handle: string }[]>`
      SELECT handle FROM kernel.approval_requests WHERE id = ${a1}`
    expect(text).toContain(`(${h?.handle}, filled in when that step runs)`)
    expect(row?.summary.lines.join("\n")).not.toMatch(/\[[^\]]*from step/)
  })

  it("a single request keeps its own title", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await sql`UPDATE kernel.approval_requests
      SET summary = ${JSON.stringify({ title: "Create contact in CRM: Ines Duarte", lines: [] })}::jsonb
      WHERE id = ${a1}`
    const items = await withRlsContext(actor, (tx) => computeApprovalAttentionItems(tx, ORG, USER))
    const row = items.find((i) => i.entityId === a1)!
    expect(row.summary).toBe("Create contact in CRM: Ines Duarte")
    expect(row.metadata?.outcomeToolName).toBeUndefined()
    expect(row.metadata?.bundleSequence).toBeUndefined()
  })

  it("GET /approvals?bundleId= returns the ordered steps", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    const rows = await withRlsContext(actor, (tx) =>
      listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes, bundleId: a1 }),
    )
    expect(rows.map((r) => r.id)).toEqual([a1, a2])
    expect(rows[0].bundlePosition).toBe(0)
    expect(rows[1].bundlePosition).toBe(1)
  })

  it("re-staging the same deferred step (same head/tool/requester) RESTAGES it in place, never a sibling", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value`, body: "first draft" })
    // The re-run's head call dedupes onto a1; its dependent step must UPDATE
    // a2 in place (the prod bug: two reply steps queued in one sequence).
    const a2again = await gated("step2", { note: `@ref:${a1}:value`, body: "second draft" })
    expect(a2again).toBe(a2)
    const rows = await withRlsContext(actor, (tx) =>
      listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes, bundleId: a1 }),
    )
    expect(rows.map((r) => r.id)).toEqual([a1, a2])
    expect((rows[1].currentPayload as { body?: string }).body).toBe("second draft")
  })

  it("bundle mode excludes cancelled steps from the sequence card", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await sql`UPDATE kernel.approval_requests SET status = 'cancelled' WHERE id = ${a2}`
    const rows = await withRlsContext(actor, (tx) =>
      listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes, bundleId: a1 }),
    )
    expect(rows.map((r) => r.id)).toEqual([a1])
  })

  it("expiring the head cancels deferred siblings", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await runApprovalExpiry({ orgId: ORG, requestId: a1 })
    expect(await statusOf(a1)).toBe("expired")
    expect(await statusOf(a2)).toBe("cancelled")
  })

  // — IDOR: bundle-mode must apply the same audience + scope filter as the
  //   decidable feed. A same-org member who is NOT in the audience, NOT the
  //   requester, and lacks `<app>:approve` must not enumerate a bundle's
  //   payloads by id.
  describe("bundle-mode audience + scope enforcement", () => {
    const OUTSIDER = "00000000-0000-4000-8000-0000000a8004"
    const outsiderActor: ActorContext & UserContext = {
      actorType: "user",
      userId: OUTSIDER,
      orgId: ORG,
      // Same org, but NO seq_test:approve scope.
      scopes: ["seq_test:write"],
      dimensionGrants: {},
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${OUTSIDER}, ${ORG}, 'bundle-outsider@test.com', 'Outsider', 'active', 'hash')
        ON CONFLICT DO NOTHING`
    })

    it("an outsider (not in audience, not requester, no :approve) gets [] for a bundle id", async () => {
      const a1 = await gated("step1", { kind: "x" })
      const a2 = await gated("step2", { note: `@ref:${a1}:value` })

      // The requester (USER, in audience, holds :approve) still sees the bundle.
      const requesterRows = await withRlsContext(actor, (tx) =>
        listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes, bundleId: a1 }),
      )
      expect(requesterRows.map((r) => r.id)).toEqual([a1, a2])

      // The outsider cannot enumerate the same bundle's payloads.
      const outsiderRows = await withRlsContext(outsiderActor, (tx) =>
        listApprovals(tx, {
          orgId: ORG,
          userId: OUTSIDER,
          scopes: outsiderActor.scopes,
          bundleId: a1,
        }),
      )
      expect(outsiderRows).toEqual([])
    })

    it("an in-audience member with :approve sees the bundle (legitimate decider)", async () => {
      const a1 = await gated("step1", { kind: "x" })
      const a2 = await gated("step2", { note: `@ref:${a1}:value` })

      // Add OUTSIDER to the audience and grant the approve scope → now allowed.
      // The approve scope must be a real DB grant (user_scope_grants): the
      // approval_requests_select RLS policy resolves scope possession from the
      // grant tables, not the session `scopes` array, so a session-only scope
      // would still be filtered out at the row level. (A real request's session
      // scopes are themselves derived from these grants at auth time.)
      await sql`UPDATE kernel.approval_requests
        SET notify_user_ids = array_append(notify_user_ids, ${OUTSIDER}::uuid)
        WHERE bundle_id = ${a1}`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${OUTSIDER}, ${ORG}, 'seq_test:approve') ON CONFLICT DO NOTHING`
      const decider: ActorContext & UserContext = {
        ...outsiderActor,
        scopes: ["seq_test:write", "seq_test:approve"],
      }
      const rows = await withRlsContext(decider, (tx) =>
        listApprovals(tx, { orgId: ORG, userId: OUTSIDER, scopes: decider.scopes, bundleId: a1 }),
      )
      expect(rows.map((r) => r.id)).toEqual([a1, a2])
    })
  })
})
