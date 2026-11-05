// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX20 item 1 -- the approval ROW names the agent whose turn proposed the gated
// call (`kernel.approval_requests.agent_id`, T04's migration 0063). Spec A11.
//
// T04 added the column and nothing ever wrote it. FX18 put the agent on the
// approval EVENTS, which answers "who proposed this" for the audit row queued
// at that instant, and FX19 carried it onto a re-invocation, but both read a
// column no writer ever filled: the identity died the moment the call was
// deferred. Everything that happens AFTER the human decides (the re-invocation,
// the approved re-entry) runs in another request with the proposing turn's ALS
// frame long gone, so the row is the only place the identity can survive.
//
// All three insert sites are covered here: `createApprovalRequest`, the
// sequenced bundle step, and the synthetic row an auto-approve policy writes.
//
// FAIL CLOSED ON IDENTITY, NOT ON THE ROW: `agent_id` is uuid typed, so an
// unusable value would abort the INSERT and the gated call would simply never
// be staged because the name of its proposer was malformed. It records null
// instead, never a human's id, and the approval still lands.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createSequencedApprovalStep, executeTool } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f20001"
const USER = "00000000-0000-4000-8000-000000f20002"
const THREAD = "00000000-0000-4000-8000-000000f20003"
const AGENT = "00000000-0000-4000-8000-000000f20004"

const APP = "fx20_test"
const WRITE = `${APP}:write`

/**
 * The proposing actor. It may CALL the gated tools and holds no
 * `fx20_test:approve`, so every call below takes the gated branch instead of
 * the self-approval bypass.
 */
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE],
  dimensionGrants: {},
}

/** A turn frame with an empty (untainted) accumulator, so T28's write guard
 *  admits the fixture tools and what is under test stays the identity alone. */
function turnFrame(agentId?: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f200ff"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: [WRITE],
    turnScopeAccumulator,
    ...(agentId ? { agentId } : {}),
  }
}

function appManifest(): Record<string, unknown> {
  return {
    name: APP,
    trusted: true,
    capabilities: [],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

/** The sandbox bridge never touches its own transaction on the executeTool
 *  path, so a db access here would mean the test exercises something else. */
function poison(): RlsClient {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined
        throw new Error(`unexpected sandbox-bridge db access via txDb.${String(prop)}`)
      },
    },
  ) as RlsClient
}

/** What is PERSISTED on the approval row, read outside RLS. */
async function rowAgentOf(
  approvalId: string,
): Promise<{ found: boolean; agentId: string | null; requestedBy: string | null }> {
  const rows = await withSystemDb("fx20-row-read", (db) =>
    db.execute(
      drizzleSql`SELECT agent_id, requested_by FROM kernel.approval_requests
        WHERE org_id = ${ORG} AND id = ${approvalId}`,
    ),
  )
  const row = extractRows<{ agent_id: string | null; requested_by: string }>(rows)[0]
  return {
    found: row !== undefined,
    agentId: row?.agent_id ?? null,
    requestedBy: row?.requested_by ?? null,
  }
}

/** Propose a gated call the way a host side agent tool call does: in frame. */
async function gatedInFrame(
  frame: RunContext | undefined,
  tool: string,
  params: Record<string, unknown>,
  origin: "in-app-agent" | undefined = "in-app-agent",
): Promise<string> {
  const call = () =>
    executeTool({
      toolName: `${APP}:${tool}`,
      orgId: ORG,
      actor,
      params,
      threadId: THREAD,
      ...(origin ? { origin } : {}),
    })
  const r = frame ? await runContextStore.run(frame, call) : await call()
  if (!r.blocked?.approvalRequestId) {
    throw new Error(`expected the call to be gated, got ${JSON.stringify(r)}`)
  }
  return r.blocked.approvalRequestId
}

describe("FX20: the approval row names the agent that proposed the call", () => {
  beforeAll(async () => {
    await acquireTestLock()

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX20 Row Org', 'fx20-row-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx20-row@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx20-row-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "fx20-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx20",
          displayName: "Logistics",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )

    // Gated fixture tools. Each DECLARES the sink it writes so T28's write guard
    // judges a real target rather than the undeclared worst case.
    for (const [name, refOut] of [
      ["stage", null],
      ["step1", "value"],
      ["step2", null],
      ["auto", null],
    ] as const) {
      toolRegistry.set([ORG, APP, name], {
        appName: APP,
        name,
        description: name,
        requiredScopes: [WRITE],
        gated: true,
        writesToTable: SINK_KERNEL_MESSAGES,
        ...(refOut ? { referenceableOutputs: [refOut] } : {}),
        handler: async (p: unknown) => ({ value: "done", echoed: p }),
      } as never)
    }

    // An enabled auto-approve policy for ONE of them: its call is executed
    // inline and recorded as a synthetic, born approved approval row. No window
    // limits, so the decision is the conditions and the scope alone.
    await withSystemDb("fx20-policy", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId: ORG,
        toolName: `${APP}:auto`,
        enabled: true,
        conditions: [],
        limits: {},
        requiresScope: WRITE,
        createdBy: USER,
      }),
    )
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("a gated call proposed inside an agent turn persists the agent on the row", async () => {
    const approvalId = await gatedInFrame(turnFrame(AGENT), "stage", { note: "gate me" })

    // The human requester stays on `requested_by`; the agent is INDEPENDENT of
    // it, never a substitute, so the human's id never lands in the agent slot.
    expect(await rowAgentOf(approvalId)).toEqual({
      found: true,
      agentId: AGENT,
      requestedBy: USER,
    })
  })

  it("a gated call made through a sandboxed app persists it across the hop", async () => {
    // Built where the frame is live (as executeToolHandler builds it) and
    // dispatched where it is gone (as the QuickJS callback does).
    const bridge = runContextStore.run(
      turnFrame(AGENT),
      () =>
        createRpcBridge(
          APP,
          USER,
          ORG,
          poison(),
          appManifest() as never,
          [WRITE],
          "user",
          undefined,
          { actor: actor as never, threadId: THREAD },
        ) as Record<string, (...a: unknown[]) => Promise<string>>,
    )

    const env = await runContextStore.exit(async () => {
      expect(runContextStore.getStore()).toBeUndefined()
      return JSON.parse(
        await bridge.executeTool!(`${APP}:stage`, JSON.stringify({ note: "from the sandbox" })),
      ) as { blocked?: { approvalRequestId?: string } }
    })
    const approvalId = env.blocked?.approvalRequestId
    expect(approvalId).toBeDefined()

    expect(await rowAgentOf(approvalId!)).toMatchObject({ found: true, agentId: AGENT })
  })

  it("a sequenced bundle step persists it too", async () => {
    const head = await gatedInFrame(turnFrame(AGENT), "step1", { kind: "x" })
    const stepId = await runContextStore.run(turnFrame(AGENT), () =>
      createSequencedApprovalStep({
        orgId: ORG,
        threadId: THREAD,
        toolName: `${APP}:step2`,
        toolParams: { v: 1 },
        requestedBy: USER,
        summary: { kind: "step2", title: "step", lines: [] },
        appName: APP,
        toolShortName: "step2",
        bundle: { bundleId: head, dependsOnId: head, position: -1 },
      } as never),
    )

    expect(await rowAgentOf(stepId)).toMatchObject({ found: true, agentId: AGENT })
  })

  it("the synthetic row an auto-approve policy writes persists it", async () => {
    // Born approved and never re-entered, but it is the same audit envelope a
    // human decided approval has, so it answers the same question about the
    // turn that made the call.
    const r = await runContextStore.run(turnFrame(AGENT), () =>
      executeTool({
        toolName: `${APP}:auto`,
        orgId: ORG,
        actor,
        params: { note: "policy fires" },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    )
    expect(r.blocked).toBeUndefined()

    const rows = await withSystemDb("fx20-synthetic-read", (db) =>
      db.execute(
        drizzleSql`SELECT id, agent_id, status, reason FROM kernel.approval_requests
          WHERE org_id = ${ORG} AND tool_name = ${`${APP}:auto`}`,
      ),
    )
    const row = extractRows<{ agent_id: string | null; status: string; reason: string }>(rows)[0]
    expect(row).toBeDefined()
    expect(row.status).toBe("approved")
    expect(row.reason).toBe("auto_approved_by_policy")
    expect(row.agent_id).toBe(AGENT)
  })

  it("a human initiated gated call records no agent", async () => {
    // No frame at all: a person clicked and no agent turn ran. The true answer
    // is no agent, never the human's own id in the agent column.
    const approvalId = await gatedInFrame(undefined, "stage", { note: "human" }, undefined)

    expect(await rowAgentOf(approvalId)).toEqual({
      found: true,
      agentId: null,
      requestedBy: USER,
    })
  })

  it("an agent turn with no resolvable agent records a positive null", async () => {
    const approvalId = await gatedInFrame(turnFrame(undefined), "stage", { note: "agentless" })

    const row = await rowAgentOf(approvalId)
    expect(row).toEqual({ found: true, agentId: null, requestedBy: USER })
    expect(row.agentId).not.toBe(USER)
  })

  it("an unusable agent id records no agent and the approval row still lands", async () => {
    // Fail closed on IDENTITY, not on the row: `agent_id` is uuid typed, so an
    // unusable value would abort the INSERT and the gated call would never be
    // staged at all. The record of the call matters more than the name.
    const frame = turnFrame(undefined)
    frame.agentId = "not-a-uuid"
    const approvalId = await gatedInFrame(frame, "stage", { note: "bad identity" })

    expect(await rowAgentOf(approvalId)).toEqual({
      found: true,
      agentId: null,
      requestedBy: USER,
    })
  })
})
