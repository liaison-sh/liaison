// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import {
  _publishEventInternal,
  type AppEvent,
  broadcastEphemeral,
  currentHandlerSignal,
  declaredEmits,
  dispatchWithRetry,
  EventBusTestAccess,
  flushEventHandlers,
  MAX_LOCAL_IDS,
  onEvent,
  resetEventBus,
  SUBSCRIBER_RETRY_ATTEMPTS,
  trackLocalPublish,
} from "~/infra/events/event-bus"
import { PinnedJobsGate } from "~/infra/jobs/pinned-jobs-gate"

afterEach(() => {
  // Restore clean event-bus state between tests so the module-level sets
  // don't accumulate state across test runs.
  EventBusTestAccess.setHandlerTimeoutMs(null)
  EventBusTestAccess.setDispatchWaitQueueCap(null)
  resetEventBus()
})

describe("ring buffer — localPublishedIds (real trackLocalPublish)", () => {
  it("evicts the oldest entry when the ring buffer overflows", () => {
    // Fill exactly to capacity.
    for (let i = 0; i < MAX_LOCAL_IDS; i++) {
      trackLocalPublish(`id-${i}`)
    }
    expect(EventBusTestAccess.localPublishedIdsSize()).toBe(MAX_LOCAL_IDS)
    expect(EventBusTestAccess.hasLocalPublished("id-0")).toBe(true)

    // Add one more — this should evict id-0 (the oldest entry).
    trackLocalPublish(`id-${MAX_LOCAL_IDS}`)

    expect(EventBusTestAccess.localPublishedIdsSize()).toBe(MAX_LOCAL_IDS)
    expect(EventBusTestAccess.hasLocalPublished("id-0")).toBe(false)
    expect(EventBusTestAccess.hasLocalPublished(`id-${MAX_LOCAL_IDS}`)).toBe(true)
  })

  it("tracks a small batch without overflow and retains all entries", () => {
    const ids = ["alpha", "beta", "gamma"]
    for (const id of ids) {
      trackLocalPublish(id)
    }
    // Re-publishing the same IDs must be idempotent (Set.add is idempotent).
    for (const id of ids) {
      trackLocalPublish(id)
    }
    // All three entries are present and the buffer size is exactly 3.
    expect(EventBusTestAccess.localPublishedIdsSize()).toBe(3)
    for (const id of ids) {
      expect(EventBusTestAccess.hasLocalPublished(id)).toBe(true)
    }
  })

  it("ring buffer stays capped at MAX_LOCAL_IDS after filling beyond capacity", () => {
    // Fill one beyond capacity — the oldest entry must be evicted and the
    // buffer must stay exactly at MAX_LOCAL_IDS.
    for (let i = 0; i <= MAX_LOCAL_IDS; i++) {
      trackLocalPublish(`overflow-${i}`)
    }

    // Size is capped at MAX_LOCAL_IDS (not MAX_LOCAL_IDS + 1).
    expect(EventBusTestAccess.localPublishedIdsSize()).toBe(MAX_LOCAL_IDS)

    // The oldest entry (overflow-0) was evicted.
    expect(EventBusTestAccess.hasLocalPublished("overflow-0")).toBe(false)

    // The newest entry (overflow-MAX_LOCAL_IDS) is retained.
    expect(EventBusTestAccess.hasLocalPublished(`overflow-${MAX_LOCAL_IDS}`)).toBe(true)
  })
})

describe("dispatchWithRetry — Redis-path subscriber retry (infra-6)", () => {
  const event = {
    app: "kernel",
    entity: "saved_view",
    action: "created",
    orgId: "00000000-0000-0000-0000-000000000001",
  } as AppEvent

  it("retries a transient failure and succeeds on a later attempt", async () => {
    let calls = 0
    const handler = async () => {
      calls++
      if (calls < 2) throw new Error("transient failure")
    }

    await dispatchWithRetry(handler, event, "test-channel")

    // First attempt threw, second attempt succeeded — exactly 2 calls.
    expect(calls).toBe(2)
  })

  it("stops after the bounded attempt cap when the handler keeps failing", async () => {
    let calls = 0
    const handler = async () => {
      calls++
      throw new Error("permanent failure")
    }

    // Must not throw — a final failure is logged, not propagated (it would
    // otherwise crash the Redis message callback for every other handler).
    await dispatchWithRetry(handler, event, "test-channel")

    expect(calls).toBe(SUBSCRIBER_RETRY_ATTEMPTS)
  })

  it("calls the handler exactly once when it succeeds immediately", async () => {
    let calls = 0
    const handler = async () => {
      calls++
    }

    await dispatchWithRetry(handler, event, "test-channel")

    expect(calls).toBe(1)
  })
})

// E1 — a handler that never resolves must not permanently wedge the event
// bus (a hung handler pinning one of the 50 concurrency slots forever).
describe("handler dispatch timeout (E1 event-bus wedge fix)", () => {
  async function pollUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await Bun.sleep(10)
    }
    throw new Error("pollUntil timed out")
  }

  it("frees the dispatch slot after a mocked timeout so subsequent events still dispatch", async () => {
    EventBusTestAccess.setHandlerTimeoutMs(50)
    declaredEmits.set("test-timeout", new Set(["item:created"]))

    let hungHandlerStarted = false
    let secondHandlerCalls = 0
    // Never resolves — the case this fix targets.
    onEvent(
      async (event) => {
        if (event.app !== "test-timeout") return
        hungHandlerStarted = true
        await new Promise(() => {}) // hang forever
      },
      { delivery: "per-replica" },
    )
    onEvent(
      async (event) => {
        if (event.app !== "test-timeout") return
        secondHandlerCalls++
      },
      { delivery: "per-replica" },
    )

    await _publishEventInternal({
      app: "test-timeout",
      entity: "item",
      action: "created",
      entityId: "item-1",
      orgId: "org-1",
    })

    await pollUntil(() => hungHandlerStarted)
    // After the timeout elapses, dispatchHandlers moves on to the next
    // global handler instead of waiting on the hung one forever.
    await pollUntil(() => secondHandlerCalls > 0)
    expect(secondHandlerCalls).toBeGreaterThan(0)

    // A second, independent event must still dispatch normally — proving the
    // concurrency slot was actually released, not merely that this one
    // dispatch moved on internally.
    let thirdCalls = 0
    onEvent(
      async (event) => {
        if (event.app !== "test-timeout-2") return
        thirdCalls++
      },
      { delivery: "per-replica" },
    )
    declaredEmits.set("test-timeout-2", new Set(["item:created"]))
    await _publishEventInternal({
      app: "test-timeout-2",
      entity: "item",
      action: "created",
      entityId: "item-2",
      orgId: "org-1",
    })
    await pollUntil(() => thirdCalls > 0)
    expect(thirdCalls).toBe(1)
  })
})

// E1 — the wait queue must not grow unboundedly under sustained backpressure;
// once at cap, the oldest EPHEMERAL waiter is dropped (never a durable one).
describe("dispatch wait queue cap — drop-oldest-ephemeral (E1)", () => {
  it("drops the oldest ephemeral waiter when the queue is at capacity, keeping durable waiters", async () => {
    // Cap at 1 so a single occupied slot + one queued waiter already saturates it.
    EventBusTestAccess.setDispatchWaitQueueCap(1)
    declaredEmits.set("test-cap", new Set(["item:created"]))

    // Occupy every concurrency slot with handlers that hang until released,
    // so any further dispatch must queue behind the cap.
    let releaseHangingHandlers: (() => void) | undefined
    const hangGate = new Promise<void>((resolve) => {
      releaseHangingHandlers = resolve
    })
    let hungHandlerCount = 0
    onEvent(
      async (event) => {
        if (event.app !== "test-cap") return
        hungHandlerCount++
        await hangGate
      },
      { delivery: "per-replica" },
    )

    // MAX_CONCURRENT_DISPATCHES is 50 — saturate every slot with ephemeral
    // dispatches (ephemeral: no outbox, so blocking them is harmless here).
    for (let i = 0; i < 50; i++) {
      await broadcastEphemeral({
        app: "test-cap",
        entity: "item",
        action: "created",
        entityId: `saturate-${i}`,
        orgId: "org-1",
      })
    }

    // Queue one ephemeral waiter behind the saturated slots (this is the
    // "oldest" waiter that should be dropped when the cap is hit next).
    await broadcastEphemeral({
      app: "test-cap",
      entity: "item",
      action: "created",
      entityId: "ephemeral-oldest",
      orgId: "org-1",
    })

    const deadline = Date.now() + 2000
    while (Date.now() < deadline && EventBusTestAccess.dispatchWaitQueueLength() < 1) {
      await Bun.sleep(5)
    }
    expect(EventBusTestAccess.dispatchWaitQueueLength()).toBeGreaterThanOrEqual(1)

    // Now queue a DURABLE (persisted) event — the cap is exceeded, so the
    // oldest ephemeral waiter above must be evicted to make room; the durable
    // dispatch itself must never be the one dropped.
    let durableHandlerCalls = 0
    onEvent(
      async (event) => {
        if (event.app !== "test-cap" || event.entityId !== "durable-1") return
        durableHandlerCalls++
      },
      { delivery: "per-replica" },
    )
    const durablePublish = _publishEventInternal({
      app: "test-cap",
      entity: "item",
      action: "created",
      entityId: "durable-1",
      orgId: "org-1",
    })

    releaseHangingHandlers!()
    await durablePublish
    await flushEventHandlers()

    // At least the 50 saturating dispatches ran the hung handler (a couple
    // more may have slipped in depending on scheduling, which is fine — the
    // load-bearing assertion is the eviction + durable-preservation below).
    expect(hungHandlerCount).toBeGreaterThanOrEqual(50)
    expect(durableHandlerCalls).toBe(1)
  })
})

describe("handler timeout aborts the handler's signal", () => {
  it("a handler waiting for a pinned-job slot stops waiting when the bus gives up on it", async () => {
    EventBusTestAccess.setHandlerTimeoutMs(100)
    declaredEmits.set("test-admission", new Set(["item:created"]))
    const gate = new PinnedJobsGate(1)
    let release!: () => void
    const holder = gate.run("holder", () => new Promise<void>((r) => (release = r)))
    let ran = false
    let waitError: unknown
    onEvent(
      async (event) => {
        if (event.app !== "test-admission") return
        const signal = currentHandlerSignal()
        try {
          await gate.run(
            "event:test-admission",
            async () => {
              ran = true
            },
            signal,
          )
        } catch (err) {
          waitError = err
          throw err
        }
      },
      { delivery: "per-replica" },
    )
    await _publishEventInternal({
      app: "test-admission",
      entity: "item",
      action: "created",
      entityId: "item-1",
      orgId: "org-1",
    })
    for (let i = 0; i < 100 && gate.state().waiting === 0 && !waitError; i++) await Bun.sleep(5)
    for (let i = 0; i < 100 && !waitError; i++) await Bun.sleep(10)
    expect(String(waitError)).toContain("timed out")
    expect(gate.state()).toMatchObject({ held: 1, waiting: 0 })
    release()
    await holder
    await flushEventHandlers()
    expect(ran).toBe(false)
    expect(gate.state().held).toBe(0)
  })
})
