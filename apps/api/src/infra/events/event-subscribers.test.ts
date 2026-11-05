// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import {
  DurableConsumersTestAccess,
  registerDurableEventConsumer,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  EventSubscribersTestAccess,
  registerEventSubscribers,
} from "~/infra/events/event-subscribers"
import type { WebSocketManager } from "~/infra/websocket"
import { eventsLogger } from "~/lib/logger"

// The durable `ws-fanout` consumer caps a slow socket send with a timeout and
// treats a timeout as success (the replay buffer already wrote first). The
// LOSING `bufferAndBroadcast` promise must stay OBSERVED so a rejection that
// arrives AFTER the timeout fires logs (scrubbed) instead of surfacing as an
// unhandledRejection (which the process-level fatal handler would treat as a
// crash). This suite exercises exactly that late-settle window.
describe("ws-fanout durable consumer — late-settle after timeout (MAJOR unhandled-rejection fix)", () => {
  let unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    DurableConsumersTestAccess.reset()
    unhandled = []
    process.on("unhandledRejection", onUnhandled)
    // Tiny timeout so the race resolves via the timeout branch immediately,
    // then the broadcast promise settles well after.
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(5)
  })

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled)
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(null)
    DurableConsumersTestAccess.reset()
  })

  function baseEvent(): AppEvent {
    return {
      app: "kernel",
      entity: "thread",
      action: "update",
      entityId: "thread-1",
      orgId: "00000000-0000-0000-0000-000000000001",
      actorId: "system",
      actorType: "system",
      data: { id: "thread-1", changes: { title: "x" } },
      _wsEventId: 1,
    } as AppEvent
  }

  // Register only the ws-fanout consumer: registerEventSubscribers also wires
  // the timeline/audit consumers (which hit the DB); overwrite them with no-ops
  // by name AFTER registration so runDurableConsumers exercises ws-fanout alone.
  function registerWsFanoutOnly(wsManager: WebSocketManager): void {
    registerEventSubscribers(wsManager)
    registerDurableEventConsumer("timeline", async () => {})
    registerDurableEventConsumer("audit", async () => {})
  }

  it("does not raise unhandledRejection when bufferAndBroadcast REJECTS after the timeout, and logs the failure", async () => {
    const errorSpy = spyOn(eventsLogger, "error")
    errorSpy.mockClear()

    // bufferAndBroadcast rejects LONG after the 5ms fan-out timeout.
    const wsManager = {
      bufferAndBroadcast: mock(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late socket delivery failure")), 40)
          }),
      ),
    } as unknown as WebSocketManager

    registerWsFanoutOnly(wsManager)

    // Consumer returns as soon as the timeout wins (does NOT throw on timeout).
    await runDurableConsumers({ eventId: "evt-1", event: baseEvent() })

    // Give the losing broadcast promise time to reject.
    await new Promise((r) => setTimeout(r, 80))

    expect(unhandled).toHaveLength(0)
    // The late rejection was observed and logged (post-timeout best-effort path).
    const loggedLate = errorSpy.mock.calls.some((call) => {
      const msg = call[1]
      return typeof msg === "string" && msg.includes("rejected after timeout")
    })
    expect(loggedLate).toBe(true)

    errorSpy.mockRestore()
  })

  it("does not raise unhandledRejection when bufferAndBroadcast RESOLVES after the timeout", async () => {
    const wsManager = {
      bufferAndBroadcast: mock(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 40)
          }),
      ),
    } as unknown as WebSocketManager

    registerWsFanoutOnly(wsManager)

    await runDurableConsumers({ eventId: "evt-2", event: baseEvent() })
    await new Promise((r) => setTimeout(r, 80))

    expect(unhandled).toHaveLength(0)
  })

  it("a FAST reject (before the timeout) still propagates so the outbox retries", async () => {
    // With a generous timeout, a broadcast that rejects quickly must throw out of
    // the consumer (outbox retry), not be swallowed by the late-settle catch.
    EventSubscribersTestAccess.setWsFanoutTimeoutMs(5000)
    const wsManager = {
      bufferAndBroadcast: mock(() => Promise.reject(new Error("buffer write failed"))),
    } as unknown as WebSocketManager

    registerWsFanoutOnly(wsManager)

    await expect(runDurableConsumers({ eventId: "evt-3", event: baseEvent() })).rejects.toThrow(
      "buffer write failed",
    )

    await new Promise((r) => setTimeout(r, 20))
    expect(unhandled).toHaveLength(0)
  })
})
