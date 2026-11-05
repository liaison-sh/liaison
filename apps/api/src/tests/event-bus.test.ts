// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  declaredEmits,
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { redisSub } from "~/lib/redis"
import { getAllDeclaredEmits, getDeclaredEmits } from "~/modules/apps/app-registries"

describe("event bus", () => {
  async function pollUntil(
    check: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(50)
    }
    throw new Error("pollUntil timed out")
  }

  let savedEmits: Set<string> | undefined

  beforeAll(() => {
    // Reset all event bus state to avoid interference from other test files
    resetEventBus()
    // Re-initialize in case another test's mock.module broke the setup
    initEventBus()
    // Declare test app emits so event validation passes
    savedEmits = declaredEmits.get("test")
    declaredEmits.set("test", new Set(["item:created", "item:updated", "item:deleted"]))
  })

  afterAll(async () => {
    redisSub.removeAllListeners("message")
    if (savedEmits) declaredEmits.set("test", savedEmits)
  })

  it("publishes event to Redis channel", async () => {
    const received: any[] = []

    await subscribeToEvent(
      "test",
      "item",
      "created",
      async (event) => {
        received.push(event)
      },
      { delivery: "per-replica" },
    )

    await publishEvent({
      app: "test",
      entity: "item",
      action: "created",
      entityId: "item-1",
      data: { title: "Test" },
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })

    await pollUntil(() => received.length > 0)

    expect(received).toHaveLength(1)
    expect(received[0].entityId).toBe("item-1")
  })

  it("multiple subscribers all receive the event", async () => {
    const received1: any[] = []
    const received2: any[] = []

    await subscribeToEvent(
      "test",
      "item",
      "updated",
      async (e) => {
        received1.push(e)
      },
      { delivery: "per-replica" },
    )
    await subscribeToEvent(
      "test",
      "item",
      "updated",
      async (e) => {
        received2.push(e)
      },
      { delivery: "per-replica" },
    )

    await publishEvent({
      app: "test",
      entity: "item",
      action: "updated",
      entityId: "item-2",
      data: {},
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })

    await pollUntil(() => received1.length > 0 && received2.length > 0)

    expect(received1).toHaveLength(1)
    expect(received2).toHaveLength(1)
  })

  it("disposing a subscription stops the handler from receiving further events", async () => {
    const received: any[] = []
    const dispose = await subscribeToEvent(
      "test",
      "item",
      "deleted",
      async (e) => {
        received.push(e)
      },
      { delivery: "per-replica" },
    )

    await publishEvent({
      app: "test",
      entity: "item",
      action: "deleted",
      entityId: "item-d1",
      data: {},
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })
    await pollUntil(() => received.length === 1)

    // Dispose, then publish again — the handler must NOT fire a second time.
    await dispose()
    await publishEvent({
      app: "test",
      entity: "item",
      action: "deleted",
      entityId: "item-d2",
      data: {},
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })
    await flushEventHandlers()
    await Bun.sleep(100)
    expect(received).toHaveLength(1)
    expect(received[0].entityId).toBe("item-d1")

    // Idempotent — a second dispose is a harmless no-op.
    await expect(dispose()).resolves.toBeUndefined()
  })

  it("rejects undeclared event type when app has declared emits", async () => {
    declaredEmits.set("strictapp", new Set(["item:created"]))

    expect(
      publishEvent({
        app: "strictapp",
        entity: "item",
        action: "deleted",
        entityId: "item-99",
        data: {},
        actorId: "user-1",
        orgId: "org-1",
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow('did not declare event type "item:deleted"')

    // Cleanup
    declaredEmits.delete("strictapp")
  })

  it("allows declared event type", async () => {
    declaredEmits.set("strictapp2", new Set(["item:created"]))

    // Should not throw
    await publishEvent({
      app: "strictapp2",
      entity: "item",
      action: "created",
      entityId: "item-100",
      data: {},
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })

    declaredEmits.delete("strictapp2")
  })

  it("subscriber error does not crash the bus and other subscribers still fire", async () => {
    const workingReceived: any[] = []

    // Register a failing subscriber AND a working subscriber on the same channel
    await subscribeToEvent(
      "test",
      "item",
      "deleted",
      async () => {
        throw new Error("handler error")
      },
      { delivery: "per-replica" },
    )
    await subscribeToEvent(
      "test",
      "item",
      "deleted",
      async (event) => {
        workingReceived.push(event)
      },
      { delivery: "per-replica" },
    )

    await publishEvent({
      app: "test",
      entity: "item",
      action: "deleted",
      entityId: "item-3",
      data: {},
      actorId: "user-1",
      orgId: "org-1",
      timestamp: new Date().toISOString(),
    })

    // Wait for all dispatches to complete
    await flushEventHandlers()

    // The working subscriber still fires despite the failing one
    expect(workingReceived.length).toBeGreaterThanOrEqual(1)
    expect(workingReceived[0].entityId).toBe("item-3")
  })

  describe("Fix #5: Role mutations declare correct event types", () => {
    it("role event types are registered in event bus declarations", () => {
      const kernelEmits = declaredEmits.get("kernel")
      expect(kernelEmits).toBeDefined()
      expect(kernelEmits!.has("role:create")).toBe(true)
      expect(kernelEmits!.has("role:delete")).toBe(true)
      expect(kernelEmits!.has("role_scope:grant")).toBe(true)
      expect(kernelEmits!.has("role_scope:revoke")).toBe(true)
      expect(kernelEmits!.has("role_dimension:grant")).toBe(true)
      expect(kernelEmits!.has("role_dimension:revoke")).toBe(true)
      expect(kernelEmits!.has("role_assignment:assign")).toBe(true)
      expect(kernelEmits!.has("role_assignment:unassign")).toBe(true)
      expect(kernelEmits!.has("user_scope:grant")).toBe(true)
      expect(kernelEmits!.has("user_scope:revoke")).toBe(true)
      // An app On/Off/removed/restricted change bumps every member (org-app-service.ts).
      expect(kernelEmits!.has("user_scope:org_app")).toBe(true)
      expect(kernelEmits!.has("user_scope:access")).toBe(true)
      expect(kernelEmits!.has("user_dimension:grant")).toBe(true)
      expect(kernelEmits!.has("user_dimension:revoke")).toBe(true)
    })
  })

  describe("Fix #6: TOTP enable event type registered", () => {
    it("auth:totp_enable is a declared kernel emit", () => {
      const kernelEmits = declaredEmits.get("kernel")
      expect(kernelEmits!.has("auth:totp_enable")).toBe(true)
    })
  })

  describe("kernel emits are visible to the routine-event catalog (not only the bare key)", () => {
    // Regression: initEventBus registered kernel emits ONLY under the bare
    // "kernel" key. The routine-event catalog reads them under the "*:kernel"
    // (global-org) key — getDeclaredEmits("*","kernel") + getAllDeclaredEmits —
    // so kind:'event' routine validation (validateRoutineEvent) and
    // list_routine_events saw ZERO kernel events and rejected every
    // kernel:contact:create / kernel:message:create trigger with a 500. The
    // registration UNIT tests hid this by manually seeding "*:kernel"; prod
    // (and the e2e that drives real initEventBus) never did. The bare key must
    // ALSO stay populated — assertKernelEventDeclared (db/queue-event.ts) and
    // the publish path read it directly.
    it("bare 'kernel' key stays populated (load-bearing for assertKernelEventDeclared)", () => {
      const bare = declaredEmits.get("kernel")
      expect(bare?.has("contact:create")).toBe(true)
    })

    it("getDeclaredEmits('*','kernel') sees kernel emits after the real initEventBus path", () => {
      const global = getDeclaredEmits("*", "kernel")
      expect(global?.has("contact:create")).toBe(true)
      expect(global?.has("message:create")).toBe(true)
    })

    it("getAllDeclaredEmits includes kernel events as full app:entity:action strings", () => {
      const all = getAllDeclaredEmits("00000000-0000-0000-0000-0000000000ff")
      expect(all.some((e) => e.app === "kernel" && e.event === "kernel:contact:create")).toBe(true)
    })
  })

  describe("saved-view event types are declared kernel emits", () => {
    it("saved_view:created|updated|deleted are registered", () => {
      const kernelEmits = declaredEmits.get("kernel")
      expect(kernelEmits).toBeDefined()
      expect(kernelEmits!.has("saved_view:created")).toBe(true)
      expect(kernelEmits!.has("saved_view:updated")).toBe(true)
      expect(kernelEmits!.has("saved_view:deleted")).toBe(true)
    })

    it("publishing a declared saved_view event does not throw", async () => {
      await publishEvent({
        app: "kernel",
        entity: "saved_view",
        action: "created",
        entityId: "view-1",
        orgId: "org-1",
        timestamp: new Date().toISOString(),
      })
    })
  })

  describe("Fix #11: Event handler dispatch is non-blocking", () => {
    it("publishEvent returns before handlers complete", async () => {
      const { onEvent } = await import("~/infra/events/event-bus")

      let handlerResolved = false
      onEvent(
        async () => {
          await new Promise((r) => setTimeout(r, 50))
          handlerResolved = true
        },
        { delivery: "per-replica" },
      )

      await publishEvent({
        app: "kernel",
        entity: "user",
        action: "updated",
        orgId: "org-1",
      })

      // publishEvent should return before the 50ms handler completes
      expect(handlerResolved).toBe(false)

      // Wait for handler to complete
      await new Promise((r) => setTimeout(r, 100))
      expect(handlerResolved).toBe(true)
    })
  })
})
