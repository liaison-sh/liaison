// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { deferrableRef } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000a4001"
const USER = "00000000-0000-4000-8000-0000000a4002"
const THREAD = "00000000-0000-4000-8000-0000000a4003"
const USER2 = "00000000-0000-4000-8000-0000000a4004"
const actor: ActorContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Sequenced Approval Org', 'sequenced-approval-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'seq-approval@test.com', 'Requester', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER2}, ${ORG}, 'seq-approval-2@test.com', 'Other User', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'seq-approval-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`

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
    params: z.object({
      note: z.string(),
      attach: z.array(deferrableRef(z.string())).optional(),
    }),
    handler: async (p: any) => ({ sent: p.note }),
  } as any)
})
afterEach(async () => {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function gated(tool: string, params: Record<string, unknown>) {
  // origin: "in-app-agent" — sequenced approval flow exists for agent calls.
  // Direct human UI calls auto-execute past the gate (covered in
  // execute-tool.test.ts); this suite asserts the agent path.
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

describe("sequenced approval creation", () => {
  it("a gated call referencing a prior approval becomes a deferred bundle step", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })

    const [head] = await sql`SELECT bundle_id, bundle_position, status
      FROM kernel.approval_requests WHERE id = ${a1}`
    const [step] = await sql`SELECT bundle_id, bundle_position, depends_on_id, status
      FROM kernel.approval_requests WHERE id = ${a2}`

    expect(head.bundle_id).toBe(a1)
    expect(head.bundle_position).toBe(0)
    expect(head.status).toBe("pending")
    expect(step.bundle_id).toBe(a1)
    expect(step.bundle_position).toBe(1)
    expect(step.depends_on_id).toBe(a1)
    expect(step.status).toBe("deferred")
  })

  it("the blocked envelope of a sequenced step is flagged sequenced", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const r = await executeTool({
      toolName: "seq_test:step2",
      orgId: ORG,
      actor,
      params: { note: `@ref:${a1}:value` },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    expect(r.blocked!.sequenced).toBe(true)
  })

  it("rejects a ref to an unknown approval as a 400 invalid_ref tool error", async () => {
    let caught: (Error & { code?: string; status?: number }) | null = null
    try {
      await executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: "@ref:99999999-9999-4999-8999-999999999999:value" },
        threadId: THREAD,
        origin: "in-app-agent",
      })
    } catch (err) {
      caught = err as Error & { code?: string; status?: number }
    }
    // Must be a clean, retryable 400 tool error — never an uncaught 500.
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe("invalid_ref")
    expect(caught?.status).toBe(400)
  })

  it("rejects a ref to an already-decided approval", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await sql`UPDATE kernel.approval_requests SET status = 'approved' WHERE id = ${a1}`
    await expect(
      executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: `@ref:${a1}:value` },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    ).rejects.toThrow(/approved and has run/)
  })

  it("a rejected source says to propose the whole sequence again", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await sql`UPDATE kernel.approval_requests SET status = 'rejected' WHERE id = ${a1}`
    await expect(
      executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: `@ref:${a1}:value` },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    ).rejects.toThrow(/propose the whole sequence again as new calls/)
  })

  it("a ref to an unknown approval says where the token comes from", async () => {
    await expect(
      executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: "@ref:99999999-9999-4999-8999-999999999999:value" },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    ).rejects.toThrow(/not found in this conversation.*`outputs`/)
  })

  it("a near-miss reference is refused with the expected form, before anything is staged", async () => {
    let caught: (Error & { code?: string }) | null = null
    try {
      await executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: "{{step1.value}}", attach: ["@ref:<approval1>:value"] },
        threadId: THREAD,
        origin: "in-app-agent",
      })
    } catch (err) {
      caught = err as Error & { code?: string }
    }
    expect(caught?.code).toBe("invalid_ref")
    expect(caught?.message).toContain('note holds "{{step1.value}}"')
    expect(caught?.message).toContain("@ref:<approvalRequestId>:<output_key>")
    const [{ n }] =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(n).toBe(0)
  })

  it("the gated result's hint shows this call's own token", async () => {
    const r = await executeTool({
      toolName: "seq_test:step1",
      orgId: ORG,
      actor,
      params: { kind: "x" },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const id = r.blocked!.approvalRequestId!
    expect(r.blocked!.outputs).toEqual({ value: `@ref:${id}:value` })
    expect(r.blocked!.hint).toContain(`"@ref:${id}:value"`)
  })

  it("rejects a ref whose output key is not a declared referenceableOutput", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await expect(
      executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor,
        params: { note: `@ref:${a1}:bogus_key` },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    ).rejects.toThrow(new RegExp(`no referenceable output "bogus_key".*"@ref:${a1}:value"`))
  })

  it("rejects a ref to an approval requested by a different user", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await expect(
      executeTool({
        toolName: "seq_test:step2",
        orgId: ORG,
        actor: { ...actor, userId: USER2 },
        params: { note: `@ref:${a1}:value` },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    ).rejects.toThrow(/invalid_ref/)
  })
})
