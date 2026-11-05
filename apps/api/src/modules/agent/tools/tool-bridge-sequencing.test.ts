// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { assertReferenceableOutputs, toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000a3001"
const USER = "00000000-0000-4000-8000-0000000a3002"
const THREAD = "00000000-0000-4000-8000-0000000a3003"

const agentActor: ActorContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

describe("tool-bridge sequencing passthrough", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Bridge Seq Org', 'bridge-seq-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'bridge-seq@test.com', 'Agent', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'bridge-seq-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  })
  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("passes a gated tool's referenceable outputs to the agent as @ref tokens", async () => {
    toolRegistry.set([ORG, "seq_test", "step1"], {
      appName: "seq_test",
      name: "step1",
      description: "seq step 1",
      requiredScopes: ["seq_test:write"],
      gated: true,
      referenceableOutputs: ["value", "tracking_number"],
      handler: async () => ({}),
    } as any)

    const tools = buildToolSet(ORG, agentActor, THREAD, ALL_DEFERRED_TOOLS_UNLOCKED)
    const result = (await tools.seq_test__step1.execute({ kind: "x" }, {})) as any

    expect(result.blocked).toBe(true)
    expect(result.approvalRequestId).toBeTruthy()
    expect(result.outputs.value).toBe(`@ref:${result.approvalRequestId}:value`)
    expect(result.outputs.tracking_number).toBe(`@ref:${result.approvalRequestId}:tracking_number`)
    expect(typeof result.hint).toBe("string")
    expect(result.hint).toMatch(/@ref token/)
    toolRegistry.deleteByPrefix([ORG])
  })

  it("rejects a non-lowercase referenceableOutput key at registration validation", () => {
    expect(() => assertReferenceableOutputs("seq_test:bad", ["labelPdf"])).toThrow(
      /lowercase snake_case/,
    )
    expect(() => assertReferenceableOutputs("seq_test:ok", ["label_pdf"])).not.toThrow()
  })
})
