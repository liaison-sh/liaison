// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, mock, test } from "bun:test"
import type { RlsClient } from "~/db"
import { declaredEmits, setDeclaredEmits } from "~/modules/apps/app-registries"
import { createAppContext } from "~/modules/apps/context"

// Minimal mock RlsClient for unit tests that only inspect context shape
const mockRlsClient = {} as unknown as RlsClient

describe("createAppContext", () => {
  test("resolveContact is a function on the context", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient)
    expect(typeof ctx.resolveContact).toBe("function")
  })

  test("context has correct userId and orgId", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient)
    expect(ctx.userId).toBe("user-1")
    expect(ctx.orgId).toBe("org-1")
  })

  test("context has emit, enqueueJob, logger, db", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient)
    expect(typeof ctx.emit).toBe("function")
    expect(typeof ctx.enqueueJob).toBe("function")
    expect(ctx.logger).toBeDefined()
    expect(ctx.db).toBeDefined()
  })

  test("createAppContext exposes dimensionGrants when a user actor is passed", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient, "user", null, {
      actorType: "user",
      userId: "user-1",
      orgId: "org-1",
      scopes: ["test-app:*"],
      dimensionGrants: { market: ["EU", "US"] },
    })
    expect(ctx.dimensionGrants).toEqual({ market: ["EU", "US"] })
  })

  test("createAppContext defaults dimensionGrants to {} when no actor is passed", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient)
    expect(ctx.dimensionGrants).toEqual({})
  })

  test("createAppContext.dimensionGrants is {} for a system actor", () => {
    const ctx = createAppContext("test-app", "user-1", "org-1", mockRlsClient, "user", null, {
      actorType: "system",
      orgId: "org-1",
      purpose: "webhook",
    })
    expect(ctx.dimensionGrants).toEqual({})
  })
})

describe("Security: AppContext.emit validates declared emits", () => {
  test("throws when emitting undeclared event type", async () => {
    // Register a test app with limited declared emits (org-scoped)
    setDeclaredEmits("org1", "test-emit-check", new Set(["item:create", "item:update"]))

    const mockTx = {
      queueEvent: mock(() => Promise.resolve()),
      transaction: mock((fn: any) => fn(mockTx)),
    }

    const ctx = createAppContext("test-emit-check", "user1", "org1", mockTx as any)

    // Valid emit should work
    await ctx.emit({ app: "test-emit-check", entity: "item", action: "create", orgId: "org1" })
    expect(mockTx.queueEvent).toHaveBeenCalledTimes(1)

    // Undeclared emit should throw
    try {
      await ctx.emit({ app: "test-emit-check", entity: "item", action: "delete", orgId: "org1" })
      expect(true).toBe(false)
    } catch (err: any) {
      expect(err.message).toContain("undeclared event")
    }

    // Clean up
    declaredEmits.delete("org1:test-emit-check")
  })
})

describe("Security: AppContext.emit rejects cross-app impersonation", () => {
  test("throws when event.app does not match appName", async () => {
    const mockTx = {
      queueEvent: mock(() => Promise.resolve()),
      transaction: mock((fn: any) => fn(mockTx)),
    }
    const ctx = createAppContext("test", "user1", "org1", mockTx as any)
    await expect(
      ctx.emit({
        app: "kernel",
        entity: "user",
        action: "registered",
        entityId: "1",
        orgId: "org1",
        data: {},
        actorId: "user1",
        actorType: "user",
      }),
    ).rejects.toThrow('App "test" cannot emit events on behalf of "kernel"')
  })
})
