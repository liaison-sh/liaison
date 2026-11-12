// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { approvalPolicies, auditLog, mcpConnections, threads } from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { env } from "~/lib/env"
import { EXTERNAL_CONTENT_NOTICE } from "~/lib/external-content"
import { redis } from "~/lib/redis"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import * as agentServiceModule from "~/modules/agent/runtime/agent-service"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { currentRunContext, type RunContext } from "~/modules/agent/runtime/run-context"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { resolveApprovalRef } from "~/modules/approvals/resolve-ref"
import { appCrossAppCallsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  connectionTaintWindowId,
  mcpTurnTaintKey,
  revokeConnection,
} from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  gatedTicketTool,
  mutatingTicketTool,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithSeparateApprover,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import {
  APPROVAL_URL_NOTE,
  handleToolCall,
  OUTSIDE_TEXT_KEY,
  type ToolCallCtx,
} from "~/modules/mcp/tool-call"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import { drainOutbox } from "~/tests/helpers/outbox"

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

/** A write the scope taint parks for approval (scope-taint.ts, rule 8): accepted, not run. */
function expectParked(res: { isError?: boolean; structuredContent?: unknown }): void {
  const out = res.structuredContent as { code?: string; gated?: boolean; executed?: boolean }
  expect(out.code).not.toBe("E_SCOPE_TAINT_BLOCKED")
  expect(out.gated).toBe(true)
  expect(out.executed).toBe(false)
}

describe("mcp tools/call", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
    resetEventBus()
    initEventBus()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as any)
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("non-gated parity: handleToolCall matches buildToolSet().execute()", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    // create one item via the agent path
    const agentSet = buildToolSet(seed.orgId, ctx.actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const sdk = Object.keys(agentSet).find((k) => k.startsWith("test__createItem"))!
    const agentRes = await agentSet[sdk].execute(mutatingTicketTool.validParams)

    const mcpRes = await handleToolCall(ctx, sdk, mutatingTicketTool.validParams)
    expect(mcpRes.isError).toBeFalsy()
    const mcpData = mcpRes.structuredContent as any
    // Both create a test item with the same title.
    expect(mcpData.title).toBe((agentRes as any).title)
  }, 30_000)

  it("non-gated READ parity: MCP result DEEP-EQUALS the in-app agent result (same UserContext, spec criterion 4/9)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    // Seed deterministic data to read back.
    const agentSet = buildToolSet(seed.orgId, ctx.actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const createSdk = Object.keys(agentSet).find((k) => k.startsWith("test__createItem"))!
    await agentSet[createSdk].execute({ title: "Parity row A", team: "alpha" })
    await agentSet[createSdk].execute({ title: "Parity row B", team: "alpha" })

    // Same UserContext INSTANCE drives both paths (structural parity — not two
    // separately-constructed equivalent contexts).
    const readSdk = Object.keys(agentSet).find((k) => k.startsWith("test__listItems"))!
    const agentRead = await agentSet[readSdk].execute({})
    const mcpRead = await handleToolCall(ctx, readSdk, {})

    expect(mcpRead.isError).toBeFalsy()
    // The spec's pass bar is a DEEP-equal result payload, not one field. The
    // MCP text payload is JSON.stringify(result.data) — it must equal the
    // in-app agent's returned data exactly (same rows, same RLS, same order).
    const mcpPayload = JSON.parse(mcpRead.content[0].text)
    expect(mcpPayload).toEqual(agentRead)
    // listItems returns a raw ARRAY. Per the MCP spec, `structuredContent`
    // MUST be an object (record), never an array — an array there breaks
    // MCP clients client-side ("expected record, received array"). The
    // fix omits `structuredContent` for non-object results and relies on
    // the (unchanged) `content` text block instead.
    expect(Array.isArray(mcpPayload)).toBe(true)
    expect(mcpRead.structuredContent).toBeUndefined()
  }, 30_000)

  it("array-returning tool omits structuredContent (MCP spec: structuredContent must be a record, not an array) while content text is unchanged", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const agentSet = buildToolSet(seed.orgId, ctx.actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const readSdk = Object.keys(agentSet).find((k) => k.startsWith("test__listItems"))!

    const res = await handleToolCall(ctx, readSdk, {})

    expect(res.isError).toBeFalsy()
    // structuredContent must be either absent or a plain object — never an
    // array or other non-record value (this is what broke MCP clients).
    if (res.structuredContent !== undefined) {
      expect(Array.isArray(res.structuredContent)).toBe(false)
      expect(typeof res.structuredContent).toBe("object")
    } else {
      expect(res.structuredContent).toBeUndefined()
    }
    // The text content block still carries the full array payload untouched.
    expect(Array.isArray(JSON.parse(res.content[0].text))).toBe(true)
  }, 30_000)

  it("object-returning tool keeps structuredContent as the object (unchanged behavior)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)

    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toBeDefined()
    expect(Array.isArray(res.structuredContent)).toBe(false)
    expect(typeof res.structuredContent).toBe("object")
    expect((res.structuredContent as any).title).toBe(mutatingTicketTool.validParams.title)
  }, 30_000)

  it("gated tool → approval_required structured result + approval row on connection thread", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const sdk = "test__gatedEcho"

    const res = await handleToolCall(ctx, sdk, gatedTicketTool.validParams)
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.executed).toBe(false)
    expect(sc.approvalRequestId).toBeTruthy()
    // The human-visible `request-N` label rides along with the uuid: it is what
    // the approval card prints and what the agent must cite to the user.
    expect(sc.approvalHandle).toMatch(/^request-\d+$/)
    expect(sc.message).toContain("approvalHandle")
    expect(typeof sc.selfApproveEligible).toBe("boolean")
    // The gated message must not stop at "pending": it has to tell the agent WHO
    // unblocks this, or the agent reports a bare "en attente", nobody is asked to
    // decide, and the user reads the silence as a broken platform (2026-09-11).
    // This owner IS in the decision audience, so the message must say they can
    // decide it themselves and that nothing runs until they do.
    expect(sc.message).toContain("WHO MUST ACT")
    expect(sc.message).toContain("IS an eligible approver")
    expect(sc.message).not.toContain("NOT an eligible approver")
    // And the complaint route: a later "it never happened" is answered by reading
    // the queue, never by re-staging the work (which is what stacks duplicates).
    expect(sc.message).toContain("kernel__approvals_list")
    expect(sc.approvalUrl).toContain(ctx.connectionThreadId)
    // The link lands on the sign-in page in a browser with no Liaison session
    // (Claude's own browser): the result says so, and that it comes back here.
    expect(sc.approvalUrlNote).toBe(APPROVAL_URL_NOTE)
    // Not a send from an encrypted mailbox, so no unlock instruction.
    expect(sc.mailboxSealed).toBeUndefined()

    // The same reference, once the payload is a sealed mail send, says so: only
    // a window holding that mailbox's key can approve it into a send.
    expect((await resolveApprovalRef(seed.orgId, sc.approvalRequestId))?.mailboxSealed).toBe(false)
    await sql`UPDATE kernel.approval_requests
      SET current_payload = current_payload || '{"mailboxSealed": true}'::jsonb
      WHERE id = ${sc.approvalRequestId}`
    expect((await resolveApprovalRef(seed.orgId, sc.approvalRequestId))?.mailboxSealed).toBe(true)

    const [conn] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, ctx.connectionId)),
    )
    expect(conn.threadId).toBeTruthy()
  }, 30_000)

  it("gated, owner NOT eligible approver → approvalUrl targets the originating (connection) thread, selfApproveEligible false (B2)", async () => {
    const seed = await seedOrgWithSeparateApprover()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.executed).toBe(false)
    expect(sc.selfApproveEligible).toBe(false)
    // Same seam, opposite audience: telling THIS user to "approve it" is a dead
    // end, so the message must say they cannot unblock it and name who it waits on.
    expect(sc.message).toContain("WHO MUST ACT")
    expect(sc.message).toContain("NOT an eligible approver")
    expect(sc.message).toContain("It was sent for a decision to MCP Approver.")
    expect(sc.approvalRequestId).toBeTruthy()

    // Approvals never create a separate thread per request: the approval
    // surfaces inline on its originating thread and stays there, so
    // thread_id == originating_thread_id == the connection thread here.
    const [appr] = await sql`
      SELECT thread_id, originating_thread_id
      FROM kernel.approval_requests WHERE id = ${sc.approvalRequestId}`
    expect(appr.thread_id).toBe(appr.originating_thread_id)
    expect(appr.thread_id).toBe(ctx.connectionThreadId)
    expect(sc.approvalUrl).toBe(`${env.BASE_URL}/threads/${appr.thread_id}`)
    expect(sc.approvalUrl).toContain(ctx.connectionThreadId!)
  }, 30_000)

  it("gated tool declaring referenceableOutputs returns @ref outputs + hint over MCP (Fix A)", async () => {
    // Fix A: the MCP blocked result must carry the engine-minted `outputs`
    // (@ref tokens) + `hint` so an external client can stage a dependent
    // action. Before the fix MCP dropped them and an external agent could only
    // ever stage ORPHAN approvals (the return-label token-runaway class).
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    const res = await handleToolCall(ctx, "test__gatedProduce", { seed: "alpha" })
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.executed).toBe(false)
    expect(sc.approvalRequestId).toBeTruthy()
    // outputs is a token map: gatedProduce declares referenceableOutputs ["value"].
    expect(sc.outputs).toBeDefined()
    expect(typeof sc.outputs.value).toBe("string")
    // The token references THIS approval so a later call can chain off it.
    expect(sc.outputs.value).toBe(`@ref:${sc.approvalRequestId}:value`)
    // A non-empty self-teaching hint always accompanies outputs.
    expect(typeof sc.hint).toBe("string")
    expect(sc.hint.length).toBeGreaterThan(0)
  }, 30_000)

  it("both gated pending envelope variants name the withdraw repair path (regression guard)", async () => {
    // Locks in the remedy the two blocked-result message variants must carry:
    // an agent that raised a mistaken pending approval has a real way to
    // retract it (kernel__approval_withdraw), not just "do not retry". This
    // must not be silently reworded out of either variant.
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    // Variant without outputs (test__gatedEcho declares none).
    const plain = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
    const plainSc = plain.structuredContent as any
    expect(plainSc.message).toContain("kernel__approval_withdraw")

    // Variant with outputs (test__gatedProduce declares referenceableOutputs).
    const withOutputs = await handleToolCall(ctx, "test__gatedProduce", { seed: "beta" })
    const outputsSc = withOutputs.structuredContent as any
    expect(outputsSc.message).toContain("kernel__approval_withdraw")
  }, 30_000)

  it("two-call MCP chain: consuming an @ref output bundles both approvals into ONE compound approval (Fix A)", async () => {
    // Mirror the in-app sequencing contract (sequenced-approval.test.ts) but
    // exercised entirely through handleToolCall: produce -> copy outputs.value
    // verbatim into the consumer's param -> both approvals join one bundle, the
    // consumer deferred behind the pending head. This is the one-approval @ref
    // chaining power Fix A grants MCP clients.
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    const produce = (await handleToolCall(ctx, "test__gatedProduce", { seed: "beta" }))
      .structuredContent as any
    expect(produce.gated).toBe(true)
    const token = produce.outputs.value as string
    expect(token).toContain("@ref:")

    // Copy the token VERBATIM into the consuming gated tool's param.
    const consume = (
      await handleToolCall(ctx, "test__gatedConsume", { note: token, label: "reply-label" })
    ).structuredContent as any
    expect(consume.gated).toBe(true)
    // Note: the MCP layer only echoes the `sequenced` flag alongside `outputs`
    // (tool-call.ts). gatedConsume declares no referenceableOutputs, so it has no
    // outputs and the flag is not surfaced on the consumer response -- the binding
    // contract is the DB bundle state below, not a response field.

    // Binding assertion: the org holds ONE bundle -- the consumer is a deferred
    // step depending on the pending head at bundle_position 0.
    const rows = (await sql`
      SELECT id, bundle_id, bundle_position, depends_on_id, status
      FROM kernel.approval_requests WHERE org_id = ${seed.orgId}
      ORDER BY bundle_position`) as Array<{
      id: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
      status: string
    }>
    expect(rows).toHaveLength(2)
    const head = rows.find((r) => r.id === produce.approvalRequestId)!
    const step = rows.find((r) => r.id === consume.approvalRequestId)!
    // Both share the SAME bundle (one compound approval).
    expect(head.bundle_id).toBe(head.id)
    expect(step.bundle_id).toBe(head.id)
    expect(head.bundle_position).toBe(0)
    expect(head.status).toBe("pending")
    expect(step.bundle_position).toBe(1)
    expect(step.depends_on_id).toBe(head.id)
    expect(step.status).toBe("deferred")
  }, 30_000)

  it("non-gated @ref call provisions the connection thread so it can sequence (not 'threadId required')", async () => {
    const seed = await seedOrgWithTicketsApp()
    const ctx = await makeCtx(seed)
    expect(ctx.connectionThreadId).toBeNull()
    // A NON-gated tool carrying an @ref must DEFER into the approval bundle, which
    // needs a threadId. tool-call previously provisioned the connection thread only
    // for gated/taint tools, so a non-gated sequenced step (e.g. boxtal
    // import_label_document mid-chain) errored "threadId required". Now the thread
    // is provisioned for @ref-bearing calls too, so the call reaches the sequencing
    // path; the fake ref then fails as a clean invalid_ref, NOT a forbidden/threadId
    // error (which is what proves the thread was provisioned first).
    const res = await handleToolCall(ctx, "test__createItem", {
      title: "@ref:11111111-1111-4111-8111-111111111111:value",
      team: "x",
    })
    const sc = res.structuredContent as any
    expect(ctx.connectionThreadId).not.toBeNull() // provisioned for the @ref call
    expect(sc.code).toBe("invalid_ref") // reached sequencing, not "forbidden"/threadId
  }, 30_000)

  it("policy-tightened gating over MCP provisions the thread + stages an approval (not 'threadId required')", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // test:createItem declares NO static `gated` flag (like knowledge:update). An
    // org approval-tightening policy escalates it to gated at runtime
    // (execute-tool's effectiveGated). Dispatch's static prefilter cannot see this,
    // so the call reached executeTool with no thread and used to surface a
    // "threadId required" forbidden error. The fix retries once with a provisioned
    // thread. conditions:[] → conditionsPass([]) is true → the policy matches
    // unconditionally.
    await withSystemDb("t", (db) =>
      db.insert(approvalPolicies).values({
        orgId: seed.orgId,
        toolName: "test:createItem",
        enabled: true,
        conditions: [],
        requireApproval: true,
        minApprovers: 1,
        createdBy: seed.ownerId,
      }),
    )
    const ctx = await makeCtx(seed)
    expect(ctx.connectionThreadId).toBeNull() // not provisioned by the static prefilter

    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    const sc = res.structuredContent as any
    // The thread was provisioned on the retry, and the call reached the gate:
    // a pending approval, NOT a forbidden/"threadId required" error.
    expect(ctx.connectionThreadId).not.toBeNull()
    expect(sc.code).not.toBe("forbidden")
    expect(sc.gated).toBe(true)
    expect(sc.executed).toBe(false)
    expect(sc.approvalRequestId).toBeTruthy()

    // Clean up the policy + the approval it created before the org cleanup runs
    // (approved_handler_executions FK-references approval_requests).
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${seed.orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${seed.orgId}`
    await withSystemDb("t", (db) =>
      db.delete(approvalPolicies).where(eq(approvalPolicies.orgId, seed.orgId)),
    )
  }, 30_000)

  // The connection thread is LAZY on purpose: it is the surface an approval
  // lands on, and a connection that never stages one needs no conversation. The
  // prefilter briefly stood a guess in for the policy ("anything that is not
  // read-only might be gated"), which provisioned a thread for every MCP
  // connection that ever wrote anything. Both halves are pinned here: the tool
  // that is gated only by an org policy gets its thread BEFORE the call, and the
  // plain ungated write gets nothing.
  it("an ungated write tool over MCP provisions no connection thread", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(res.isError).toBeFalsy()
    expect((res.structuredContent as any).gated).not.toBe(true)
    expect(ctx.connectionThreadId).toBeNull()
    const [conn] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, ctx.connectionId)),
    )
    expect(conn.threadId).toBeNull()
  }, 30_000)

  it("a write tool the org policy gates gets its connection thread before the call", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await withSystemDb("t", (db) =>
      db.insert(approvalPolicies).values({
        orgId: seed.orgId,
        toolName: "test:createItem",
        enabled: true,
        conditions: [],
        requireApproval: true,
        minApprovers: 1,
        createdBy: seed.ownerId,
      }),
    )
    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.approvalRequestId).toBeTruthy()
    // Provisioned by the prefilter, so the approval parks on the CONNECTION's
    // own thread. Asked too late, execute-tool auto-creates a per-approval
    // surface instead and the agent has no conversation to watch it in.
    expect(ctx.connectionThreadId).toBeTruthy()
    const [appr] = await sql`
      SELECT thread_id FROM kernel.approval_requests WHERE id = ${sc.approvalRequestId}`
    expect(appr.thread_id).toBe(ctx.connectionThreadId)

    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${seed.orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${seed.orgId}`
    await withSystemDb("t", (db) =>
      db.delete(approvalPolicies).where(eq(approvalPolicies.orgId, seed.orgId)),
    )
  }, 30_000)

  it("unknown sdkName → tool_not_found error result (not a throw)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__doesNotExist", {})
    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).code).toBe("tool_not_found")
  }, 30_000)

  it("missing scope → forbidden error result", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // Strip scopes so executeTool rejects with 403.
    const ctx = await makeCtx({ ...seed, scopes: [] })
    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).code).toBe("forbidden")
  }, 30_000)

  it("audit C7 split: non-gated MCP mutation = actorType:'mcp'", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    await drainOutbox()
    const rows = await withSystemDb("t", (db) =>
      db.select().from(auditLog).where(eq(auditLog.orgId, seed.orgId)),
    )
    const mutations = rows.filter((r) => r.app === "test" && r.action !== "approve")
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every((r) => r.actorType === "mcp")).toBe(true)
  }, 30_000)

  it("liaison_call_tool runs a tool granted after the session loaded its tool list", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // The list the client loaded at session start, before the grant: no app tool.
    const before = await listMcpTools({
      orgId: seed.orgId,
      actor: userContextFor(seed.orgId, seed.ownerId, []),
    })
    expect(before.some((t) => t.name === "test__listItems")).toBe(false)
    expect(before.some((t) => t.name === "liaison_call_tool")).toBe(true)
    // Same connection after the grant: the dispatcher reaches the new tool.
    const ctx = await makeCtx(seed)
    const described = await handleToolCall(ctx, "liaison_call_tool", { name: "test__listItems" })
    expect(described.isError).toBeFalsy()
    expect((described.structuredContent as any).inputSchema.type).toBe("object")
    const viaDispatcher = await handleToolCall(ctx, "liaison_call_tool", {
      name: "test__listItems",
      arguments: {},
    })
    // On a second connection: the test app's listItems is not marked read-only, so a second
    // call on the first connection is judged as a write on a tainted window (rule 14).
    const direct = await handleToolCall(await makeCtx(seed), "test__listItems", {})
    expect(viaDispatcher.isError).toBeFalsy()
    expect(viaDispatcher.content).toEqual(direct.content)
  }, 30_000)

  it("W3-D4: liaison_call_tool describes an agent-bound-only tool on a plain connection, as the call path resolves it", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await registerKernelAgentTools(seed.orgId)
    const ctx = await makeCtx({
      ...seed,
      scopes: [...seed.scopes, "kernel:threads:read", "kernel:threads:write"],
    })
    const listed = await listMcpTools({ orgId: seed.orgId, actor: ctx.actor })
    expect(listed.some((t) => t.name === "kernel__computer_session_send")).toBe(false)
    for (const name of ["kernel__computer_session_send", "kernel__computer_session_stop"]) {
      const described = await handleToolCall(ctx, "liaison_call_tool", { name })
      expect(described.isError).toBeFalsy()
      const schema = (described.structuredContent as any).inputSchema
      expect(schema.type).toBe("object")
      expect(Object.keys(schema.properties)).toContain("sessionId")
    }
    // Still the caller's permissions: without the scope it is not found.
    const scopeless = await makeCtx({ ...seed, scopes: [] })
    const hidden = await handleToolCall(scopeless, "liaison_call_tool", {
      name: "kernel__computer_session_send",
    })
    expect((hidden.structuredContent as any).code).toBe("tool_not_found")
  }, 30_000)

  it("liaison_call_tool keeps the caller's permissions", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx({ ...seed, scopes: [] })
    const described = await handleToolCall(ctx, "liaison_call_tool", { name: "test__createItem" })
    expect((described.structuredContent as any).code).toBe("tool_not_found")
    const res = await handleToolCall(ctx, "liaison_call_tool", {
      name: "test__createItem",
      arguments: mutatingTicketTool.validParams,
    })
    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).code).toBe("forbidden")
    const meta = await handleToolCall(ctx, "liaison_call_tool", {
      name: "liaison_call_tool",
      arguments: {},
    })
    expect((meta.structuredContent as any).code).toBe("invalid_params")
  }, 30_000)

  it("liaison_tool_search records discovery; lazy thread stays null for read-only", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    // A deliberately broad query: every hit must come back as a compact index
    // entry (name + one-line description + score), never a full description/
    // schema dump, and the whole result must stay inside the byte budget.
    const res = await handleToolCall(ctx, "liaison_tool_search", {
      query: "update create list search document",
    })
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as any
    expect(Array.isArray(sc.tools)).toBe(true)
    expect(JSON.stringify(sc).length).toBeLessThan(8_000)
    for (const t of sc.tools) {
      expect(typeof t.name).toBe("string")
      expect(t.description.length).toBeLessThanOrEqual(140)
      expect(Object.keys(t).sort()).toEqual(["description", "name", "score"])
    }
    // No gated call → connection thread never provisioned.
    const conns =
      await sql`SELECT thread_id FROM kernel.mcp_connections WHERE id = ${ctx.connectionId}`
    expect(conns[0].thread_id).toBeNull()
  }, 30_000)

  // A declared `cross_app_calls` target belongs to the APP, but only a tool that
  // can actually make a call reaches one. Read the declaration at the app level
  // and every tool of boxtal, invoicing, shopify, ads and calls provisions a
  // connection thread, reads included, before the policy is ever asked, which is
  // the opposite of the laziness the comment above claims.
  it("a READ tool of an app declaring a cross-app target provisions no thread", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    appCrossAppCallsRegistry.set([seed.orgId, "test"], { targets: ["other:gatedSend"] })
    toolRegistry.set([seed.orgId, "test", "crossAppRead"], {
      appName: "test",
      name: "crossAppRead",
      description: "A read of an app that declares a cross-app target",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async () => ({ items: [] }),
    })

    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__crossAppRead", {})
    expect(res.isError).toBeFalsy()
    expect(ctx.connectionThreadId).toBeNull()
    const [conn] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, ctx.connectionId)),
    )
    expect(conn.threadId).toBeNull()
  }, 30_000)

  it("a WRITE tool of the same app still provisions its thread before the call", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    appCrossAppCallsRegistry.set([seed.orgId, "test"], { targets: ["other:gatedSend"] })
    toolRegistry.set([seed.orgId, "test", "crossAppWrite"], {
      appName: "test",
      name: "crossAppWrite",
      description: "A write that can reach the declared cross-app target",
      requiredScopes: ["test:items:write"],
      handler: async () => ({ ok: true }),
    })

    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__crossAppWrite", {})
    expect(res.isError).toBeFalsy()
    // The nested gated call needs a thread to park its approval on, and it has
    // to exist BEFORE the call: asked afterwards it is refused with
    // "threadId required" and the calling app rewrites that into its own error.
    expect(ctx.connectionThreadId).toBeTruthy()
  }, 30_000)

  // The prefilter and execute-tool must answer the same question. The prefilter
  // asked the policy about the RAW MCP arguments while execute-tool asks about
  // the validated ones, so any condition on a field the validator changes read
  // as absent here and as present a moment later: the call was gated, and its
  // approval landed on a thread the agent never sees because the prefilter had
  // concluded no thread was needed.
  //
  // This case covers the KERNEL/Zod branch, where `z.default()` supplies the
  // value at PARSE time, so the policy and the approval card see it too.
  //
  // Manifest tools are the other branch and now answer differently on purpose
  // (A47): validation still runs ajv with neither useDefaults nor coerceTypes,
  // so a manifest `default` is NOT applied at validation and the policy keeps
  // judging what the agent actually sent; the defaults are filled a step later,
  // into the arguments handed to the HANDLER, which is where a declared default
  // is the contract (see modules/apps/manifest-defaults.test.ts, which pins both
  // halves). So no manifest tool can reach the shape this case describes. What
  // the manifest branch does normalise before validation is the weak-model
  // stringified argument, and the case below is that one.
  it("a policy condition answers the same at prefilter and execution: the kernel Zod branch", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    toolRegistry.set([seed.orgId, "test", "defaultedAmount"], {
      appName: "test",
      name: "defaultedAmount",
      description: "A write whose amount has a schema default",
      requiredScopes: ["test:items:write"],
      params: z.object({ amount: z.number().default(100) }),
      handler: async () => ({ ok: true }),
    })
    await withSystemDb("t", (db) =>
      db.insert(approvalPolicies).values({
        orgId: seed.orgId,
        toolName: "test:defaultedAmount",
        enabled: true,
        conditions: [{ path: "amount", op: "gte", value: 50 }],
        requireApproval: true,
        minApprovers: 1,
        createdBy: seed.ownerId,
      }),
    )

    const ctx = await makeCtx(seed)
    // No `amount` on the wire: the schema supplies 100, which the condition
    // matches. The policy has to be asked about the same value execute-tool
    // will act on.
    const res = await handleToolCall(ctx, "test__defaultedAmount", {})
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.approvalRequestId).toBeTruthy()
    expect(ctx.connectionThreadId).toBeTruthy()
    const [appr] = await sql`
      SELECT thread_id FROM kernel.approval_requests WHERE id = ${sc.approvalRequestId}`
    expect(appr.thread_id).toBe(ctx.connectionThreadId)

    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${seed.orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${seed.orgId}`
    await withSystemDb("t", (db) =>
      db.delete(approvalPolicies).where(eq(approvalPolicies.orgId, seed.orgId)),
    )
  }, 30_000)

  // The manifest half of the same question. A weak model sends a number as a
  // JSON string; `coerceJsonStringParams` turns it back into a number before
  // validation, so execute-tool judges 75 while the raw arguments say "75", and
  // a numeric condition matches one and not the other. Asked about the raw
  // arguments the prefilter reads the call as ungated, provisions no connection
  // thread, and the approval execute-tool then stages lands where the agent
  // cannot see it.
  it("a policy condition on a coerced manifest param answers the same at prefilter and execution", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    toolRegistry.set([seed.orgId, "test", "coercedAmount"], {
      appName: "test",
      name: "coercedAmount",
      description: "A write whose amount arrives as a stringified number",
      requiredScopes: ["test:items:write"],
      // A manifest tool: a JSON Schema for params and a bundle export for the
      // handler, which is the pair `isManifestHandler` recognises.
      params: {
        type: "object",
        properties: { amount: { type: "number" } },
      },
      handler: { bundlePath: "test/handlers.js", exportName: "coercedAmount" },
    } as never)
    await withSystemDb("t", (db) =>
      db.insert(approvalPolicies).values({
        orgId: seed.orgId,
        toolName: "test:coercedAmount",
        enabled: true,
        conditions: [{ path: "amount", op: "gte", value: 50 }],
        requireApproval: true,
        minApprovers: 1,
        createdBy: seed.ownerId,
      }),
    )

    const ctx = await makeCtx(seed)
    const res = await handleToolCall(ctx, "test__coercedAmount", { amount: "75" })
    const sc = res.structuredContent as any
    expect(sc.gated).toBe(true)
    expect(sc.approvalRequestId).toBeTruthy()
    expect(ctx.connectionThreadId).toBeTruthy()
    const [appr] = await sql`
      SELECT thread_id FROM kernel.approval_requests WHERE id = ${sc.approvalRequestId}`
    expect(appr.thread_id).toBe(ctx.connectionThreadId)

    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${seed.orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${seed.orgId}`
    await withSystemDb("t", (db) =>
      db.delete(approvalPolicies).where(eq(approvalPolicies.orgId, seed.orgId)),
    )
  }, 30_000)

  it("a knowledge read, which taints only for outside documents, gets its connection thread first", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    toolRegistry.set([seed.orgId, "knowledge", "get"], {
      appName: "knowledge",
      name: "get",
      description: "Knowledge read",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async () => ({ ok: true }),
    } as never)
    const res = await handleToolCall(ctx, "knowledge__get", {})
    expect(res.isError).toBeFalsy()
    expect(ctx.connectionThreadId).toBeTruthy()
    // An internal document marked nothing, so the result carries no notice.
    expect(res.content.map((block) => block.text)).not.toContain(EXTERNAL_CONTENT_NOTICE)
  }, 30_000)

  it("taint-source-only session provisions a connection thread and taints it (B19)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    // A NON-GATED taint-source tool (the web_search/web_fetch shape). Before the
    // B19 fix the provisioning guard keyed on `gated` only, so a session calling
    // only this tool never got a connection thread → setTaintFlag had no thread
    // to mark → taint was silently bypassed.
    toolRegistry.set([seed.orgId, "test", "taintSourceOnly"], {
      appName: "test",
      name: "taintSourceOnly",
      description: "Non-gated taint source",
      requiredScopes: ["test:items:read"],
      taintSource: true,
      handler: async () => ({ results: [] }),
    })

    const res = await handleToolCall(ctx, "test__taintSourceOnly", {})
    expect(res.isError).toBeFalsy()

    // The connection thread was provisioned lazily by the taint-source call...
    expect(ctx.connectionThreadId).toBeTruthy()
    const [conn] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, ctx.connectionId)),
    )
    expect(conn.threadId).toBe(ctx.connectionThreadId)

    // ...and executeTool's setTaintFlag marked that thread tainted.
    const [thread] = await withSystemDb("t", (db) =>
      db.select().from(threads).where(eq(threads.id, ctx.connectionThreadId!)),
    )
    expect(thread.tainted).toBe(true)

    // The result says so in its text, where every client sees it (the desktop's
    // local session reads it to stop running shell commands on its own); the
    // tool's own payload stays the first block, byte for byte.
    expect(res.content[0]).toEqual({ type: "text", text: JSON.stringify({ results: [] }) })
    expect(res.content.map((block) => block.text)).toContain(EXTERNAL_CONTENT_NOTICE)
  }, 30_000)

  it("a read that brought no outside text carries no notice", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    toolRegistry.set([seed.orgId, "test", "plainRead"], {
      appName: "test",
      name: "plainRead",
      description: "Non-gated internal read",
      requiredScopes: ["test:items:read"],
      handler: async () => ({ results: [] }),
    })
    const res = await handleToolCall(ctx, "test__plainRead", {})
    expect(res.isError).toBeFalsy()
    expect(res.content.map((block) => block.text)).not.toContain(EXTERNAL_CONTENT_NOTICE)
  }, 30_000)

  it("the notice is decided per call: a later internal read on a marked connection has none", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    toolRegistry.set([seed.orgId, "test", "outsideRead"], {
      appName: "test",
      name: "outsideRead",
      description: "Non-gated taint source",
      requiredScopes: ["test:items:read"],
      taintSource: true,
      handler: async () => ({ body: "from outside" }),
    })
    toolRegistry.set([seed.orgId, "knowledge", "get"], {
      appName: "knowledge",
      name: "get",
      description: "Knowledge read",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async () => ({ ok: true }),
    } as never)
    const first = await handleToolCall(ctx, "test__outsideRead", {})
    expect(first.content.map((block) => block.text)).toContain(EXTERNAL_CONTENT_NOTICE)
    // The same answer in structuredContent and _meta, for a client that reads those.
    expect(first.structuredContent?.[OUTSIDE_TEXT_KEY]).toBe(true)
    expect((first as { _meta?: Record<string, unknown> })._meta?.[OUTSIDE_TEXT_KEY]).toBe(true)
    // The connection's thread stays marked, and the next read that may taint
    // but brought nothing in carries no notice.
    const [thread] = await withSystemDb("t", (db) =>
      db.select().from(threads).where(eq(threads.id, ctx.connectionThreadId!)),
    )
    expect(thread.tainted).toBe(true)
    const second = await handleToolCall(ctx, "knowledge__get", {})
    expect(second.isError).toBeFalsy()
    expect(second.content.map((block) => block.text)).not.toContain(EXTERNAL_CONTENT_NOTICE)
    expect(second.structuredContent?.[OUTSIDE_TEXT_KEY]).toBeUndefined()
  }, 30_000)

  it("an error result whose handler had outside text in hand carries the notice", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    toolRegistry.set([seed.orgId, "knowledge", "get"], {
      appName: "knowledge",
      name: "get",
      description: "Knowledge read",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      handler: async () => {
        // The knowledge bridge marks the turn as soon as it holds an outside
        // document, then this read fails.
        await setTaintFlag(ctx.connectionThreadId!, seed.orgId)
        throw new Error("could not render the document")
      },
    } as never)
    const res = await handleToolCall(ctx, "knowledge__get", {})
    expect(res.isError).toBe(true)
    expect(res.content.map((block) => block.text)).toContain(EXTERNAL_CONTENT_NOTICE)
    expect(res.structuredContent?.[OUTSIDE_TEXT_KEY]).toBe(true)
  }, 30_000)
})

describe("mcp tools/call agent binding", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("a gated call over an agent bound connection records the acting agent on the approval", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    const res = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
    const payload = res.structuredContent as { gated?: boolean; approvalRequestId?: string }
    expect(payload.gated).toBe(true)
    const approvalRequestId = payload.approvalRequestId!
    expect(approvalRequestId).toBeTruthy()

    const [row] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${approvalRequestId}`
    expect(row!.agent_id).toBe(agentId)
  }, 30_000)

  it("the gateway turn frame carries the acting agent's ceiling alongside its id", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling: ["test:items:read"] })
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    // run-context documents agentId and agentCeiling as both present or both
    // absent: a frame naming an agent with no ceiling is a frame no reader can
    // judge the agent's reach from.
    let seen: RunContext | undefined
    toolRegistry.set([seed.orgId, "test", "frameProbe"], {
      appName: "test",
      name: "frameProbe",
      description: "Reports the frame it ran under",
      requiredScopes: ["test:items:read"],
      handler: async () => {
        seen = currentRunContext()
        return { ok: true }
      },
    })

    const res = await handleToolCall(ctx, "test__frameProbe", {})
    expect(res.isError).toBeFalsy()
    expect(seen?.agentId).toBe(agentId)
    expect(seen?.agentCeiling).toEqual(["test:items:read"])
  }, 30_000)

  it("a gated call creates a structurally identical approval row in-app and over MCP", async () => {
    // P3-T19. The same gated tool, the same agent, triggered twice: once
    // through the in-app agent seam (buildToolSet's execute under a run frame
    // naming the agent, the shape agent-service opens) and once through the
    // MCP gateway. The two rows must be the SAME SHAPE: the same columns
    // populated with the same null pattern. Values legitimately differ (a
    // fresh id, a later timestamp, a different thread), so only those three
    // are excluded; anything else drifting means one runtime records an
    // approval the other does not.
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling: seed.scopes })

    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    const rootRunId = crypto.randomUUID()
    const inAppSet = buildToolSet(
      seed.orgId,
      ctx.actor,
      seed.threadId,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      {
        runId: rootRunId,
        parentRunId: null,
        rootRunId,
        nestingDepth: 0,
        background: false,
        agentId,
        agentCeiling: [...seed.scopes],
        effectiveScope: [...seed.scopes],
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
    )
    await inAppSet.test__gatedEcho.execute({ message: "in-app gated" })

    const res = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
    const mcpApprovalId = (res.structuredContent as { approvalRequestId?: string })
      .approvalRequestId!
    expect(mcpApprovalId).toBeTruthy()

    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM kernel.approval_requests WHERE org_id = ${seed.orgId} ORDER BY created_at`
    expect(rows.length).toBe(2)
    const mcpRow = rows.find((r) => r.id === mcpApprovalId)!
    const inAppRow = rows.find((r) => r.id !== mcpApprovalId)!
    // Both rows really do name the agent: a shape comparison between two
    // agentless rows would be vacuous.
    expect(inAppRow.agent_id).toBe(agentId)
    expect(mcpRow.agent_id).toBe(agentId)

    const IGNORED = new Set(["id", "created_at", "thread_id"])
    const shapeOf = (row: Record<string, unknown>) =>
      Object.keys(row)
        .filter((k) => !IGNORED.has(k))
        .sort()
        .map((k) => `${k}=${row[k] === null || row[k] === undefined ? "null" : "set"}`)
    expect(shapeOf(mcpRow)).toEqual(shapeOf(inAppRow))
  }, 30_000)

  it("a legacy connection records no acting agent", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    const res = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
    const payload = res.structuredContent as { approvalRequestId?: string }
    const [row] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${payload.approvalRequestId!}`
    expect(row!.agent_id).toBeNull()
  }, 30_000)
})

describe("mcp tools/call catalog parity on the invoke path", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("a tool hidden from tools-list by the bound agent is refused by tools-call", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const hidden = "test__createItem"
    const { agentId } = await seedAgentForOrg(seed.orgId, { toolDenylist: [hidden] })
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    // The catalog for THIS ctx hides it...
    const names = (await listMcpTools({ orgId: ctx.orgId, actor: ctx.actor, agentId })).map(
      (t) => t.name,
    )
    expect(names).not.toContain(hidden)

    // ...so the invoke path must refuse it, indistinguishably from a name that
    // does not exist (silent omission, D2).
    const res = await handleToolCall(ctx, hidden, mutatingTicketTool.validParams)
    expect(res.isError).toBe(true)
    expect((res.structuredContent as { code?: string }).code).toBe("tool_not_found")
  }, 30_000)

  it("liaison_tool_search never lists a tool the catalog hides", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const hidden = "test__createItem"
    const { agentId } = await seedAgentForOrg(seed.orgId, { toolDenylist: [hidden] })
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    const res = await handleToolCall(ctx, "liaison_tool_search", { query: "create item" })
    const found = (res.structuredContent as { tools?: Array<{ name: string }> }).tools ?? []
    expect(found.map((t) => t.name)).not.toContain(hidden)
    // The search still works: another tool of the same app is still findable.
    const unbounded = await handleToolCall(await makeCtx(seed), "liaison_tool_search", {
      query: "create item",
    })
    const all = (unbounded.structuredContent as { tools?: Array<{ name: string }> }).tools ?? []
    expect(all.map((t) => t.name)).toContain(hidden)
  }, 30_000)

  it("a denylist entry in canonical form hides and refuses the tool over MCP", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // The form `kernel.agents` documents and the in-app tool bridge matches:
    // `app:tool`, never the SDK's `app__tool`.
    const { agentId } = await seedAgentForOrg(seed.orgId, { toolDenylist: ["test:createItem"] })
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    const names = (await listMcpTools({ orgId: ctx.orgId, actor: ctx.actor, agentId })).map(
      (t) => t.name,
    )
    expect(names).not.toContain("test__createItem")

    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(res.isError).toBe(true)
    expect((res.structuredContent as { code?: string }).code).toBe("tool_not_found")

    const search = await handleToolCall(ctx, "liaison_tool_search", { query: "create item" })
    const found = (search.structuredContent as { tools?: Array<{ name: string }> }).tools ?? []
    expect(found.map((t) => t.name)).not.toContain("test__createItem")
  }, 30_000)

  it("an allowlist in canonical form yields the same catalog as in bare form", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const bare = await seedAgentForOrg(seed.orgId, { toolAllowlist: ["test__createItem"] })
    const canonical = await seedAgentForOrg(seed.orgId, { toolAllowlist: ["test:createItem"] })
    const ctx = await makeCtx(seed)

    const bareNames = (
      await listMcpTools({ orgId: ctx.orgId, actor: ctx.actor, agentId: bare.agentId })
    ).map((t) => t.name)
    const canonicalNames = (
      await listMcpTools({ orgId: ctx.orgId, actor: ctx.actor, agentId: canonical.agentId })
    ).map((t) => t.name)
    expect(bareNames).toContain("test__createItem")
    expect(canonicalNames).toEqual(bareNames)
  }, 30_000)

  it("a tool outside the connection's intersected scope is refused by tools-call", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // The scopes an agent-bound connection resolves to: the grantor's set
    // intersected with the agent's ceiling. Here the write scope is outside it.
    const ctx = await makeCtx({ ...seed, scopes: ["test:items:read"] })

    const names = (await listMcpTools({ orgId: ctx.orgId, actor: ctx.actor })).map((t) => t.name)
    expect(names).not.toContain("test__createItem")

    const res = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(res.isError).toBe(true)
    expect((res.structuredContent as { code?: string }).code).toBe("forbidden")
  }, 30_000)
})

describe("mcp tools/call scope taint on an agent bound turn", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("a scoped read followed by an undeclared write in the same turn parks for approval, exactly as the tool bridge parks it (rule 8)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    // 1. A scoped read. Allowed, and it taints the turn.
    const read = await handleToolCall(ctx, "test__listItems", {})
    expect(read.isError).toBeFalsy()

    // 2. A write declaring no enforcing sink, in the SAME turn frame: it never runs inline.
    const write = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expectParked(write)

    // The in-app tool bridge, given the identical sequence under its own frame,
    // answers with the same code — this is parity, not a second rule.
    const accumulator = createTurnScopeAccumulator()
    const frame = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      turnScopeAccumulator: accumulator,
    }
    const bridge = buildToolSet(
      seed.orgId,
      ctx.actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame as never,
    )
    await bridge.test__listItems.execute({})
    const bridgeWrite = (await bridge.test__createItem.execute(mutatingTicketTool.validParams)) as {
      code?: string
      blocked?: boolean
    }
    expect(bridgeWrite.code).toBeUndefined()
    expect(bridgeWrite.blocked).toBe(true)
  }, 30_000)

  it("taint accumulated by one request is carried into the next request on the same connection", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    // TWO ctx objects for ONE connection, the shape production actually
    // produces: the streamable-HTTP transport is stateless, so every POST
    // rebuilds the ctx and the in-memory accumulator dies with the request.
    const first = await makeCtx(seed)
    first.agentId = agentId
    const second: ToolCallCtx = {
      orgId: first.orgId,
      actor: first.actor,
      connectionId: first.connectionId,
      ownerUserId: first.ownerUserId,
      agentId,
      connectionThreadId: null,
      discovered: new Set(),
    }

    const read = await handleToolCall(first, "test__listItems", {})
    expect(read.isError).toBeFalsy()

    const write = await handleToolCall(second, "test__createItem", mutatingTicketTool.validParams)
    expectParked(write)

    // FX2 item 4, the orchestrator's binding decision: the key is
    // `mcp:turn-taint:<orgId>:<agentId>`, not per connection. A DIFFERENT
    // connection bound to the SAME agent is the same external runtime as far as
    // laundering goes, so it inherits the turn's taint and its undeclared write
    // parks too. Under the per-connection key this was the laundering path:
    // read on A, write on B, two untainted turns.
    const other = await makeCtx(seed)
    other.agentId = agentId
    const otherWrite = await handleToolCall(
      other,
      "test__createItem",
      mutatingTicketTool.validParams,
    )
    expectParked(otherWrite)

    // A DIFFERENT AGENT is a different runtime and is untouched by any of it.
    const { agentId: otherAgentId } = await seedAgentForOrg(seed.orgId)
    const stranger = await makeCtx(seed)
    stranger.agentId = otherAgentId
    const strangerWrite = await handleToolCall(
      stranger,
      "test__createItem",
      mutatingTicketTool.validParams,
    )
    expect(strangerWrite.isError).toBeFalsy()

    // CHANGED SEMANTICS with the key (FX1-2 asserted the opposite here):
    // revoking ONE connection no longer deletes the set, because another
    // connection bound to the same agent may still be live and would be handed
    // a clean slate it did not earn. The sliding 15-minute expiry is the only
    // clearing, and the revoked connection can no longer call anything.
    expect(await redis.get(mcpTurnTaintKey(seed.orgId, agentId))).not.toBeNull()
    await revokeConnection(first.connectionId, seed.ownerId)
    expect(await redis.get(mcpTurnTaintKey(seed.orgId, agentId))).not.toBeNull()
  }, 30_000)

  it("after a parked call the turn still carries what it read, exactly as the tool bridge does", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    await handleToolCall(ctx, "test__listItems", {})
    const parked = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expectParked(parked)

    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted.length).toBeGreaterThan(0)
  }, 30_000)

  // FX2 item 5: an UNPARSEABLE persisted value used to read as `[]`, i.e. the
  // positive claim "this turn touched no scoped data" -- the one claim nobody
  // can make about a value nobody could parse. It now reads as unknown taint,
  // which `checkToolScopeTaint` treats as a tainted turn, so the next undeclared
  // write is refused instead of admitted.
  it("an unparseable persisted taint fails CLOSED: the next undeclared write is refused", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    await redis.set(mcpTurnTaintKey(seed.orgId, agentId), "{not json")
    const write = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(write.isError).toBe(true)
    expect((write.structuredContent as { code?: string }).code).toBe("E_SCOPE_TAINT_BLOCKED")
  }, 30_000)

  it("a value that parses but is not a scope array fails CLOSED the same way", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId)
    const ctx = await makeCtx(seed)
    ctx.agentId = agentId

    // Silently DROPPING the non-string entries (the old filter) would have
    // turned this into an empty, untainted set.
    await redis.set(mcpTurnTaintKey(seed.orgId, agentId), JSON.stringify([{ scope: "x" }]))
    const write = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect(write.isError).toBe(true)
    expect((write.structuredContent as { code?: string }).code).toBe("E_SCOPE_TAINT_BLOCKED")
  }, 30_000)

  // P6d-FX10. THE SAME-RESOURCE ALLOWANCE HAS TO SURVIVE THE HOP.
  //
  // A46 lets a tainted turn write back to a row it READ. The taint's scopes are
  // persisted per (org, agent) so they cross the stateless transport, but the
  // ORIGIN ROWS the allowance is judged against lived only in the per-request
  // accumulator: read the ticket in one POST, reply in the next, and the write
  // was judged against no origins at all. So every gated per-resource write
  // from an external runtime (a desktop local session is one: its Liaison calls
  // are MCP calls) was REFUSED by taint before it could stage its approval,
  // which is what surface 65 says a local turn must show as pending.
  it("a gated write back to the row an earlier REQUEST read stages an approval", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling: seed.scopes })
    const ROW = "11111111-1111-4111-8111-111111111111"
    const OTHER_ROW = "22222222-2222-4222-8222-222222222222"

    // The tickets `get` / `reply` pair in miniature: a read that files an
    // origin, and a gated write that names the row it targets.
    toolRegistry.set([seed.orgId, "test", "readRow"], {
      appName: "test",
      name: "readRow",
      description: "Reads one row",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      readsFromTable: "app_test.rows",
      targetRowParam: "rowId",
      resultRowPath: "id",
      handler: async (params: { rowId: string }) => ({ id: params.rowId }),
    } as never)
    toolRegistry.set([seed.orgId, "test", "gatedWriteRow"], {
      appName: "test",
      name: "gatedWriteRow",
      description: "Writes one row, gated",
      requiredScopes: ["test:gated:write"],
      gated: true,
      writesToTable: "app_test.rows",
      targetRowParam: "rowId",
      handler: async () => ({ ok: true }),
    } as never)
    // The same write, UNGATED: nobody decides it, so the allowance alone governs it.
    toolRegistry.set([seed.orgId, "test", "writeRow"], {
      appName: "test",
      name: "writeRow",
      description: "Writes one row, ungated",
      requiredScopes: ["test:items:write"],
      writesToTable: "app_test.rows",
      targetRowParam: "rowId",
      handler: async () => ({ ok: true }),
    } as never)

    // One POST reads the row...
    const first = await makeCtx(seed)
    first.agentId = agentId
    const read = await handleToolCall(first, "test__readRow", { rowId: ROW })
    expect(read.isError).toBeFalsy()

    // ...and the NEXT POST, a fresh ctx with a dead accumulator, writes it back.
    const second = await makeCtx(seed)
    second.agentId = agentId
    const write = await handleToolCall(second, "test__gatedWriteRow", { rowId: ROW })
    const payload = write.structuredContent as {
      code?: string
      gated?: boolean
      executed?: boolean
      approvalRequestId?: string
    }
    expect(payload.code).toBeUndefined()
    expect(payload.gated).toBe(true)
    expect(payload.executed).toBe(false)
    expect(payload.approvalRequestId).toBeTruthy()
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.approval_requests WHERE id = ${payload.approvalRequestId!}`
    expect(row?.id).toBe(payload.approvalRequestId!)

    // AND THE ALLOWANCE IS STILL NARROW: another row of the same table was
    // never read, so an UNGATED write to it would be laundering and never runs inline: it
    // parks for a person holding the read's scope (rule 8).
    const third = await makeCtx(seed)
    third.agentId = agentId
    const stranger = await handleToolCall(third, "test__writeRow", { rowId: OTHER_ROW })
    expectParked(stranger)
    // The GATED write to that other row parks instead of being refused: the connection's
    // user holds the scope the read carried, so a person who may see the data decides it
    // (scope-taint.ts, consequence 2).
    const fourth = await makeCtx(seed)
    fourth.agentId = agentId
    const gatedStranger = await handleToolCall(fourth, "test__gatedWriteRow", { rowId: OTHER_ROW })
    const parked = gatedStranger.structuredContent as { code?: string; gated?: boolean }
    expect(parked.code).toBeUndefined()
    expect(parked.gated).toBe(true)
  }, 30_000)

  // Rule 14 (2026-11-12): a connection bound to no agent is judged like an agent-bound one. It
  // used to open no frame at all, so its writes were never judged and its posts were stamped
  // with the caller's whole grant.
  it("a connection bound to no agent is judged like an agent bound one, in its own window", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)

    const read = await handleToolCall(ctx, "test__listItems", {})
    expect(read.isError).toBeFalsy()
    // A later request on the SAME connection (the transport is stateless) carries the read.
    const again: ToolCallCtx = {
      orgId: ctx.orgId,
      actor: ctx.actor,
      connectionId: ctx.connectionId,
      ownerUserId: ctx.ownerUserId,
      connectionThreadId: null,
      discovered: new Set(),
    }
    expectParked(await handleToolCall(again, "test__createItem", mutatingTicketTool.validParams))
    expect(
      await redis.get(mcpTurnTaintKey(seed.orgId, connectionTaintWindowId(ctx))),
    ).not.toBeNull()
    // Another connection of the same person has its own window: nothing it did not read.
    const other = await makeCtx(seed)
    const write = await handleToolCall(other, "test__createItem", mutatingTicketTool.validParams)
    expect(write.isError).toBeFalsy()
    expect((write.structuredContent as { gated?: boolean }).gated).not.toBe(true)
  }, 30_000)
})

// P3b / A30: what a POSTED message triggers is a property of the message, not
// of the surface that posted it. The HTTP route has always dispatched the
// agents a message addresses; `threads_reply` over MCP posted the identical row
// and dispatched nobody, so a person on an external client could write into
// their DM with an agent and never get an answer.
describe("mcp threads_reply: the dispatch a posted message triggers", () => {
  const orgs: string[] = []
  let captured: { threadId?: string; actingAgentId?: string | null } | null = null

  /** A stubbed callee turn: records what it was handed, answers nothing. */
  function stubTurn() {
    captured = null
    AgentServiceTestAccess.setAgentRun(async (params: any) => {
      captured = params
      return {
        userMessageId: params.userMessageId,
        fullStream: (async function* () {
          yield {
            type: "finish-step",
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
        finalize: async () => ({
          messageId: null,
          creditCost: 0,
          finishReason: "stop",
          withheldCapabilities: [],
        }),
        actingAgentId: params.actingAgentId ?? null,
        stepCtx: { stepBundleId: null },
        discoveredTools: new Set<string>(),
        turnAccumulatedScopes: () => [],
      }
    })
  }

  /** The dispatch is fire and forget, so the turn is waited for, not assumed. */
  async function turnStarted(ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (captured) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return captured !== null
  }

  async function seedAgentChat(scopeCeiling: string[] = ["kernel:threads:write"]) {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await registerKernelAgentTools(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling })
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${seed.threadId}, ${agentId}, ${seed.orgId}, 'agent')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${seed.orgId}, '10.00000000', '5.00000000', 'EUR')`
    for (const scope of ["kernel:threads:read", "kernel:threads:write"]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${seed.ownerId}, ${seed.orgId}, ${scope}) ON CONFLICT DO NOTHING`
    }
    return {
      ...seed,
      agentId,
      scopes: [...seed.scopes, "kernel:threads:read", "kernel:threads:write"],
    }
  }

  async function rowsIn(threadId: string) {
    return sql<
      {
        author_type: string
        author_agent_id: string | null
        content: string
        metadata: { agentAuthorLabel?: string; externalClientPost?: boolean } | null
      }[]
    >`
      SELECT author_type, author_agent_id, content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} ORDER BY created_at ASC, id ASC`
  }

  afterEach(async () => {
    AgentServiceTestAccess.setAgentRun()
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  it("a plain user token reply into a 1:1 agent chat is agent authored, never as the person, and runs the seated agent", async () => {
    const seed = await seedAgentChat()
    stubTurn()
    const ctx = await makeCtx(seed)

    const res = await handleToolCall(ctx, "kernel__threads_reply", {
      threadId: seed.threadId,
      content: "can you take a look at the open shipment for order 1042",
    })

    expect(res.isError).toBeFalsy()
    const rows = await rowsIn(seed.threadId)
    const posted = rows.find((r) => r.content.includes("order 1042"))
    expect(posted).toBeDefined()
    // An external client is a model writing for the person: the row is their
    // agent's, attributed "{User}'s agent", and marked as an external request.
    expect(posted?.author_type).toBe("agent")
    expect(posted?.author_agent_id).not.toBeNull()
    expect(posted?.metadata?.agentAuthorLabel).toMatch(/'s agent$/)
    expect(posted?.metadata?.externalClientPost).toBe(true)
    // Still a request to the agent seated there, and read as one: replayed to
    // the agent its author id names, it is never that agent's own speech.
    expect(await turnStarted()).toBe(true)
    expect(captured?.actingAgentId).toBe(seed.agentId)
    const replayed = convertToCoreMessages(
      [
        {
          authorType: posted?.author_type ?? "",
          authorAgentId: posted?.author_agent_id,
          content: posted?.content ?? "",
          metadata: posted?.metadata,
        },
      ],
      undefined,
      { selfAgentId: posted?.author_agent_id },
    )
    expect(replayed[0]?.role).toBe("user")
  }, 30_000)

  it("a plain user token reply wakes the seated agent within the connection's scope, never at its own ceiling", async () => {
    // The agent may reach audit; the connection may not. Woken from this
    // connection, its turn must run at the intersection, as agents_ask does.
    const seed = await seedAgentChat(["kernel:threads:write", "kernel:audit:read"])
    stubTurn()
    const ctx = await makeCtx(seed)
    expect(seed.scopes).not.toContain("kernel:audit:read")

    const res = await handleToolCall(ctx, "kernel__threads_reply", {
      threadId: seed.threadId,
      content: "what changed on the audit trail for order 3071",
    })

    expect(res.isError).toBeFalsy()
    expect(await turnStarted()).toBe(true)
    expect(captured?.actingAgentId).toBe(seed.agentId)
    const delegated = (captured as { coordination?: { delegatedScope?: string[] } } | null)
      ?.coordination?.delegatedScope
    expect(delegated).toEqual(["kernel:threads:write"])
  }, 30_000)

  it("an agent bound token reply stays agent authored and starts no turn", async () => {
    const startedTurns: Promise<unknown>[] = []
    const realInvoke = agentServiceModule.invokeAgentForThread
    const invokeSpy = spyOn(agentServiceModule, "invokeAgentForThread").mockImplementation(((
      ...args: Parameters<typeof realInvoke>
    ) => {
      const turn = realInvoke(...args)
      startedTurns.push(turn)
      return turn
    }) as typeof realInvoke)
    try {
      await replyStartsNoTurn(startedTurns)
    } finally {
      invokeSpy.mockRestore()
    }
  }, 30_000)

  async function replyStartsNoTurn(startedTurns: Promise<unknown>[]) {
    const seed = await seedAgentChat()
    stubTurn()
    const ctx = await makeCtx(seed)
    ctx.agentId = seed.agentId

    const res = await handleToolCall(ctx, "kernel__threads_reply", {
      threadId: seed.threadId,
      content: "the shipment for order 2050 left this morning",
    })

    expect(res.isError).toBeFalsy()
    const rows = await rowsIn(seed.threadId)
    const posted = rows.find((r) => r.content.includes("order 2050"))
    expect(posted?.author_type).toBe("agent")
    // Any turn the reply started would have gone through invokeAgentForThread
    // before handleToolCall returned; run them all out before asserting none ran.
    await new Promise((r) => setImmediate(r))
    await Promise.allSettled(startedTurns)
    expect(startedTurns).toHaveLength(0)
    expect(captured).toBeNull()
  }
})
