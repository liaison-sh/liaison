// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-T32 — an agent turn's DURABLE audit row carries the acting agent's own
// identity (`kernel.audit_log.agent_id`), independent of the human actor, so
// "what did this agent do" is answerable. Spec A11.
//
// The identity RIDES THE EVENT: it is stamped on the `AppEvent` envelope at
// emit time from the run frame (or from a frame captured before a hop that
// loses it) and persisted by BOTH audit consumers. It is deliberately NOT read
// from the ALS store inside `writeAuditLog` or the outbox worker: the worker
// runs outside the turn's async context, so that path would silently miss
// exactly the durable rows this covers.
//
// Fail closed on IDENTITY, not on the WRITE: a row whose agent cannot be
// resolved is still written, recording a null agent, never a wrong one and
// never a human's id for an agent action.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import {
  type AppEvent,
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import {
  captureSpawnParentFrame,
  currentRunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { writeAuditLog } from "~/modules/audit/service"
import { postAppMessage } from "~/modules/messages/post"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** Drain the transactional outbox so the durable audit consumer has run. */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The single audit row for a message entity, read outside RLS. */
async function auditRowFor(
  orgId: string,
  entityId: string,
): Promise<{ actorType: string; actorId: string | null; agentId: string | null } | undefined> {
  const rows = await withSystemDb("t32-audit-read", (db) =>
    db
      .select({
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        agentId: auditLog.agentId,
      })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, entityId))),
  )
  return rows[0]
}

function frameWith(agentId?: string) {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    ...(agentId ? { agentId } : {}),
  }
}

describe("P2b-T32: an agent turn's durable audit row carries the acting agent", () => {
  let orgId: string
  let userId: string
  let threadId: string
  let agentId: string

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

    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    threadId = await minimal.thread(orgId, userId)
    agentId = await withPrivilegedDb(orgId, "t32-seed-agent", async (tx) => {
      // The person's own personal agent (registration made it), capped.
      const [a] = await tx
        .update(agents)
        .set({ scopeCeiling: ["kernel:threads:read"] })
        .where(and(eq(agents.ownerUserId, userId), eq(agents.kind, "personal")))
        .returning({ id: agents.id })
      if (!a) throw new Error("the person has no personal agent")
      return a.id
    })
  })

  afterAll(async () => {
    resetEventBus()
    await releaseTestLock()
  })

  it("an agent reply's audit row carries the acting agent id and actorType agent", async () => {
    // The production shape of the agent reply (agent-service.ts): the run frame
    // is NOT live at the persist site, so the identity is handed over
    // explicitly, exactly as the captured-frame pattern requires.
    const msg = await withPrivilegedDb(orgId, "t32-agent-reply", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId,
        userId,
        threadId,
        content: "the logistics agent answered",
        authorType: "agent",
        agentId,
        requiredScopes: [],
      }),
    )
    expect(msg).not.toBeNull()
    await drainOutbox()

    const row = await auditRowFor(orgId, msg!.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(agentId)
    expect(row?.actorType).toBe("agent")
    // The human is still recorded as the actor; the agent id is INDEPENDENT of
    // it, never a substitute for it.
    expect(row?.actorId).toBe(userId)
  })

  it("an agent reply inside a live run frame takes the agent from the frame", async () => {
    // The host tool path (chat-tools threads_reply) runs INSIDE the turn's ALS
    // frame and hands over nothing, so the emitter reads the frame itself.
    const msg = await runContextStore.run(frameWith(agentId), () =>
      withPrivilegedDb(orgId, "t32-framed-reply", (tx) =>
        sendMessage(tx as unknown as RlsClient, {
          orgId,
          userId,
          threadId,
          content: "posted from inside the turn frame",
          authorType: "agent",
          requiredScopes: [],
        }),
      ),
    )
    expect(msg).not.toBeNull()
    await drainOutbox()

    const row = await auditRowFor(orgId, msg!.id)
    expect(row?.agentId).toBe(agentId)
    expect(row?.actorType).toBe("agent")
  })

  it("a human's own message audits with a null agent and actorType user", async () => {
    const msg = await withPrivilegedDb(orgId, "t32-human-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId,
        userId,
        threadId,
        content: "a human wrote this",
        requiredScopes: [],
      }),
    )
    expect(msg).not.toBeNull()
    await drainOutbox()

    const row = await auditRowFor(orgId, msg!.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
    expect(row?.actorType).toBe("user")
  })

  it("a turn whose agent cannot be resolved still writes the row, with a null agent", async () => {
    // No live agent for the requester: the turn runs at the actor's scopes and
    // the frame carries no agentId. The audit row must still exist.
    const msg = await runContextStore.run(frameWith(undefined), () =>
      withPrivilegedDb(orgId, "t32-agentless-turn", (tx) =>
        sendMessage(tx as unknown as RlsClient, {
          orgId,
          userId,
          threadId,
          content: "an agent turn with no resolvable agent",
          authorType: "agent",
          requiredScopes: [],
        }),
      ),
    )
    expect(msg).not.toBeNull()
    await drainOutbox()

    const row = await auditRowFor(orgId, msg!.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
    // The write is not what fails closed: the row exists and still says an
    // agent acted, it just names no agent.
    expect(row?.actorType).toBe("agent")
  })

  it("a sandbox-originated durable event carries the agent through the captured frame", async () => {
    // The sandbox bridge callback has LOST the turn's ALS frame, so the bridge
    // captures it at construction (host side, in frame) and the write reads the
    // capture. Proven here by capturing inside the frame and posting outside it.
    const captured = runContextStore.run(frameWith(agentId), () =>
      captureSpawnParentFrame({ includeCallingTool: true }),
    )
    expect(captured?.agentId).toBe(agentId)
    // The hop really did lose the frame.
    expect(currentRunContext()).toBeUndefined()

    const result = await withPrivilegedDb(orgId, "t32-sandbox-post", (tx) =>
      postAppMessage(tx as unknown as RlsClient, {
        orgId,
        callingAppId: "invoicing",
        authorUserId: userId,
        thread_id: threadId,
        body: "an app tool posted during the agent's turn",
        requiredScopes: [],
        agentId: captured?.agentId ?? null,
      }),
    )
    await drainOutbox()

    const row = await auditRowFor(orgId, result.message_id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(agentId)
    // An app post is authored as the system, and the agent id is recorded all
    // the same: the identity is independent of the actor type.
    expect(row?.actorType).toBe("system")
  })

  it("the outbox-bypass audit fallback persists the agent id too", async () => {
    // Events published straight to the bus (no outbox row, so no durable
    // consumer) are audited by the bypass fallback, which must record the same
    // identity or the second consumer is a hole in the trail.
    const entityId = crypto.randomUUID()
    const event: AppEvent = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId,
      orgId,
      actorId: userId,
      actorType: "agent",
      agentId,
      data: { id: entityId, content: "bypass" },
    }
    await publishEvent(event)
    await flushEventHandlers()

    const row = await auditRowFor(orgId, entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(agentId)
    expect(row?.actorType).toBe("agent")
  })

  it("an unusable agent id on the envelope still writes the row, recording no agent", async () => {
    // Fail closed on IDENTITY, not on the write: a value that is not a real
    // agent id must never take the audit row down with it, and must never be
    // guessed at.
    const entityId = crypto.randomUUID()
    const event = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId,
      orgId,
      actorId: userId,
      actorType: "agent",
      agentId: "not-a-uuid",
      data: { id: entityId, content: "bad identity" },
    } as unknown as AppEvent

    await runDurableConsumers({ eventId: crypto.randomUUID(), event })

    const row = await auditRowFor(orgId, entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
    expect(row?.actorType).toBe("agent")
  })

  it("writeAuditLog records a null agent rather than dropping the row", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "t32-direct-write", (db) =>
      writeAuditLog(db, {
        orgId,
        actorId: userId,
        actorType: "agent",
        app: "kernel",
        entityType: "message",
        entityId,
        action: "message.create",
        agentId: "00000000-not-a-uuid",
      }),
    )

    const row = await auditRowFor(orgId, entityId)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })
})
