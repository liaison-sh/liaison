// SPDX-License-Identifier: FSL-1.1-ALv2
// Return-label chain composes into ONE compound approval over the MCP dispatch
// path (gestalt scenario for the mcp-parity fix).
//
// The real warranty-return-label flow stages four tools in one approval; the
// middle boxtal step is NON-GATED but still defers on its @ref (Fix D):
//   invoicing:proforma_create_and_issue  (gated;     produces a document id)
//     -> boxtal:create_shipment          (gated;     draft_id = @ref proforma document id, is_return)
//       -> boxtal:import_label_document  (NON-gated; id = @ref boxtal_order_id — defers anyway)
//         -> tickets:reply               (gated;     attachments = [@ref label_file_id])
//
// A live round trip through those four bundled apps needs Boxtal + invoicing +
// tickets credentials and real upstream calls -- infeasible in an e2e. So this
// asserts the CHAINING + BUNDLING mechanism (the part Fix A restored for MCP)
// with test-app sequencing fixtures shaped exactly like that chain: each step
// declares a referenceableOutput and consumes the prior step's @ref token,
// driven entirely through handleToolCall (the MCP tools/call dispatch entry).
// The boxtal-specific no-anchor path is covered by the boxtal handler test
// (bundled-apps/boxtal/src/shipment.test.ts) plus manual prod validation.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { deferrableRef } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  cleanupSeededOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

// Four tools shaped like the return chain: each produces a referenceable
// output and (except the head) consumes the prior step's @ref token. The middle
// `importLabel` is NON-gated (the import_label_document analogue) to prove a
// non-gated @ref step still defers into the bundle. Registered under the `chain`
// app so resolveCanonical maps chain__stepN.
function registerReturnChainFixtures(orgId: string) {
  const write = "test:gated:write" // reuse the scope the seeded owner already holds
  toolRegistry.set([orgId, "chain", "proforma"], {
    appName: "chain",
    name: "proforma",
    description: "Return chain: proforma create",
    requiredScopes: [write],
    gated: true,
    referenceableOutputs: ["document_id"],
    handler: async () => ({ document_id: "doc-1" }),
  } as any)
  toolRegistry.set([orgId, "chain", "createShipment"], {
    appName: "chain",
    name: "createShipment",
    description: "Return chain: create shipment (is_return) from proforma",
    requiredScopes: [write],
    gated: true,
    referenceableOutputs: ["boxtal_order_id"],
    params: z.object({ draft_id: deferrableRef(z.string()), is_return: z.boolean().optional() }),
    handler: async () => ({ boxtal_order_id: "bx-1" }),
  } as any)
  // Middle step is NON-GATED — mirrors the real boxtal `import_label_document`
  // (gated:false, declares referenceableOutputs). Fix D: it must still DEFER
  // into the bundle on the strength of its @ref alone (deferral is orthogonal
  // to gating), landing as a `deferred` row that cascades under the head's one
  // approval — not execute inline against the literal placeholder.
  toolRegistry.set([orgId, "chain", "importLabel"], {
    appName: "chain",
    name: "importLabel",
    description: "Return chain: import label document",
    requiredScopes: [write],
    gated: false,
    referenceableOutputs: ["label_file_id"],
    params: z.object({ id: deferrableRef(z.string()) }),
    handler: async () => ({ label_file_id: "file-1" }),
  } as any)
  toolRegistry.set([orgId, "chain", "reply"], {
    appName: "chain",
    name: "reply",
    description: "Return chain: reply with the label attached",
    requiredScopes: [write],
    gated: true,
    params: z.object({ attachments: z.array(deferrableRef(z.string())) }),
    handler: async (p: any) => ({ replied: true, attachments: p.attachments }),
  } as any)
}

async function makeCtx(seed: {
  orgId: string
  ownerId: string
  scopes: string[]
}): Promise<ToolCallCtx> {
  const actor = userContextFor(seed.orgId, seed.ownerId, seed.scopes)
  const conn = await seedMcpConnection({
    orgId: seed.orgId,
    userId: seed.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  return {
    orgId: seed.orgId,
    actor,
    connectionId: conn.id,
    ownerUserId: seed.ownerId,
    connectionThreadId: null,
    discovered: new Set(),
  }
}

describe("MCP return chain composes into one compound approval", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })
  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      toolRegistry.deleteByPrefix([o])
      await cleanupSeededOrg(o)
    }
  })
  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("stages proforma -> create_shipment -> import_label -> reply as ONE bundle with refs recorded, each MCP block carrying outputs", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    registerReturnChainFixtures(seed.orgId)
    const ctx = await makeCtx(seed)

    // 1. proforma -- head of the chain, declares document_id.
    const proforma = (await handleToolCall(ctx, "chain__proforma", {})).structuredContent as any
    expect(proforma.gated).toBe(true)
    expect(proforma.outputs.document_id).toBe(`@ref:${proforma.approvalRequestId}:document_id`)

    // 2. create_shipment -- draft_id = @ref proforma document_id, is_return.
    const shipment = (
      await handleToolCall(ctx, "chain__createShipment", {
        draft_id: proforma.outputs.document_id,
        is_return: true,
      })
    ).structuredContent as any
    expect(shipment.gated).toBe(true)
    expect(shipment.outputs.boxtal_order_id).toBe(
      `@ref:${shipment.approvalRequestId}:boxtal_order_id`,
    )

    // 3. import_label -- id = @ref boxtal_order_id. This step is NON-GATED yet
    //    still DEFERS (Fix D): the MCP block reports the call as pending
    //    (`gated:true` here means "blocked, awaiting the bundle's approval", not
    //    the tool's own gated attribute) and flags it `sequenced` -- it lands as
    //    a deferred bundle row (asserted in the DB state below), never executed
    //    inline against the literal placeholder.
    const label = (
      await handleToolCall(ctx, "chain__importLabel", { id: shipment.outputs.boxtal_order_id })
    ).structuredContent as any
    expect(label.gated).toBe(true) // pending under the bundle, not run inline
    expect(label.sequenced).toBe(true) // deferred on its @ref despite gated:false
    expect(label.outputs.label_file_id).toBe(`@ref:${label.approvalRequestId}:label_file_id`)

    // 4. reply -- attachments = [@ref label_file_id]. reply declares no
    //    referenceableOutputs, so the MCP layer surfaces no outputs on it -- the
    //    binding contract is the DB bundle state below.
    const reply = (
      await handleToolCall(ctx, "chain__reply", { attachments: [label.outputs.label_file_id] })
    ).structuredContent as any
    expect(reply.gated).toBe(true)

    // Binding: all FOUR approvals join ONE bundle. The head is pending at
    // position 0; the three dependents are deferred, each depending on its
    // predecessor, positions 1..3, with the @ref recorded in current_payload.
    const rows = (await sql`
      SELECT id, bundle_id, bundle_position, depends_on_id, status, current_payload
      FROM kernel.approval_requests WHERE org_id = ${seed.orgId}
      ORDER BY bundle_position`) as Array<{
      id: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
      status: string
      current_payload: any
    }>
    expect(rows).toHaveLength(4)
    const bundleId = rows[0].bundle_id
    expect(bundleId).toBeTruthy()
    // ONE bundle for all four.
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1)
    expect(rows.map((r) => r.bundle_position)).toEqual([0, 1, 2, 3])
    // Head pending, rest deferred behind their predecessor.
    expect(rows[0].status).toBe("pending")
    expect(rows[0].depends_on_id).toBeNull()
    expect(rows[1].status).toBe("deferred")
    expect(rows[1].depends_on_id).toBe(proforma.approvalRequestId)
    expect(rows[2].status).toBe("deferred")
    expect(rows[2].depends_on_id).toBe(shipment.approvalRequestId)
    expect(rows[3].status).toBe("deferred")
    expect(rows[3].depends_on_id).toBe(label.approvalRequestId)

    // Refs recorded verbatim in each dependent's payload.
    expect(JSON.stringify(rows[1].current_payload)).toContain(
      `@ref:${proforma.approvalRequestId}:document_id`,
    )
    expect(JSON.stringify(rows[2].current_payload)).toContain(
      `@ref:${shipment.approvalRequestId}:boxtal_order_id`,
    )
    expect(JSON.stringify(rows[3].current_payload)).toContain(
      `@ref:${label.approvalRequestId}:label_file_id`,
    )
  }, 60_000)
})
