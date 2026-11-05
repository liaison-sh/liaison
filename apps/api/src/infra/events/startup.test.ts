// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  _getGlobalHandlerCount,
  initEventBus,
  onEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { startOutboxWorker, stopOutboxWorker } from "~/infra/events/outbox-worker"
import { closeAllQueues } from "~/infra/jobs/jobs"
import { WebSocketManager } from "~/infra/websocket"
import { redis, redisBullMQ, redisSub } from "~/lib/redis"

describe("startup seams", () => {
  afterAll(() => {
    // Restore event bus to clean state for other tests — but do NOT
    // disconnect Redis or close sql (shared by the test runner).
    resetEventBus()
  })

  // ── Event bus initialization ──────────────────────────────────────

  it("event bus initializes without error", () => {
    resetEventBus()
    expect(() => initEventBus()).not.toThrow()
  })

  it("initEventBus is idempotent", () => {
    resetEventBus()
    expect(() => {
      initEventBus()
      initEventBus()
    }).not.toThrow()
  })

  it("resetEventBus clears handlers so re-init is clean", () => {
    resetEventBus()
    initEventBus()

    // Register a global handler
    let _callCount = 0
    onEvent(
      async () => {
        _callCount++
      },
      { delivery: "per-replica" },
    )
    expect(_getGlobalHandlerCount()).toBe(1)

    // After reset, handler count drops to zero
    resetEventBus()
    expect(_getGlobalHandlerCount()).toBe(0)

    // Re-init and register again — old handler should NOT be present
    initEventBus()
    onEvent(
      async () => {
        _callCount += 10
      },
      { delivery: "per-replica" },
    )
    expect(_getGlobalHandlerCount()).toBe(1)
  })

  // ── Job queue management ──────────────────────────────────────────

  it("closeAllQueues handles empty state", async () => {
    await expect(closeAllQueues()).resolves.toBeUndefined()
  })

  // ── WebSocketManager ──────────────────────────────────────────────

  it("WebSocketManager can be instantiated with real Redis", () => {
    expect(() => new WebSocketManager(redis)).not.toThrow()
  })

  it("WebSocketManager starts with zero connections", () => {
    const wsm = new WebSocketManager(redis)
    expect(wsm.getConnectionCount()).toBe(0)
  })

  // ── Event subscribers wiring ──────────────────────────────────────

  it("registerEventSubscribers works with a fresh WebSocketManager", () => {
    resetEventBus()
    initEventBus()
    const wsm = new WebSocketManager(redis)
    expect(() => registerEventSubscribers(wsm)).not.toThrow()
  })

  it("registerEventSubscribers works without a WebSocketManager", () => {
    resetEventBus()
    initEventBus()
    expect(() => registerEventSubscribers()).not.toThrow()
  })

  // ── Shutdown dependencies ─────────────────────────────────────────

  it("all shutdown dependencies are available and callable", () => {
    expect(closeAllQueues).toBeTypeOf("function")
    expect(stopOutboxWorker).toBeTypeOf("function")
    expect(startOutboxWorker).toBeTypeOf("function")
    expect(sql.end).toBeTypeOf("function")
    expect(redis.disconnect).toBeTypeOf("function")
    expect(redisSub.disconnect).toBeTypeOf("function")
    expect(redisBullMQ.disconnect).toBeTypeOf("function")
  })
})
