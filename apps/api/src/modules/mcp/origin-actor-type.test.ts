// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import * as connectionsService from "~/modules/apps/connections/service"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  cleanupSeededOrg,
  gatedMutatingTool,
  mutatingTicketTool,
  seedAgentForOrg,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { drainOutbox } from "~/tests/helpers/outbox"

async function auditRowsFor(orgId: string) {
  return withSystemDb("t", (db) =>
    db.select().from(auditLog).where(eq(auditLog.orgId, orgId)).orderBy(desc(auditLog.timestamp)),
  )
}

describe("origin → actorType:mcp wiring", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
    resetEventBus()
    initEventBus()
    // Real audit subscriber writes auditLog rows from emitted events; ws fan-out
    // stubbed (no WebSocketManager in unit context).
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

  it("stamps actorType:'mcp' on tool-mutation audit rows when origin='mcp'", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    await executeTool({
      toolName: mutatingTicketTool.canonical,
      orgId,
      actor,
      params: mutatingTicketTool.validParams,
      origin: "mcp",
    })
    await drainOutbox()

    const rows = await auditRowsFor(orgId)
    const mutationRows = rows.filter((r) => r.action !== "approve" && r.app === "test")
    expect(mutationRows.length).toBeGreaterThan(0)
    for (const r of mutationRows) {
      expect(r.actorType).toBe("mcp")
      expect(r.actorId).toBe(ownerId)
    }
  }, 30_000)

  it("keeps actorType:'user' for the in-app agent (origin='in-app-agent' and default)", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    await executeTool({
      toolName: mutatingTicketTool.canonical,
      orgId,
      actor,
      params: { title: "agent item", team: "alpha" },
      origin: "in-app-agent",
    })
    await executeTool({
      toolName: mutatingTicketTool.canonical,
      orgId,
      actor,
      params: { title: "default item", team: "alpha" },
      // origin omitted — must default to "user" attribution
    })
    await drainOutbox()

    const rows = await withSystemDb("t", (db) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.actorId, ownerId))),
    )
    const mutationRows = rows.filter((r) => r.action !== "approve" && r.app === "test")
    expect(mutationRows.length).toBeGreaterThan(0)
    expect(mutationRows.every((r) => r.actorType === "user")).toBe(true)
  }, 30_000)

  it("GATED decided mutation audits actorType:'mcp'; approval-create stays 'user' (B4 / spec C7)", async () => {
    // gatedCreateItem is gated AND performs a real items:created mutation
    // through the RPC bridge on decided execution. origin:"mcp" must propagate
    // past the gate (recorded on the approval, threaded into the decided
    // execution's bridge actorType) so the EXECUTED mutation audits as "mcp",
    // while the approval-request-create event stays "user" (spec C7 carve-out).
    const { orgId, ownerId, threadId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const blocked = await executeTool({
      toolName: gatedMutatingTool.canonical,
      orgId,
      actor,
      params: gatedMutatingTool.validParams,
      threadId,
      origin: "mcp",
    })
    expect(blocked.blocked?.approvalRequestId).toBeTruthy()

    await decideApproval({
      orgId,
      requestId: blocked.blocked!.approvalRequestId!,
      actor,
      decision: "approve",
    })
    await drainOutbox()

    const rows = await auditRowsFor(orgId)

    // HARD assertion: the decided gated MUTATION row (items:created) must be
    // actorType:"mcp" — not a vacuous guard. This is the criterion-7 proof.
    const mutationRows = rows.filter(
      (r) => r.app === "test" && r.action !== "approve" && !r.action.startsWith("approval_request"),
    )
    expect(mutationRows.length).toBeGreaterThan(0)
    for (const r of mutationRows) {
      expect(r.actorType).toBe("mcp")
      expect(r.actorId).toBe(ownerId)
    }

    // The approval-request-create event stays actorType:"user" per spec C7.
    const approveRows = rows.filter((r) => r.action.startsWith("approval_request"))
    expect(approveRows.length).toBeGreaterThan(0)
    expect(approveRows.every((r) => r.actorType === "user")).toBe(true)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// X10: the sandbox bridge's `actorType` parameter did double duty — it selected
// the RLS actor AND stamped the audit category — so a sandboxed app tool call
// made during an agent turn audited as `user` and A11's "what did this agent
// do" was blind to every sandboxed write. The two are now separate values:
// the RLS actor keeps today's value, the AUDIT category becomes `agent`.
// ---------------------------------------------------------------------------
describe("X10: sandbox audit actorType is split from the bridge's RLS actor", () => {
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

  it("a sandboxed tool call inside an agent frame audits as the agent while still running as the user RLS actor", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: scopes })
    const actor = userContextFor(orgId, ownerId, scopes)

    const rootRunId = crypto.randomUUID()
    const frame = {
      runId: rootRunId,
      parentRunId: null,
      rootRunId,
      nestingDepth: 0,
      background: false,
      agentId,
      agentCeiling: [...scopes],
      effectiveScope: [...scopes],
      turnScopeAccumulator: createTurnScopeAccumulator(),
    }

    // The AUDIT half: a real sandboxed manifest tool, dispatched the way the
    // in-app agent loop dispatches one (inside the turn's run frame).
    await runContextStore.run(frame, () =>
      executeTool({
        toolName: mutatingTicketTool.canonical,
        orgId,
        actor,
        params: { title: "agent frame item", team: "alpha" },
        origin: "in-app-agent",
      }),
    )
    await drainOutbox()

    const mutationRows = (await auditRowsFor(orgId)).filter(
      (r) => r.app === "test" && r.action !== "approve",
    )
    expect(mutationRows.length).toBeGreaterThan(0)
    for (const r of mutationRows) {
      expect(r.actorType).toBe("agent")
      // Named, not merely categorised: an "agent" row with no agent is not an
      // answer to "what did this agent do".
      expect(r.agentId).toBe(agentId)
      // The human who triggered the turn is still on the row.
      expect(r.actorId).toBe(ownerId)
    }

    // The RLS half, at the exact seam the audit category used to share: the
    // value that picks the bridge's DB actor must still read "user", or a
    // sandboxed call made on a human's behalf would silently start running in
    // a system context.
    const tokenSpy = spyOn(connectionsService, "getTokenForConnection").mockResolvedValue(
      "tok" as never,
    )
    try {
      const stubTx = {
        queueEvent: async () => {},
        execute: async () => ({ rows: [] }),
      } as never
      const bridge = runContextStore.run(frame, () =>
        createRpcBridge(
          "test",
          ownerId,
          orgId,
          stubTx,
          { name: "test", schema: {}, events: {}, connections: {}, network: {} } as never,
          scopes,
        ),
      )
      await bridge.connections_getToken("someConnection")
      expect(tokenSpy).toHaveBeenCalled()
      expect(tokenSpy.mock.calls[0]![6]).toEqual({ actorType: "user" })
    } finally {
      tokenSpy.mockRestore()
    }
  }, 30_000)
})
