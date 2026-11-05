// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as rlsModule from "~/db/rls"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import {
  type AppEvent,
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import {
  EventSubscribersTestAccess,
  registerEventSubscribers,
} from "~/infra/events/event-subscribers"
import * as auditModule from "~/modules/audit/service"
import * as timelineModule from "~/modules/audit/timeline"

describe("event subscriber ephemeral guards", () => {
  const mockBufferAndBroadcast = mock(() => Promise.resolve())
  const mockBroadcast = mock(() => Promise.resolve())

  // Mocks scoped to this describe block to avoid leaking into other test files
  let withRlsSpy: ReturnType<typeof spyOn>
  let writeAuditSpy: ReturnType<typeof spyOn>
  let timelineSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    withRlsSpy = spyOn(rlsModule, "withRlsContext").mockImplementation(async (_ctx, fn) =>
      fn({} as any),
    )
    writeAuditSpy = spyOn(auditModule, "writeAuditLog").mockResolvedValue(undefined)
    timelineSpy = spyOn(timelineModule, "generateTimelineEntries").mockResolvedValue(undefined)

    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({
      bufferAndBroadcast: mockBufferAndBroadcast,
      broadcast: mockBroadcast,
    } as any)
  })

  afterAll(() => {
    resetEventBus()
    withRlsSpy.mockRestore()
    writeAuditSpy.mockRestore()
    timelineSpy.mockRestore()
  })

  beforeEach(() => {
    writeAuditSpy.mockClear()
    timelineSpy.mockClear()
    mockBufferAndBroadcast.mockClear()
    mockBroadcast.mockClear()
  })

  it("skips timeline and audit, uses broadcast for ephemeral events", async () => {
    const event: AppEvent = {
      app: "kernel",
      entity: "typing",
      action: "start",
      entityId: "thread-1",
      orgId: "00000000-0000-0000-0000-000000000001",
      ephemeral: true,
      data: { threadId: "thread-1", userId: "user-1", userName: "User" },
    }
    // Ephemeral events never reach the outbox, but assert the durable
    // audit/timeline consumers also no-op on them as defense in depth.
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })
    await publishEvent(event)
    await flushEventHandlers()

    expect(timelineSpy).not.toHaveBeenCalled()
    expect(writeAuditSpy).not.toHaveBeenCalled()
    expect(mockBroadcast).toHaveBeenCalledTimes(1)
    expect(mockBufferAndBroadcast).not.toHaveBeenCalled()
  })

  it("processes stored events: audit/timeline via durable consumers, WS via live fan-out", async () => {
    const event: AppEvent = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "msg-1",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "user-1",
    }
    // Audit + timeline are at-least-once durable consumers (I-EVT-1) run by
    // the outbox before publish; WS fan-out stays a best-effort live handler.
    // The post-outbox publish carries `_eventId` (stamped by the outbox worker),
    // so the audit/timeline bypass fallback recognizes it as already durably
    // audited and skips it — no double-write.
    const eventId = crypto.randomUUID()
    await runDurableConsumers({ eventId, event })
    await publishEvent({ ...event, _eventId: eventId } as AppEvent)
    await flushEventHandlers()

    expect(timelineSpy).toHaveBeenCalledTimes(1)
    expect(writeAuditSpy).toHaveBeenCalledTimes(1)
    expect(mockBufferAndBroadcast).toHaveBeenCalledTimes(1)
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it("audits outbox-bypass events (no _eventId) via the fallback handler", async () => {
    // MCP tool-call audit events are published directly to the event bus
    // WITHOUT going through the outbox (no `_eventId`), so the durable
    // consumers never run for them. The onEvent bypass fallback must audit +
    // timeline them exactly once so the MCP audit trail is not silently dropped.
    const event: AppEvent = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "msg-bypass",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "user-1",
    }
    // No runDurableConsumers — this event bypasses the outbox entirely.
    await publishEvent(event)
    await flushEventHandlers()

    expect(writeAuditSpy).toHaveBeenCalledTimes(1)
    expect(timelineSpy).toHaveBeenCalledTimes(1)
  })

  it("redacts the raw email from an auth.login event's stored audit changes (erasure-002)", async () => {
    // auth.login events carry `data: { email }`, which previously landed verbatim
    // in kernel.audit_log.changes and survived user erasure indefinitely. The
    // durable audit consumer must persist the event WITHOUT the raw email.
    const event: AppEvent = {
      app: "kernel",
      entity: "auth",
      action: "login",
      entityId: "00000000-0000-0000-0000-0000000000aa",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "00000000-0000-0000-0000-0000000000aa",
      data: { email: "secret@example.com" },
    }
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })

    expect(writeAuditSpy).toHaveBeenCalledTimes(1)
    const persisted = writeAuditSpy.mock.calls[0][1] as { changes?: unknown }
    const changes = (persisted.changes ?? {}) as Record<string, unknown>
    expect(changes).not.toHaveProperty("email")
    expect(JSON.stringify(changes)).not.toContain("secret@example.com")
  })

  it("redacts email but keeps non-PII fields on an auth.login_fail event", async () => {
    // login_fail carries `{ email, reason }` — the email must go, the reason
    // (useful diagnostic, not PII) must stay so the audit record is still useful.
    const event: AppEvent = {
      app: "kernel",
      entity: "auth",
      action: "login_fail",
      entityId: "00000000-0000-0000-0000-0000000000bb",
      orgId: "00000000-0000-0000-0000-000000000001",
      data: { email: "leak@example.com", reason: "invalid_password" },
    }
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })

    expect(writeAuditSpy).toHaveBeenCalledTimes(1)
    const persisted = writeAuditSpy.mock.calls[0][1] as { changes?: unknown }
    const changes = (persisted.changes ?? {}) as Record<string, unknown>
    expect(changes).not.toHaveProperty("email")
    expect(changes.reason).toBe("invalid_password")
    expect(JSON.stringify(changes)).not.toContain("leak@example.com")
  })

  // ── Invariant K, Task 6.2: the audit strip covers mail content ─────────────
  //
  // Second line of defence behind the emit-site strip. The emit is where the fix
  // lives; this is what stops a future event shape (a new field, a new writer,
  // an app-catalog rollback) from reopening the hole in `audit_log.changes`.
  it("strips mail content from a mail conversation event's audit changes", async () => {
    const event: AppEvent = {
      app: "mail",
      entity: "conversation",
      action: "update",
      entityId: "00000000-0000-0000-0000-0000000000c1",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "00000000-0000-0000-0000-0000000000aa",
      data: {
        id: "00000000-0000-0000-0000-0000000000c1",
        accountId: "00000000-0000-0000-0000-0000000000c9",
        subject: "AUDITNONCE subject",
        snippet: "AUDITNONCE snippet",
        text_body: "AUDITNONCE body",
        isRead: true,
      },
    }
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })

    // Non-vacuity: the audit row must have been written at all.
    expect(writeAuditSpy).toHaveBeenCalledTimes(1)
    const persisted = writeAuditSpy.mock.calls[0][1] as { changes?: unknown }
    const changes = (persisted.changes ?? {}) as Record<string, unknown>
    expect(JSON.stringify(changes)).not.toContain("AUDITNONCE")
    // The envelope survives: an audit record with no ids is useless.
    expect(changes.id).toBe("00000000-0000-0000-0000-0000000000c1")
    expect(changes.accountId).toBe("00000000-0000-0000-0000-0000000000c9")
    expect(changes.isRead).toBe(true)
    // Length markers keep the record diagnostic without the content.
    expect(changes.subjectLength).toBe("AUDITNONCE subject".length)
  })

  it("leaves a TICKETS conversation-shaped event untouched", async () => {
    // The strip keys on `event.app`. A global content filter would pass the mail
    // case above and silently gut every other app's audit trail; this is the
    // assertion that tells the two apart.
    const event: AppEvent = {
      app: "tickets",
      entity: "ticket",
      action: "update",
      entityId: "00000000-0000-0000-0000-0000000000c2",
      orgId: "00000000-0000-0000-0000-000000000001",
      data: { id: "00000000-0000-0000-0000-0000000000c2", subject: "Broken pedal" },
    }
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })
    const persisted = writeAuditSpy.mock.calls[0][1] as { changes?: unknown }
    expect((persisted.changes as Record<string, unknown>).subject).toBe("Broken pedal")
  })

  it("updates WS membership map before broadcasting participant:add", async () => {
    // F1: stored-event WS fan-out is now a DURABLE consumer (ws-fanout) run by
    // the outbox before processed_at, so exercise it via runDurableConsumers —
    // the same path processOutboxBatch uses — not the publish global-handler path.
    const mockAddThreadMember = mock(() => {})
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({
      bufferAndBroadcast: mockBufferAndBroadcast,
      broadcast: mockBroadcast,
      addThreadMember: mockAddThreadMember,
      removeThreadMember: mock(() => {}),
    } as any)

    await runDurableConsumers({
      eventId: crypto.randomUUID(),
      event: {
        app: "kernel",
        entity: "participant",
        action: "add",
        entityId: "thread-1",
        orgId: "00000000-0000-0000-0000-000000000001",
        actorId: "actor-1",
        data: { threadId: "thread-1", userId: "new-user", userName: "New User" },
      },
    })

    expect(mockAddThreadMember).toHaveBeenCalledWith("new-user", "thread-1")
    expect(mockBufferAndBroadcast).toHaveBeenCalledTimes(1)
  })

  it("calls removeThreadMember before broadcasting participant:remove", async () => {
    const mockRemoveThreadMember = mock(() => {})
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({
      bufferAndBroadcast: mockBufferAndBroadcast,
      broadcast: mockBroadcast,
      addThreadMember: mock(() => {}),
      removeThreadMember: mockRemoveThreadMember,
    } as any)

    await runDurableConsumers({
      eventId: crypto.randomUUID(),
      event: {
        app: "kernel",
        entity: "participant",
        action: "remove",
        entityId: "thread-1",
        orgId: "00000000-0000-0000-0000-000000000001",
        actorId: "actor-1",
        data: { threadId: "thread-1", userId: "removed-user" },
      },
    })

    expect(mockRemoveThreadMember).toHaveBeenCalledWith("removed-user", "thread-1")
    expect(mockBufferAndBroadcast).toHaveBeenCalledTimes(1)
  })
})

describe("durable WS fan-out (F1)", () => {
  let withRlsSpy: ReturnType<typeof spyOn>
  let writeAuditSpy: ReturnType<typeof spyOn>
  let timelineSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    withRlsSpy = spyOn(rlsModule, "withRlsContext").mockImplementation(async (_ctx, fn) =>
      fn({} as any),
    )
    writeAuditSpy = spyOn(auditModule, "writeAuditLog").mockResolvedValue(undefined)
    timelineSpy = spyOn(timelineModule, "generateTimelineEntries").mockResolvedValue(undefined)
  })

  afterAll(() => {
    resetEventBus()
    DurableConsumersTestAccess.reset()
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(null)
    withRlsSpy.mockRestore()
    writeAuditSpy.mockRestore()
    timelineSpy.mockRestore()
  })

  const storedEvent = (): { eventId: string; event: AppEvent } => ({
    eventId: crypto.randomUUID(),
    event: {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "msg-f1",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "user-1",
    },
  })

  it("buffers a stored event via the durable ws-fanout consumer (runs before processed_at)", async () => {
    const buffer = mock(() => Promise.resolve())
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({ bufferAndBroadcast: buffer, broadcast: mock(() => {}) } as any)

    await runDurableConsumers(storedEvent())
    // The buffer write happened inside runDurableConsumers, which the outbox
    // awaits BEFORE stamping processed_at — so processed_at implies "buffered".
    expect(buffer).toHaveBeenCalledTimes(1)
  })

  it("a hung socket send does NOT throw (event still completes, no outbox retry)", async () => {
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(50)
    // bufferAndBroadcast never resolves (simulating a wedged socket send after
    // the buffer zadd). The durable consumer must resolve on timeout, not throw.
    const hung = mock(() => new Promise<void>(() => {}))
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({ bufferAndBroadcast: hung, broadcast: mock(() => {}) } as any)

    await expect(runDurableConsumers(storedEvent())).resolves.toBeUndefined()
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(null)
  })

  it("a buffer/Redis failure DOES throw (outbox retries the unbuffered event)", async () => {
    const failing = mock(() => Promise.reject(new Error("redis down")))
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({ bufferAndBroadcast: failing, broadcast: mock(() => {}) } as any)

    await expect(runDurableConsumers(storedEvent())).rejects.toThrow("redis down")
  })

  it("skips ephemeral events on the durable path (they never ride the outbox)", async () => {
    const buffer = mock(() => Promise.resolve())
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({ bufferAndBroadcast: buffer, broadcast: mock(() => {}) } as any)

    await runDurableConsumers({
      eventId: crypto.randomUUID(),
      event: {
        app: "kernel",
        entity: "typing",
        action: "start",
        entityId: "thread-1",
        orgId: "00000000-0000-0000-0000-000000000001",
        ephemeral: true,
      },
    })
    expect(buffer).not.toHaveBeenCalled()
  })
})
