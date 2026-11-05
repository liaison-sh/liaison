// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX18 -- a gated call and a sandboxed app write name the ACTING AGENT in the
// audit trail (`kernel.audit_log.agent_id`). Spec A11.
//
// T32 put the acting agent on the durable event envelope for the agent's own
// reply. It left two families of agent action unattributed, and pass 6 measured
// them: every `approval_request` create/update queued by the tool executor, and
// every sandboxed app write queued through the rpc bridge's `queueAppEvent`. So
// a gated call, its bundle promotion and any write a sandboxed app makes all
// landed audit rows with no agent, and "what did this agent do" missed them.
//
// The identity RIDES THE EVENT, exactly as T32's does: an in-frame caller reads
// the live frame through `captureActingAgentId()`, and a caller that has crossed
// the sandbox hop forwards what it captured while the frame was still live (the
// FX12 / FX13 / T32 captured-frame pattern, reused rather than captured again).
//
// FAIL CLOSED ON IDENTITY, NOT ON THE WRITE: an unresolvable agent records null,
// never a human's id, and the audit row still lands.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createSequencedApprovalStep, executeTool } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000067001"
const USER = "00000000-0000-4000-8000-000000067002"
const THREAD = "00000000-0000-4000-8000-000000067003"
const AGENT = "00000000-0000-4000-8000-000000067004"

const APP = "fx18_test"
const WRITE = `${APP}:write`

/**
 * The proposing actor: it may CALL the gated tool and holds no `fx18_test:approve`,
 * so every call below takes the gated branch instead of the self-approval bypass.
 */
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE],
  dimensionGrants: {},
}

/**
 * A turn frame. The accumulator is always present and seeded empty: an
 * UNTAINTED turn, so T28's write guard admits every fixture tool and what is
 * under test stays the audit identity alone.
 */
function turnFrame(agentId?: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-0000000670ff"
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

function mailManifest(): Record<string, unknown> {
  return {
    name: "mail",
    trusted: true,
    capabilities: [],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
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

/**
 * The sandbox bridge never touches its own transaction on the `ctx.executeTool`
 * path: `executeToolCore` opens its own. A db access here would mean the test
 * exercises something else, so it throws (the FX13 convention).
 */
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

/** Drain the transactional outbox so the durable audit consumer has run. */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The audit row for one entity and action, read outside RLS. */
async function auditAgentOf(
  entityId: string,
  action: string,
): Promise<{ found: boolean; agentId: string | null; actorId: string | null }> {
  const rows = await withSystemDb("fx18-audit-read", (db) =>
    db.execute(
      drizzleSql`SELECT agent_id, actor_id FROM kernel.audit_log
        WHERE org_id = ${ORG} AND entity_id = ${entityId} AND action = ${action}
        ORDER BY "timestamp" DESC LIMIT 1`,
    ),
  )
  const row = extractRows<{ agent_id: string | null; actor_id: string | null }>(rows)[0]
  return {
    found: row !== undefined,
    agentId: row?.agent_id ?? null,
    actorId: row?.actor_id ?? null,
  }
}

/** Propose a gated call the way a host-side agent tool call does: in frame. */
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

describe("FX18: gated calls and sandboxed app writes name the acting agent", () => {
  beforeAll(async () => {
    await acquireTestLock()

    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    // The real audit and timeline consumers; WS fan-out stubbed (no manager).
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX18 Attribution Org', 'fx18-attribution-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx18@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx18-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "fx18-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx18",
          displayName: "Logistics",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )

    // Gated fixture tools. Each DECLARES the sink it writes, so T28's write
    // guard judges a real target rather than the undeclared worst case.
    for (const [name, refOut] of [
      ["stage", null],
      ["step1", "value"],
      ["step2", null],
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
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    // `app_mail` is outside the test lock's truncation set, so this file cleans
    // up after itself or the next run inherits its rows.
    await withPrivilegedDb(ORG, "fx18-clean-mail", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM app_mail.conversations WHERE org_id = ${ORG}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${ORG}::uuid`)
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    resetEventBus()
    await releaseTestLock()
  })

  it("a gated call proposed inside an agent turn names the acting agent", async () => {
    const approvalId = await gatedInFrame(turnFrame(AGENT), "stage", { note: "gate me" })
    await drainOutbox()

    // The human is still the actor; the agent id is INDEPENDENT of it.
    expect(await auditAgentOf(approvalId, "approval_request.create")).toEqual({
      found: true,
      agentId: AGENT,
      actorId: USER,
    })
  })

  it("a gated call made through a sandboxed app names the agent across the hop", async () => {
    // The bridge is built where the frame is live (as executeToolHandler builds
    // it) and dispatched where it is gone (as the QuickJS callback does).
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
    await drainOutbox()

    expect(await auditAgentOf(approvalId!, "approval_request.create")).toMatchObject({
      found: true,
      agentId: AGENT,
    })
  })

  it("a bundle head promoted during an agent turn names the agent on its update row", async () => {
    // The second site: an @ref token promotes the standalone head, which queues
    // an approval_request:update carrying the now bundled summary.
    const head = await gatedInFrame(turnFrame(AGENT), "step1", { kind: "x" })
    await gatedInFrame(turnFrame(AGENT), "step2", { note: `@ref:${head}:value` })
    await drainOutbox()

    expect(await auditAgentOf(head, "approval_request.update")).toMatchObject({
      found: true,
      agentId: AGENT,
    })
  })

  it("a sequenced step names the agent on both its create and its restage update", async () => {
    const head = await gatedInFrame(turnFrame(AGENT), "step1", { kind: "x" })
    const bundle = { bundleId: head, dependsOnId: head, position: -1 }
    const stepArgs = {
      orgId: ORG,
      threadId: THREAD,
      toolName: `${APP}:step2`,
      requestedBy: USER,
      summary: { kind: "step2", title: "step", lines: [] },
      appName: APP,
      toolShortName: "step2",
      bundle,
    }
    const stepId = await runContextStore.run(turnFrame(AGENT), () =>
      createSequencedApprovalStep({ ...stepArgs, toolParams: { v: 1 } } as never),
    )
    // The same step staged again restages IN PLACE, queuing the update event.
    const restagedId = await runContextStore.run(turnFrame(AGENT), () =>
      createSequencedApprovalStep({ ...stepArgs, toolParams: { v: 2 } } as never),
    )
    expect(restagedId).toBe(stepId)
    await drainOutbox()

    expect({
      create: (await auditAgentOf(stepId, "approval_request.create")).agentId,
      update: (await auditAgentOf(stepId, "approval_request.update")).agentId,
    }).toEqual({ create: AGENT, update: AGENT })
  })

  it("a sandboxed app write during an agent turn names the acting agent", async () => {
    // The rpc bridge's queueAppEvent path: every durable event a sandboxed app
    // queues for its own data. Captured at bridge construction, in frame.
    const conversationId = crypto.randomUUID()
    const accountId = crypto.randomUUID()
    await withPrivilegedDb(ORG, "fx18-seed-conv", async (tx) => {
      // A real, UNENCRYPTED mailbox account: the conversations table enforces a
      // plaintext invariant that resolves the account first, so a dangling
      // account id is rejected before the row (and its event) ever exists.
      // The address is unique per run: `app_mail` has no FK into kernel, so the
      // test lock's truncation does not reach it and a fixed address would
      // collide with the row a previous run left behind.
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts
          (id, org_id, connected_account_id, provider, email_address, sync_status, encryption_state)
        VALUES (${accountId}::uuid, ${ORG}::uuid, ${crypto.randomUUID()}::uuid,
                'gmail', ${`fx18-${accountId}@test.com`}, 'idle', 'none')`)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.conversations
          (id, org_id, account_id, external_thread_id, subject, status)
        VALUES (${conversationId}::uuid, ${ORG}::uuid, ${accountId}::uuid,
                'fx18-thread-ext', 'FX18', 'open')`)
    })

    await withPrivilegedDb(ORG, "fx18-mail-write", async (tx) => {
      const bridge = runContextStore.run(
        turnFrame(AGENT),
        () =>
          createRpcBridge(
            "mail",
            USER,
            ORG,
            tx as unknown as RlsClient,
            mailManifest() as never,
            [WRITE],
            "user",
          ) as Record<string, (...a: unknown[]) => Promise<string>>,
      )
      return runContextStore.exit(() =>
        bridge.mail_conversion_markConverted!(conversationId, crypto.randomUUID(), "TCK-1"),
      )
    })
    await drainOutbox()

    expect(await auditAgentOf(conversationId, "conversation.converted")).toMatchObject({
      found: true,
      agentId: AGENT,
    })
  })

  it("a human initiated gated call records no agent", async () => {
    // No frame at all: a person clicked, no agent turn ran. The true answer is
    // no agent, never the human's own id in the agent column.
    const approvalId = await gatedInFrame(undefined, "stage", { note: "human" }, undefined)
    await drainOutbox()

    expect(await auditAgentOf(approvalId, "approval_request.create")).toEqual({
      found: true,
      agentId: null,
      actorId: USER,
    })
  })

  it("an unresolvable agent records no agent and the audit row still lands", async () => {
    // Fail closed on IDENTITY, not on the write. `agent_id` is uuid typed, so an
    // unusable value would abort the INSERT and take the record of the action
    // down with it, which is backwards.
    const frame = turnFrame(undefined)
    frame.agentId = "not-a-uuid"
    const approvalId = await gatedInFrame(frame, "stage", { note: "bad identity" })
    await drainOutbox()

    expect(await auditAgentOf(approvalId, "approval_request.create")).toEqual({
      found: true,
      agentId: null,
      actorId: USER,
    })
  })

  it("an agent turn with no resolvable agent still writes the approval row", async () => {
    const approvalId = await gatedInFrame(turnFrame(undefined), "stage", { note: "agentless" })
    await drainOutbox()

    expect(await auditAgentOf(approvalId, "approval_request.create")).toEqual({
      found: true,
      agentId: null,
      actorId: USER,
    })
  })

  it("ctx.requestApproval is handed the same acting agent across the hop", async () => {
    // The OTHER door into the same recording site (createApprovalRequest): a
    // handler that parks itself mid run. Its impl is injected by
    // executeToolHandler and invoked from the same frame-less callback, so it
    // must be HANDED the identity rather than left to read a frame that is gone.
    // Falsifiable: before the bridge forwarded it there was no third argument at
    // all, so this reads `undefined` instead of the agent.
    const seen: Array<string | null | undefined> = []
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
          {
            actor: actor as never,
            threadId: THREAD,
            requestApprovalImpl: (async (
              _input: unknown,
              _proposingTurnScopes: unknown,
              actingAgentId: string | null,
            ) => {
              seen.push(actingAgentId)
              return { approval_id: "00000000-0000-4000-8000-0000000670aa" }
            }) as never,
          },
        ) as Record<string, (...a: unknown[]) => Promise<string>>,
    )

    await runContextStore.exit(async () =>
      bridge.requestApproval!(
        JSON.stringify({
          tool_name: `${APP}:stage`,
          summary: "parked mid run",
          current_payload: { note: "conditional gate" },
        }),
      ),
    )

    expect(seen).toEqual([AGENT])
  })

  it("the durable consumer persists whatever agent the approval event carries", async () => {
    // The consumer half, independent of who emits: an approval_request event
    // that names an agent audits with that agent.
    const entityId = crypto.randomUUID()
    await runDurableConsumers({
      eventId: crypto.randomUUID(),
      event: {
        app: "kernel",
        entity: "approval_request",
        action: "create",
        entityId,
        orgId: ORG,
        actorId: USER,
        actorType: "user",
        agentId: AGENT,
        data: { id: entityId },
      } as never,
    })

    expect(await auditAgentOf(entityId, "approval_request.create")).toMatchObject({
      found: true,
      agentId: AGENT,
    })
  })
})
