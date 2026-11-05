// SPDX-License-Identifier: FSL-1.1-ALv2
//
// H3: boot registers no org, so a path that reads an org's registries without
// `awaitOrgApps` first would silently see no apps. The guard catches it on the
// lookup miss: outside production it throws, in production it logs, counts and
// starts the org's setup. The event bus sets the org up before a `once`
// dispatch, so an event routine fires for an org first touched by the event.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  _publishEventInternal,
  declaredEmits,
  EventBusTestAccess,
  flushEventHandlers,
  initEventBus,
  onEvent,
  resetEventBus,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { redisSub } from "~/lib/redis"
import {
  initializedOrgRuntimes,
  orgsKnownMissing,
  orgsRegistering,
  rememberMissingOrg,
  toolRegistry,
} from "~/modules/apps/app-registries"
import {
  installOrgRegistryGuard,
  OrgNotSetUpError,
  OrgRegistryGuardTestAccess,
  onOrgRegistryMiss,
  orgRegistryGuardStats,
} from "~/modules/apps/org-registry-guard"

describe("org registry guard (lookup miss)", () => {
  beforeEach(() => {
    OrgRegistryGuardTestAccess.resetStats()
    installOrgRegistryGuard()
  })
  afterEach(() => OrgRegistryGuardTestAccess.uninstall())

  it("a miss for an org not set up throws outside production", () => {
    const org = randomUUID()
    expect(() => toolRegistry.get([org, "tickets", "list"])).toThrow(OrgNotSetUpError)
    expect(orgRegistryGuardStats().readsBeforeSetup).toBe(1)
  })

  it("a miss for a registered or registering org, or a non-org key, does not throw", () => {
    const registered = randomUUID()
    const registering = randomUUID()
    initializedOrgRuntimes.add(registered)
    orgsRegistering.set(registering, 1)
    try {
      expect(toolRegistry.get([registered, "tickets", "nope"])).toBeUndefined()
      expect(toolRegistry.get([registering, "tickets", "nope"])).toBeUndefined()
      expect(toolRegistry.get(["*", "kernel", "nope"])).toBeUndefined()
    } finally {
      initializedOrgRuntimes.delete(registered)
      orgsRegistering.delete(registering)
    }
    expect(orgRegistryGuardStats().readsBeforeSetup).toBe(0)
  })

  it("a miss for a deleted org (awaitOrgApps found no row) is an answer, not a gap", () => {
    const gone = randomUUID()
    rememberMissingOrg(gone)
    try {
      expect(toolRegistry.get([gone, "tickets", "list"])).toBeUndefined()
    } finally {
      orgsKnownMissing.delete(gone)
    }
    expect(orgRegistryGuardStats().readsBeforeSetup).toBe(0)
  })

  it("remembers at most 10 000 missing orgs, oldest out first", () => {
    const first = randomUUID()
    rememberMissingOrg(first)
    const added: string[] = []
    try {
      for (let i = 0; i < 10_000; i++) {
        const id = randomUUID()
        added.push(id)
        rememberMissingOrg(id)
      }
      expect(orgsKnownMissing.has(first)).toBe(false)
      expect(orgsKnownMissing.size).toBeLessThanOrEqual(10_000)
    } finally {
      for (const id of added) orgsKnownMissing.delete(id)
      orgsKnownMissing.delete(first)
    }
  })

  it("a hit never checks (tests fill registries without registering the org)", () => {
    const org = randomUUID()
    toolRegistry.set([org, "guardtest", "t"], {
      appName: "guardtest",
      name: "t",
      requiredScopes: ["guardtest:t:read"],
    } as Parameters<typeof toolRegistry.set>[1])
    try {
      expect(toolRegistry.get([org, "guardtest", "t"])).toBeDefined()
    } finally {
      toolRegistry.delete([org, "guardtest", "t"])
    }
  })

  it("in production the miss heals: counted, logged, no throw", () => {
    const org = randomUUID()
    expect(() => onOrgRegistryMiss(org, "heal")).not.toThrow()
    expect(orgRegistryGuardStats().readsBeforeSetup).toBe(1)
  })
})

describe("event bus: a once dispatch sets the event's org up first", () => {
  beforeEach(() => {
    resetEventBus()
    initEventBus()
    declaredEmits.set("h3test", new Set(["item:created"]))
  })
  afterEach(async () => {
    await flushEventHandlers()
    EventBusTestAccess.setEnsureEventOrg(undefined)
    redisSub.removeAllListeners("message")
    resetEventBus()
  })

  it("an event for an org no path ensured runs its once handler after the org's setup", async () => {
    const org = randomUUID()
    const order: string[] = []
    EventBusTestAccess.setEnsureEventOrg(async (orgId) => {
      order.push(`ensure:${orgId}`)
    })
    await subscribeToEvent(
      "h3test",
      "item",
      "created",
      async (e) => {
        order.push(`handler:${e.orgId}`)
      },
      { delivery: "once", name: "h3-routine" },
    )
    await _publishEventInternal({
      app: "h3test",
      entity: "item",
      action: "created",
      entityId: "x",
      data: {},
      actorId: "u",
      actorType: "user",
      orgId: org,
    })
    await flushEventHandlers()
    expect(order).toEqual([`ensure:${org}`, `handler:${org}`])
  })

  it("the org's setup subscribes its apps' handlers, and the event that set it up reaches them", async () => {
    const org = randomUUID()
    const order: string[] = []
    // Boot's event-routine trigger: a global once handler, present before any org.
    onEvent(
      async (e) => {
        if (e.app === "h3test") order.push(`routine:${e.orgId}`)
      },
      { delivery: "once", name: "h3-routine-trigger" },
    )
    // The org's setup is what subscribes its app's handler to the channel.
    EventBusTestAccess.setEnsureEventOrg(async (orgId) => {
      order.push(`ensure:${orgId}`)
      await subscribeToEvent(
        "h3test",
        "item",
        "created",
        async (e) => {
          order.push(`app:${e.orgId}`)
        },
        { delivery: "once", name: "h3-app-subscription" },
      )
    })
    await _publishEventInternal({
      app: "h3test",
      entity: "item",
      action: "created",
      entityId: "x",
      data: {},
      actorId: "u",
      actorType: "user",
      orgId: org,
    })
    await flushEventHandlers()
    expect(order).toEqual([`ensure:${org}`, `routine:${org}`, `app:${org}`])
  })

  it("per-replica handlers alone set no org up", async () => {
    const org = randomUUID()
    const ensured: string[] = []
    EventBusTestAccess.setEnsureEventOrg(async (orgId) => {
      ensured.push(orgId)
    })
    await subscribeToEvent("h3test", "item", "created", async () => {}, {
      delivery: "per-replica",
      name: "h3-cache",
    })
    await _publishEventInternal({
      app: "h3test",
      entity: "item",
      action: "created",
      entityId: "x",
      data: {},
      actorId: "u",
      actorType: "user",
      orgId: org,
    })
    await flushEventHandlers()
    expect(ensured).toEqual([])
  })
})
