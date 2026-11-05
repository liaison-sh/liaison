// SPDX-License-Identifier: FSL-1.1-ALv2
// Fix D — "deferral is orthogonal to gating". A NON-gated tool that carries an
// `@ref` token (the boxtal `import_label_document` shape: gated:false but
// declares referenceableOutputs and is the documented middle step of the return
// chain) must DEFER into the sequenced bundle rather than execute INLINE against
// the literal `@ref:…` placeholder (which threw before the fix). It joins the
// bundle as a `deferred` dependent under the bundle's SINGLE human approval and
// auto-runs, ref resolved, at cascade time — adding NO approval of its own.
//
// Regression guard: the SAME non-gated tool called WITHOUT any `@ref` still runs
// INLINE (returns data, no approval row). Gated @ref steps are unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { deferrableRef } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// failBundle → enqueueAppJob("kernel","agent-reinvoke") throws "No handler
// registered" in bun:test (kernel job workers only register in index.ts). Stub
// it so any cascade path is self-contained (mirrors cascade.test.ts).
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const ORG = "00000000-0000-4000-8000-0000000a6001"
const USER = "00000000-0000-4000-8000-0000000a6002"
const THREAD = "00000000-0000-4000-8000-0000000a6003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

// Side-effect ledger: each handler bumps its counter and appends its resolved
// param so a test can assert WHEN (stage-time vs cascade-time) it ran and WITH
// WHICH value. Reset per test.
const effects: { produceRuns: number; consumeRuns: number; consumedValues: string[] } = {
  produceRuns: 0,
  consumeRuns: 0,
  consumedValues: [],
}

// A test-tool handler resolves ITS OWN approval row by tool_name + status
// ='approving' and records the started/succeeded protocol rows so the cascade
// can read the decided result (mirrors cascade.test.ts::recordSelf).
async function recordSelf(toolName: string, result: Record<string, unknown>) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = {
    orgId: ORG,
    approvalRequestId: row.id,
    approvalDeciderId: row.decided_by,
    toolName,
  }
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordSucceeded(tx, ctx, toolName, result))
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Ungated Seq Org', 'ungated-seq-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'ungated-seq@test.com', 'Requester', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'ungated-seq-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["seq_test:write", "seq_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }

  // GATED head — produces a referenceable value (the proforma/create-shipment
  // analogue that fronts the bundle).
  toolRegistry.set([ORG, "seq_test", "gatedHead"], {
    appName: "seq_test",
    name: "gatedHead",
    description: "gated head producing a referenceable value",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      const r = { value: "label-file-abc" }
      await recordSelf("seq_test:gatedHead", r)
      return r
    },
  } as any)

  // NON-GATED PRODUCE — gated omitted (defaults false), declares a
  // referenceableOutput. This is the boxtal `import_label_document` analogue:
  // not gated on its own, but a valid bundle step producing an output. Its
  // handler records a side effect so a test can tell whether it ran inline.
  toolRegistry.set([ORG, "seq_test", "ungatedProduce"], {
    appName: "seq_test",
    name: "ungatedProduce",
    description: "non-gated tool producing a referenceable value",
    requiredScopes: ["seq_test:write"],
    // gated intentionally omitted (=> not gated)
    referenceableOutputs: ["value"],
    params: z.object({ note: deferrableRef(z.string()) }),
    handler: async (p: any) => {
      effects.produceRuns += 1
      effects.consumedValues.push(p.note)
      const r = { value: `imported(${p.note})` }
      await recordSelf("seq_test:ungatedProduce", r)
      return r
    },
  } as any)

  // NON-GATED CONSUME — gated false, takes a param carrying an @ref, records a
  // side effect. Used for the "runs inline without @ref / defers with @ref" pair.
  toolRegistry.set([ORG, "seq_test", "ungatedConsume"], {
    appName: "seq_test",
    name: "ungatedConsume",
    description: "non-gated tool consuming a referenced value",
    requiredScopes: ["seq_test:write"],
    gated: false,
    params: z.object({ note: deferrableRef(z.string()) }),
    // No recordSelf: this fixture is only exercised on the INLINE path (no @ref,
    // no approval row), so it must not touch the approval protocol.
    handler: async (p: any) => {
      effects.consumeRuns += 1
      effects.consumedValues.push(p.note)
      return { consumed: p.note }
    },
  } as any)

  // GATED terminal consumer — a following gated step that also runs at cascade
  // time (proves the bundle continues PAST the non-gated middle step).
  toolRegistry.set([ORG, "seq_test", "gatedTail"], {
    appName: "seq_test",
    name: "gatedTail",
    description: "gated terminal consumer",
    requiredScopes: ["seq_test:write"],
    gated: true,
    params: z.object({ note: deferrableRef(z.string()) }),
    handler: async (p: any) => {
      const r = { replied: p.note }
      await recordSelf("seq_test:gatedTail", r)
      return r
    },
  } as any)
})
beforeEach(() => {
  effects.produceRuns = 0
  effects.consumeRuns = 0
  effects.consumedValues = []
})
afterEach(async () => {
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function call(tool: string, params: Record<string, unknown>) {
  return executeTool({
    toolName: `seq_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    origin: "in-app-agent",
  })
}
async function statusOf(id: string) {
  const [r] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return r?.status as string | undefined
}

describe("Fix D — non-gated @ref call defers instead of running inline", () => {
  it("DEFERS, does not run inline: a non-gated @ref call becomes a deferred bundle step and its handler does NOT fire at stage time", async () => {
    const head = await call("gatedHead", {})
    const a1 = head.blocked!.approvalRequestId!
    expect(head.blocked!.sequenced).toBeFalsy() // head is a plain gated approval

    // Non-gated tool, params carry an @ref → must DEFER, not execute inline.
    // Pre-fix: computeSkipGate short-circuited skip:true for the non-gated tool
    // BEFORE the @ref check, so this executed the handler inline against the
    // literal "@ref:…:value" placeholder — produceRuns would be 1 (and the
    // handler would have thrown resolving its own approving row). With the fix
    // it sequences: produceRuns stays 0 and a deferred row is created.
    const r = await call("ungatedProduce", { note: `@ref:${a1}:value` })

    expect(r.blocked).toBeTruthy()
    expect(r.blocked!.sequenced).toBe(true)
    expect(effects.produceRuns).toBe(0) // side effect did NOT happen at stage time

    const a2 = r.blocked!.approvalRequestId!
    const [step] = await sql`SELECT bundle_id, bundle_position, depends_on_id, status
      FROM kernel.approval_requests WHERE id = ${a2}`
    expect(step.status).toBe("deferred")
    expect(step.bundle_id).toBe(a1)
    expect(step.bundle_position).toBe(1)
    expect(step.depends_on_id).toBe(a1)
  })

  it("CASCADES: after the head succeeds, the non-gated deferred step auto-runs in order with its @ref resolved, and a following gated step also runs", async () => {
    const head = await call("gatedHead", {})
    const a1 = head.blocked!.approvalRequestId!
    // non-gated middle step consumes the head's value…
    const mid = await call("ungatedProduce", { note: `@ref:${a1}:value` })
    const a2 = mid.blocked!.approvalRequestId!
    // …and a gated terminal step consumes the non-gated step's output.
    const tail = await call("gatedTail", { note: `@ref:${a2}:value` })
    const a3 = tail.blocked!.approvalRequestId!

    expect(await statusOf(a2)).toBe("deferred")
    expect(await statusOf(a3)).toBe("deferred")
    expect(effects.produceRuns).toBe(0) // nothing ran yet

    // ONE human decision on the head cascades the whole bundle.
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("approved") // non-gated step ran under the bundle
    expect(await statusOf(a3)).toBe("approved") // and the gated tail past it ran

    // The non-gated handler ran exactly once, at cascade time, with the REAL
    // resolved ancestor output (not the literal token).
    expect(effects.produceRuns).toBe(1)
    expect(effects.consumedValues).toContain("label-file-abc")
    expect(await readDecidedResult(ORG, a2)).toEqual({ value: "imported(label-file-abc)" })
    // The gated tail two hops down saw the non-gated step's resolved output.
    expect(await readDecidedResult(ORG, a3)).toEqual({ replied: "imported(label-file-abc)" })
  })

  it("REGRESSION: the same non-gated tool WITHOUT an @ref executes INLINE — returns data, side effect immediate, no approval row", async () => {
    const r = await call("ungatedConsume", { note: "plain-value" })

    expect(r.blocked).toBeFalsy()
    expect((r.data as any).consumed).toBe("plain-value")
    expect(effects.consumeRuns).toBe(1) // ran immediately, inline
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${ORG}`
    expect(n).toBe(0) // no approval created for a plain non-gated call
  })

  it("UNCHANGED: a GATED @ref step still sequences exactly as before", async () => {
    const head = await call("gatedHead", {})
    const a1 = head.blocked!.approvalRequestId!
    const tail = await call("gatedTail", { note: `@ref:${a1}:value` })
    expect(tail.blocked!.sequenced).toBe(true)
    const a2 = tail.blocked!.approvalRequestId!
    const [step] = await sql`SELECT bundle_id, bundle_position, depends_on_id, status
      FROM kernel.approval_requests WHERE id = ${a2}`
    expect(step.status).toBe("deferred")
    expect(step.bundle_id).toBe(a1)
    expect(step.bundle_position).toBe(1)
    expect(step.depends_on_id).toBe(a1)
  })
})
