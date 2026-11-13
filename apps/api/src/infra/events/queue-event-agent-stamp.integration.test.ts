// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A11 -- WHICH AGENT acted is stamped ONCE, in `queueEvent`, for every durable
// event a turn emits.
//
// The audit consumer has no entity allowlist: every non-ephemeral event with a
// valid org becomes an `audit_log` row. So "what did this agent do" is only
// answerable if the identity rides EVERY event, not the handful of emit sites
// that remember to pass it. Stamping per site does not scale (of the ~160
// non-test `queueEvent` calls, six passed an agent), and each one that forgets
// files an agent's write under no agent at all.
//
// The stamp mirrors `stampFiringRoutineId`: read in `queueEvent` itself, from
// the live run frame, with an explicitly passed value always winning (the
// emitter that passes one either knows the agent or knows there was none) and
// null outside any turn, which is the true answer there -- a human request, a
// job, a cron or a webhook has no acting agent. Never guessed, never a human's
// id.
//
// ACROSS THE SANDBOX HOP the frame is gone: a sandboxed app's bridge callback
// runs in a worker-pool hop where `currentRunContext()` is undefined. The
// bridge already captures the acting agent at construction (host side, in
// frame) for its own writes; it now also hands that capture to the db handle it
// gives the app's services, so a knowledge document created during an agent's
// turn records the agent without `apps/knowledge/service.ts` knowing anything
// about agents.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { setEventAgentDefault } from "~/db/queue-event"
import { withRlsContext } from "~/db/rls"
import { auditLog } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { declaredEmits, initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Synthetic kernel events these tests queue. `assertKernelEventDeclared` runs
// against the kernel emit set once `initEventBus` has populated it.
const KERNEL_TEST_EMITS = ["test:agent-stamp"]

const KNOWLEDGE_SCOPES = ["knowledge:documents:read", "knowledge:documents:create"]

let orgId: string
let userId: string
let agentId: string
let otherAgentId: string

/** A turn frame, with the accumulator every real turn carries. */
function turnFrame(opts: { agentId?: string; accumulated?: string[] } = {}): RunContext {
  const runId = crypto.randomUUID()
  const accumulator = createTurnScopeAccumulator()
  accumulator.recordInjected(opts.accumulated ?? ["kernel:threads:read"])
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: accumulator,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  }
}

/** Drain the transactional outbox so the durable audit consumer has run. */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The audit row for one entity, read outside RLS. */
async function auditRowFor(
  entityId: string,
): Promise<{ action: string; actorId: string | null; agentId: string | null } | undefined> {
  const rows = await withSystemDb("fx21-audit-read", (db) =>
    db
      .select({
        action: auditLog.action,
        actorId: auditLog.actorId,
        agentId: auditLog.agentId,
      })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, entityId))),
  )
  return rows[0]
}

async function seedAgent(handle: string): Promise<string> {
  return await withPrivilegedDb(orgId, "fx21-seed-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "personal",
        handle: `@${handle}-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: userId,
        scopeCeiling: ["kernel:threads:read"],
      })
      .returning({ id: agents.id })
    return a!.id
  })
}

/** Queue one synthetic durable event and return its entity id. */
async function queueTestEvent(
  entityId: string,
  extra: { agentId?: string | null } = {},
): Promise<void> {
  await withPrivilegedDb(orgId, "fx21-queue", (tx) =>
    tx.queueEvent({
      app: "kernel",
      entity: "test",
      action: "agent-stamp",
      entityId,
      orgId,
      actorId: userId,
      actorType: "user",
      data: { id: entityId },
      ...extra,
    }),
  )
}

function personalDoc(title: string) {
  return {
    documentScope: "personal",
    title,
    body: "written during an agent turn",
    collectionIds: [],
    tagNames: [],
    team: [],
    sensitivity: "internal",
    verifyNow: false,
  }
}

beforeAll(async () => {
  await acquireTestLock()

  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  // Real audit + timeline consumers; WS fan-out stubbed (no manager here).
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.add(k)

  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  agentId = await seedAgent("fx21")
  otherAgentId = await seedAgent("fx21-other")

  // The knowledge app declares its emits when it is installed; this suite calls
  // the bridge method directly, so admit the one event it queues.
  for (const key of ["knowledge", `${orgId}:knowledge`, "*:knowledge"]) {
    declaredEmits.get(key)?.add("document:create")
  }
})

afterAll(async () => {
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.delete(k)
  await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${orgId}`
  resetEventBus()
  await releaseTestLock()
})

describe("queueEvent stamps the acting agent centrally", () => {
  it("a durable event queued inside a turn names the agent with no emit site passing it", async () => {
    const entityId = crypto.randomUUID()
    await runContextStore.run(turnFrame({ agentId }), () => queueTestEvent(entityId))
    await drainOutbox()

    const row = await auditRowFor(entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(agentId)
    // The human is still the actor; the agent id is independent of it.
    expect(row?.actorId).toBe(userId)
  })

  it("outside any turn the event names no agent", async () => {
    const entityId = crypto.randomUUID()
    expect(runContextStore.getStore()).toBeUndefined()
    await queueTestEvent(entityId)
    await drainOutbox()

    const row = await auditRowFor(entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("a turn with no resolvable agent still writes the row, naming no agent", async () => {
    const entityId = crypto.randomUUID()
    await runContextStore.run(turnFrame(), () => queueTestEvent(entityId))
    await drainOutbox()

    const row = await auditRowFor(entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("an explicitly passed agent wins over the live frame", async () => {
    const entityId = crypto.randomUUID()
    await runContextStore.run(turnFrame({ agentId }), () =>
      queueTestEvent(entityId, { agentId: otherAgentId }),
    )
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBe(otherAgentId)
  })

  it("an explicit null wins too: an emitter that knows there was no agent is believed", async () => {
    const entityId = crypto.randomUUID()
    await runContextStore.run(turnFrame({ agentId }), () =>
      queueTestEvent(entityId, { agentId: null }),
    )
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBeNull()
  })

  it("the stamp reaches a nested savepoint transaction", async () => {
    const entityId = crypto.randomUUID()
    await runContextStore.run(turnFrame({ agentId }), () =>
      withPrivilegedDb(orgId, "fx21-nested", (tx) =>
        tx.transaction((tx2: typeof tx) =>
          tx2.queueEvent({
            app: "kernel",
            entity: "test",
            action: "agent-stamp",
            entityId,
            orgId,
            actorId: userId,
            actorType: "user",
            data: { id: entityId },
          }),
        ),
      ),
    )
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBe(agentId)
  })
})

describe("the sandbox hop carries the agent to the app's own writes", () => {
  it("an agent turn's knowledge_create audits the document with the acting agent", async () => {
    // Exactly the production shape: the bridge is built INSIDE the turn's frame
    // (execute-tool does this), and the app's callback runs with the frame lost.
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId,
        scopes: KNOWLEDGE_SCOPES,
        dimensionGrants: {},
      },
      async (tx) => {
        const bridge = runContextStore.run(
          turnFrame({ agentId, accumulated: ["mail:read"] }),
          () =>
            createRpcBridge(
              "knowledge",
              userId,
              orgId,
              tx as never,
              knowledgeManifest as never,
              KNOWLEDGE_SCOPES,
              "user",
              undefined,
              {
                // A connector-origin create skips the collection-placement
                // guard; the attribution under test is independent of placement.
                callerApp: "calls",
                actor: {
                  actorType: "user",
                  userId,
                  orgId,
                  scopes: KNOWLEDGE_SCOPES,
                  dimensionGrants: {},
                } as never,
              },
            ) as Record<string, (p: string) => Promise<string>>,
        )
        // The hop really did lose the frame.
        expect(runContextStore.getStore()).toBeUndefined()
        return JSON.parse(
          await bridge.knowledge_create!(JSON.stringify(personalDoc("Written by the agent"))),
        ) as { id: string }
      },
    )
    await drainOutbox()

    const row = await auditRowFor(created.id)
    expect(row).toBeDefined()
    expect(row?.action).toBe("document.create")
    expect(row?.agentId).toBe(agentId)
  })

  it("the same create with no agent behind it records no agent", async () => {
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId,
        scopes: KNOWLEDGE_SCOPES,
        dimensionGrants: {},
      },
      async (tx) => {
        const bridge = runContextStore.run(
          turnFrame({ accumulated: ["mail:read"] }),
          () =>
            createRpcBridge(
              "knowledge",
              userId,
              orgId,
              tx as never,
              knowledgeManifest as never,
              KNOWLEDGE_SCOPES,
              "user",
              undefined,
              {
                callerApp: "calls",
                actor: {
                  actorType: "user",
                  userId,
                  orgId,
                  scopes: KNOWLEDGE_SCOPES,
                  dimensionGrants: {},
                } as never,
              },
            ) as Record<string, (p: string) => Promise<string>>,
        )
        return JSON.parse(
          await bridge.knowledge_create!(JSON.stringify(personalDoc("Written by a human"))),
        ) as { id: string }
      },
    )
    await drainOutbox()

    const row = await auditRowFor(created.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })
})

// The per-handle default is the third and weakest rung of the precedence
// ladder, and it was a latent trap: `setEventAgentDefault` early-returned on a
// falsy id, so an explicit null never CLEARED an agent already declared on that
// handle, and the slot was keyed to the HANDLE alone, so it outlived the turn
// that set it. Harmless only while every handle is per-transaction; the first
// caller to reuse one transaction across two turns mis-attributes silently.
//
// Now: a null CLEARS the slot (the sole setter, `createRpcBridge`, calls it
// unconditionally at construction, so a second bridge over a reused handle
// resets the identity instead of inheriting it), and the slot records the
// rootRunId of the turn that set it, so a write made inside a DIFFERENT live
// turn ignores it and falls closed to no agent. A write with no live frame at
// all is the hop the default exists for, and still reads it.
describe("the per-handle agent default is clearable and turn-scoped", () => {
  const probeEvent = (entityId: string) => ({
    app: "kernel",
    entity: "test",
    action: "agent-stamp",
    entityId,
    orgId,
    actorId: userId,
    actorType: "user" as const,
    data: { id: entityId },
  })

  it("covers an out-of-frame write on the handle it was declared for", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "fx23-probe-set", async (tx) => {
      setEventAgentDefault(tx, agentId)
      // The hop the default exists for: no live frame at the write.
      expect(runContextStore.getStore()).toBeUndefined()
      await tx.queueEvent(probeEvent(entityId))
    })
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBe(agentId)
  })

  it("an explicit null CLEARS a default already declared on the same handle", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "fx23-probe-clear", async (tx) => {
      setEventAgentDefault(tx, agentId)
      setEventAgentDefault(tx, null)
      await tx.queueEvent(probeEvent(entityId))
    })
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBeNull()
  })

  it("a later declaration on the same handle replaces the earlier one", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "fx23-probe-replace", async (tx) => {
      setEventAgentDefault(tx, agentId)
      setEventAgentDefault(tx, otherAgentId)
      await tx.queueEvent(probeEvent(entityId))
    })
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBe(otherAgentId)
  })

  it("the default does not cross into a different turn on the same handle", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "fx23-probe-cross-turn", async (tx) => {
      // Turn one declares the agent, exactly as the bridge does, in frame.
      await runContextStore.run(turnFrame({ agentId }), async () => {
        setEventAgentDefault(tx, agentId)
      })
      // Turn two reuses the same handle and has no agent of its own. It must
      // not inherit turn one's.
      await runContextStore.run(turnFrame(), () => tx.queueEvent(probeEvent(entityId)))
    })
    await drainOutbox()

    expect((await auditRowFor(entityId))?.agentId).toBeNull()
  })
})

// Which request an agent's write answers rides the event too: a guided tour
// beat completes only on the work its own request caused (the tour consumer's
// `causedBy`), never on what another turn of the same agent did meanwhile.
describe("queueEvent stamps the message the emitting turn answers", () => {
  async function queuedMetadata(entityId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await sql`SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entityId' = ${entityId}`
    return (row?.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata
  }

  it("in a turn: the turn's message; outside any turn: nothing", async () => {
    const inTurn = crypto.randomUUID()
    const turnMessageId = crypto.randomUUID()
    await runContextStore.run({ ...turnFrame({ agentId }), turnMessageId }, () =>
      queueTestEvent(inTurn),
    )
    expect((await queuedMetadata(inTurn))?.turnMessageId).toBe(turnMessageId)

    const outside = crypto.randomUUID()
    await queueTestEvent(outside)
    expect((await queuedMetadata(outside))?.turnMessageId).toBeUndefined()
  })

  // A call a person approved runs after its turn ended: its frame carries the
  // ask the proposing turn answered, and no message of its own.
  it("in an approved call's re-entry: the ask the proposing turn answered", async () => {
    const approved = crypto.randomUUID()
    const askId = crypto.randomUUID()
    await runContextStore.run({ ...turnFrame({ agentId }), askId }, () => queueTestEvent(approved))
    expect((await queuedMetadata(approved))?.turnMessageId).toBe(askId)

    // A turn with a message of its own names that message, whatever ask it continues.
    const own = crypto.randomUUID()
    const turnMessageId = crypto.randomUUID()
    await runContextStore.run({ ...turnFrame({ agentId }), turnMessageId, askId }, () =>
      queueTestEvent(own),
    )
    expect((await queuedMetadata(own))?.turnMessageId).toBe(turnMessageId)
  })

  it("across the hop that loses the frame, from the handle the turn declared", async () => {
    const entityId = crypto.randomUUID()
    const turnMessageId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "turn-message-hop", async (tx) => {
      await runContextStore.run({ ...turnFrame({ agentId }), turnMessageId }, async () => {
        setEventAgentDefault(tx, agentId)
      })
      expect(runContextStore.getStore()).toBeUndefined()
      await tx.queueEvent({
        app: "kernel",
        entity: "test",
        action: "agent-stamp",
        entityId,
        orgId,
        actorId: userId,
        actorType: "user",
        data: { id: entityId },
      })
    })
    expect((await queuedMetadata(entityId))?.turnMessageId).toBe(turnMessageId)
  })

  it("declared OUTSIDE the frame (a per-call bridge rebuild), from the captured turn", async () => {
    const entityId = crypto.randomUUID()
    const turnMessageId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "turn-message-rebuild", async (tx) => {
      expect(runContextStore.getStore()).toBeUndefined()
      setEventAgentDefault(tx, agentId, {
        turnMessageId,
        run: { rootRunId: crypto.randomUUID() },
      })
      await tx.queueEvent({
        app: "kernel",
        entity: "test",
        action: "agent-stamp",
        entityId,
        orgId,
        actorId: userId,
        actorType: "user",
        data: { id: entityId },
      })
    })
    expect((await queuedMetadata(entityId))?.turnMessageId).toBe(turnMessageId)
  })
})
