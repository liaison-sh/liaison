// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED CALL PARKED FOR APPROVAL TAINTS NOTHING.
//
// The compound bundle ("reply plus proforma plus label" staged as ONE human
// decision) is formed by chaining the `@ref` token of a blocked gated result
// into the next gated call. Scope taint on writes broke that chain: the bridge
// recorded a call's declared scopes BEFORE invoking it, so the first gated call
// tainted the turn even though its handler never ran, and the second gated call
// of the same turn was then refused as a write from a tainted turn
// (`E_SCOPE_TAINT_BLOCKED`, target `undeclared`) instead of joining the bundle.
//
// Guard 1 below is that chain. Guard 2 is the other half: a tool that ACTUALLY
// RAN and read scoped data still taints the turn, and the next undeclared
// UNGATED write never runs inline: it parks as a disclosure decided by holding
// what the turn read (scope-taint.ts, rule 8h), so the narrow fix does not
// weaken the rule. A gated one parks too, decided by its own approve scope: this
// is a DM with a user holding the scope the read carried, so its approval's
// audience holds it (scope-taint.ts, consequence 2).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { deferrableRef } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c7001"
const USER = "00000000-0000-4000-8000-0000000c7002"
const THREAD = "00000000-0000-4000-8000-0000000c7003"

const actor: ActorContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["chain_test:write", "chain_test:read"],
  dimensionGrants: {},
}

function freshFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: ["chain_test:write", "chain_test:read"],
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

describe("a gated call parked for approval taints nothing", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Chain Taint Org', 'chain-taint-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'chain-taint@test.com', 'Agent', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'chain-taint-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    for (const scope of ["chain_test:write", "chain_test:read"]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }

    // The bundle head: gated, declares a referenceable output.
    toolRegistry.set([ORG, "chain_test", "produce"], {
      appName: "chain_test",
      name: "produce",
      description: "gated head producing a referenceable value",
      requiredScopes: ["chain_test:write"],
      gated: true,
      referenceableOutputs: ["value"],
      params: z.object({ seed: z.string() }),
      handler: async () => ({ value: "produced" }),
    } as any)

    // The dependent step: gated, takes the head's @ref token. It declares no
    // write target, so on a tainted turn it is refused as `undeclared`.
    toolRegistry.set([ORG, "chain_test", "consume"], {
      appName: "chain_test",
      name: "consume",
      description: "gated step consuming a referenced value",
      requiredScopes: ["chain_test:write"],
      gated: true,
      params: z.object({ note: deferrableRef(z.string()), label: z.string() }),
      handler: async (p: any) => ({ consumed: p.note }),
    } as any)

    // An ungated write declaring no target: what guard 2 must still refuse.
    toolRegistry.set([ORG, "chain_test", "touch"], {
      appName: "chain_test",
      name: "touch",
      description: "an ungated undeclared write",
      requiredScopes: ["chain_test:write"],
      params: z.object({}),
      handler: async () => ({ touched: true }),
    } as any)

    // A read that REALLY RUNS and really carries a scope: the taint source for
    // guard 2.
    toolRegistry.set([ORG, "chain_test", "read"], {
      appName: "chain_test",
      name: "read",
      description: "an executing scoped read",
      requiredScopes: ["chain_test:read"],
      params: z.object({}),
      handler: async () => ({ rows: 1 }),
    } as any)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("chains a second gated call into the bundle instead of refusing it as a tainted write", async () => {
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)

    const { head, step } = await runContextStore.run(frame, async () => {
      const head = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      const step = (await (tools.chain_test__consume as any).execute(
        { note: head.outputs.value, label: "reply-label" },
        {},
      )) as any
      return { head, step }
    })

    expect(head.blocked).toBe(true)
    expect(head.outputs.value).toBe(`@ref:${head.approvalRequestId}:value`)

    // The regression: this came back as E_SCOPE_TAINT_BLOCKED / undeclared.
    expect(step.code).toBeUndefined()
    expect(step.blocked).toBe(true)
    expect(step.sequenced).toBe(true)

    const rows = (await sql`SELECT id, bundle_id, bundle_position, depends_on_id, status,
        current_payload FROM kernel.approval_requests WHERE org_id = ${ORG}`) as Array<{
      id: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
      status: string
      current_payload: { note?: string }
    }>
    const deferred = rows.find((r) => r.status === "deferred")
    expect(deferred).toBeDefined()
    expect(deferred!.id).toBe(step.approvalRequestId)
    expect(deferred!.depends_on_id).toBe(head.approvalRequestId)
    expect(deferred!.bundle_position ?? 0).toBeGreaterThan(0)
    expect(deferred!.current_payload.note).toContain("@ref:")
    const bundleHead = rows.find((r) => r.id === deferred!.bundle_id)
    expect(bundleHead!.id).toBe(head.approvalRequestId)
    expect(bundleHead!.status).toBe("pending")

    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  it("after a scoped read, a step citing a head that already demands that read joins its bundle (rule 8f)", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'chain_test:approve') ON CONFLICT DO NOTHING`
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
    const { head, step } = await runContextStore.run(frame, async () => {
      await (tools.chain_test__read as any).execute({}, {})
      const head = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      const step = (await (tools.chain_test__consume as any).execute(
        { note: head.outputs.value, label: "reply-label" },
        {},
      )) as any
      return { head, step }
    })
    expect(head.blocked).toBe(true)
    // The head parked narrowed to holders of what the turn read; the step joins it.
    expect(step.code).toBeUndefined()
    expect(step.blocked).toBe(true)
    expect(step.sequenced).toBe(true)
    const rows = (await sql`SELECT id, status, bundle_id, depends_on_id, metadata
        FROM kernel.approval_requests WHERE org_id = ${ORG}`) as Array<{
      id: string
      status: string
      bundle_id: string | null
      depends_on_id: string | null
      metadata: { taintAudienceMustHold?: string[] }
    }>
    const deferred = rows.find((r) => r.id === step.approvalRequestId)
    expect(deferred?.status).toBe("deferred")
    expect(deferred?.depends_on_id).toBe(head.approvalRequestId)
    expect(deferred?.metadata.taintAudienceMustHold).toContain("chain_test:read")

    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants
      WHERE org_id = ${ORG} AND user_id = ${USER} AND scope = 'chain_test:approve'`
  })

  // 2026-11-03 (rule 8f, updated): this case used to keep the refusal ("the approval ... is
  // visible to everyone who may decide it"). A personal agent that staged a proforma, read more,
  // then replied from its owner's own mailbox citing the proforma's PDF was refused. The head is
  // the same requester's pending request, so it is widened in place to the union, as a restage
  // would be, and the step parks with it.
  it("a step whose turn read more than its head demands widens its own pending head and parks", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'chain_test:approve') ON CONFLICT DO NOTHING`
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
    const { head, step } = await runContextStore.run(frame, async () => {
      // The head parks on a clean turn: its audience demands nothing.
      const head = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      // Then the turn reads scoped data and cites the head.
      await (tools.chain_test__read as any).execute({}, {})
      const step = (await (tools.chain_test__consume as any).execute(
        { note: head.outputs.value, label: "reply-label" },
        {},
      )) as any
      return { head, step }
    })
    expect(step.code).toBeUndefined()
    expect(step.blocked).toBe(true)
    expect(step.sequenced).toBe(true)
    const rows = (await sql`SELECT id, status, depends_on_id, notify_user_ids, metadata
        FROM kernel.approval_requests WHERE org_id = ${ORG}`) as Array<{
      id: string
      status: string
      depends_on_id: string | null
      notify_user_ids: string[]
      metadata: { taintAudienceMustHold?: string[] }
    }>
    const headRow = rows.find((r) => r.id === head.approvalRequestId)
    // Widened in place: only holders of what the turn read see or decide the bundle.
    expect(headRow?.status).toBe("pending")
    expect(headRow?.metadata.taintAudienceMustHold).toContain("chain_test:read")
    expect(headRow?.notify_user_ids).toEqual([USER])
    const deferred = rows.find((r) => r.id === step.approvalRequestId)
    expect(deferred?.status).toBe("deferred")
    expect(deferred?.depends_on_id).toBe(head.approvalRequestId)
    expect(deferred?.metadata.taintAudienceMustHold).toContain("chain_test:read")

    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants
      WHERE org_id = ${ORG} AND user_id = ${USER} AND scope = 'chain_test:approve'`
  })

  it("a step whose widened head nobody could decide is refused with the no-decider remedy", async () => {
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
    const { head, step } = await runContextStore.run(frame, async () => {
      const head = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      await (tools.chain_test__read as any).execute({}, {})
      const step = (await (tools.chain_test__consume as any).execute(
        { note: head.outputs.value, label: "reply-label" },
        {},
      )) as any
      return { head, step }
    })
    const text = JSON.stringify(step)
    expect(text).toContain("E_SCOPE_TAINT_BLOCKED")
    expect(text).toContain("nobody holding chain_test:approve")
    expect(text).not.toContain("everyone who")
    expect(step.blocked).toBeUndefined()
    // Nothing was widened: the head keeps the demand it had.
    const [headRow] = (await sql`SELECT metadata FROM kernel.approval_requests
        WHERE id = ${head.approvalRequestId}`) as Array<{
      metadata: { taintAudienceMustHold?: string[] } | null
    }>
    expect(headRow?.metadata?.taintAudienceMustHold ?? []).not.toContain("chain_test:read")
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  it("a step citing someone else's request keeps the refusal, never saying everyone could approve", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000c7004"
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${OTHER}, ${ORG}, 'chain-taint-other@test.com', 'Other', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'chain_test:approve') ON CONFLICT DO NOTHING`
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
    const step = await runContextStore.run(frame, async () => {
      const head = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      await sql`UPDATE kernel.approval_requests SET requested_by = ${OTHER}
        WHERE id = ${head.approvalRequestId}`
      await (tools.chain_test__read as any).execute({}, {})
      return (await (tools.chain_test__consume as any).execute(
        { note: head.outputs.value, label: "reply-label" },
        {},
      )) as any
    })
    const text = JSON.stringify(step)
    expect(text).toContain("E_SCOPE_TAINT_BLOCKED")
    expect(text).toContain("not your own pending request")
    expect(text).not.toContain("everyone who")
    expect(step.blocked).toBeUndefined()
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants
      WHERE org_id = ${ORG} AND user_id = ${USER} AND scope = 'chain_test:approve'`
  })

  it("an undeclared write after a scoped read that actually ran never runs inline: it parks too (rule 8)", async () => {
    // Someone holding what the turn read may approve both: the DM's user (rule 8 refuses a
    // tainted proposal nobody may decide).
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'chain_test:approve') ON CONFLICT DO NOTHING`
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)

    const { touched, parked } = await runContextStore.run(frame, async () => {
      await (tools.chain_test__read as any).execute({}, {})
      const touched = (await (tools.chain_test__touch as any).execute({}, {})) as any
      const parked = (await (tools.chain_test__produce as any).execute({ seed: "beta" }, {})) as any
      return { touched, parked }
    })

    // The undeclared write is gated for this call: its handler never ran.
    expect(touched.code).toBeUndefined()
    expect(touched.blocked).toBe(true)
    expect(touched.touched).toBeUndefined()
    // The gated write is not refused: it parks for the DM's user, who holds chain_test:read.
    expect(parked.code).toBeUndefined()
    expect(parked.blocked).toBe(true)

    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants
      WHERE org_id = ${ORG} AND user_id = ${USER} AND scope = 'chain_test:approve'`
  })

  it("a tainted gated proposal nobody may approve is refused, naming the remedy; the ungated write parks as a disclosure its requester decides (rules 8d, 8h)", async () => {
    const frame = freshFrame()
    const tools = buildToolSet(ORG, actor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
    const { touched, produced } = await runContextStore.run(frame, async () => {
      await (tools.chain_test__read as any).execute({}, {})
      const touched = (await (tools.chain_test__touch as any).execute({}, {})) as any
      const produced = (await (tools.chain_test__produce as any).execute({ seed: "g" }, {})) as any
      return { touched, produced }
    })
    // The gated write is decided by its own chain_test:approve, which nobody holds.
    const text = JSON.stringify(produced)
    expect(text).toContain("E_SCOPE_TAINT_BLOCKED")
    expect(text).toContain("nobody holding chain_test:approve")
    expect(produced.blocked).toBeUndefined()
    // The ungated write would have run on a clean turn: its approval is the disclosure alone,
    // decided by holding what the turn read, which the requester does.
    expect(touched.code).toBeUndefined()
    expect(touched.blocked).toBe(true)
    expect(touched.touched).toBeUndefined()
    const rows = (await sql`SELECT id, approve_scope, notify_user_ids
      FROM kernel.approval_requests WHERE org_id = ${ORG}`) as Array<{
      id: string
      approve_scope: string | null
      notify_user_ids: string[]
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(touched.approvalRequestId)
    expect(rows[0]?.approve_scope).toBe("chain_test:read")
    expect(rows[0]?.notify_user_ids).toEqual([USER])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })
})
