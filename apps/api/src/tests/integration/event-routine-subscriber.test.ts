// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { setDeclaredEmits } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-0000000000e1"

// Capture routine-tick enqueues without touching real BullMQ/Redis. Re-export
// the real module surface so other (flat-run) importers are unaffected, but
// replace `enqueueAppJob` with a recorder.
const enqueued: unknown[][] = []
const realJobs = await import("~/infra/jobs/jobs")
// Eager snapshot: `realJobs` is a LIVE namespace view that mock.module patches
// in place, so spreading it below would spread the MOCK on any later re-read.
// Snapshot the real exports BEFORE the mock is installed.
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (...a: unknown[]) => {
    enqueued.push(a)
    return "job-id"
  },
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const {
  registerEventRoutineSubscription,
  EventRoutineSubscriberTestAccess,
  __resetEventRoutineSubscriber,
} = await import("~/infra/jobs/event-routine-subscriber")

// Pin a short coalesce window for this file. The subscriber reads its env once at
// module load, and another file in the same bun process may have loaded it first
// with the 30s default, so the env alone cannot set it.
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

describe("event-routine subscriber (A7)", () => {
  beforeEach(() => {
    enqueued.length = 0
    __resetEventRoutineSubscriber()
    resetEventBus()
    initEventBus()
  })

  test("a matching social:finding:created enqueues one routine-tick", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(1)
    expect(ticks()[0][2]).toMatchObject({ routineId: "R1", orgId: ORG })
  })

  test("the enqueued tick carries the TRIGGERING EVENT (app/entity/action + entityId + data) so the routine can react to it", async () => {
    // An event routine must be able to REACT to the event that fired it (e.g. the inventory:low
    // sku/available/threshold), not blindly re-scan. The subscriber now threads a compact projection
    // of the event into the tick payload; the worker prepends it to the prompt as DATA. This regression
    // FAILS-WITHOUT the threading (payload had only routineId/orgId/scheduledAt).
    await registerEventRoutineSubscription({
      routineId: "R-EV",
      orgId: ORG,
      event: "shopify:inventory:low",
    })
    setDeclaredEmits(ORG, "shopify", new Set(["inventory:low"]))
    await _publishEventInternal({
      app: "shopify",
      entity: "inventory",
      action: "low",
      orgId: ORG,
      entityId: "RAL-BNDL",
      data: { sku: "RAL-BNDL", available: 5, threshold: 10 },
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(1)
    expect(ticks()[0][2]).toMatchObject({
      routineId: "R-EV",
      orgId: ORG,
      triggerEvent: {
        app: "shopify",
        entity: "inventory",
        action: "low",
        entityId: "RAL-BNDL",
        data: { sku: "RAL-BNDL", available: 5, threshold: 10 },
      },
    })
  })

  test("the enqueued tick carries the event's outbox id, which its run row records for the reconciler", async () => {
    await registerEventRoutineSubscription({
      routineId: "R-ID",
      orgId: ORG,
      event: "shopify:inventory:low",
    })
    setDeclaredEmits(ORG, "shopify", new Set(["inventory:low"]))
    const outboxId = "7b1f6a52-2f0c-4d0e-9a59-1a8d6f0c3e11"
    await _publishEventInternal({
      app: "shopify",
      entity: "inventory",
      action: "low",
      orgId: ORG,
      entityId: "SKU-ID",
      _eventId: outboxId,
    } as Parameters<typeof _publishEventInternal>[0])
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks()[0][2]).toMatchObject({ triggerEvent: { entityId: "SKU-ID", eventId: outboxId } })
    // In flight from this enqueue: the reconciler leaves the event to this tick.
    const { inFlightKey } = await import("~/modules/agent/routines/routine-event-reconciler")
    const { redis } = await import("~/lib/redis")
    expect(await redis.exists(inFlightKey("R-ID", outboxId))).toBe(1)
    await redis.del(inFlightKey("R-ID", outboxId))
  })

  test("the tick says whether its event carries outside text: a member's action is internal, a webhook is external", async () => {
    const { sql } = await import("~/db")
    const org = "00000000-0000-4000-8000-0000000071e1"
    const member = "00000000-0000-4000-8000-0000000071e2"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'OriginOrg', 'origin-org-71e1')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${member}, ${org}, 'origin-71e2@test.com', 'Member', 'x', 'active') ON CONFLICT DO NOTHING`
    try {
      await registerEventRoutineSubscription({
        routineId: "R-IN",
        orgId: org,
        event: "projects:task:moved",
      })
      await registerEventRoutineSubscription({
        routineId: "R-OUT",
        orgId: org,
        event: "shopify:inventory:low",
      })
      setDeclaredEmits(org, "projects", new Set(["task:moved"]))
      setDeclaredEmits(org, "shopify", new Set(["inventory:low"]))
      await _publishEventInternal({
        app: "projects",
        entity: "task",
        action: "moved",
        orgId: org,
        entityId: "t1",
        actorType: "user",
        actorId: member,
      })
      await _publishEventInternal({
        app: "shopify",
        entity: "inventory",
        action: "low",
        orgId: org,
        entityId: "sku",
        actorType: "system",
        actorId: "00000000-0000-0000-0000-000000000000",
      })
      await flushEventHandlers()
      await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
      const byRoutine = Object.fromEntries(
        ticks().map((t) => {
          const p = t[2] as { routineId: string; triggerEvent: { origin?: string } }
          return [p.routineId, p.triggerEvent.origin]
        }),
      )
      expect(byRoutine).toEqual({ "R-IN": "internal", "R-OUT": "external" })
    } finally {
      await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  test("a burst of N events for the SAME entity within the window coalesces to one tick", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    for (let i = 0; i < 5; i++) {
      await _publishEventInternal({
        app: "social",
        entity: "finding",
        action: "created",
        orgId: ORG,
        entityId: "f-same",
      })
    }
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(1)
  })

  // Regression for the prod new-ticket drop: coalescing used to be keyed per ROUTINE, so a
  // second DISTINCT ticket created within the 30s window was silently absorbed — that ticket
  // never got a tick and was never triaged. Distinct entities must each enqueue their own tick.
  test("N events for DISTINCT entities within the window each enqueue their own tick", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "tickets:ticket:create",
    })
    setDeclaredEmits(ORG, "tickets", new Set(["ticket:create"]))
    for (let i = 0; i < 3; i++) {
      await _publishEventInternal({
        app: "tickets",
        entity: "ticket",
        action: "create",
        orgId: ORG,
        entityId: `ticket-${i}`,
      })
    }
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(3)
    const entityIds = ticks()
      .map((t) => (t[2] as { triggerEvent?: { entityId?: string } }).triggerEvent?.entityId)
      .sort()
    expect(entityIds).toEqual(["ticket-0", "ticket-1", "ticket-2"])
  })

  // Regression for the prod "reply routine never auto runs" drop (Bug B): distinct
  // entities each enqueue a tick (fixed by the per-entity coalesce key), but the
  // enqueue jobId was `routine-event:<routine>:<ms>` — BullMQ dedups by jobId, so
  // two DISTINCT tickets whose events land in the SAME millisecond collided and one
  // tick was silently dropped. The jobId must carry the entityId so distinct
  // entities are never deduped against each other, even in the same ms.
  test("distinct-entity ticks get distinct jobIds (no same-ms BullMQ dedup drop)", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "tickets:message:create",
    })
    setDeclaredEmits(ORG, "tickets", new Set(["message:create"]))
    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      await _publishEventInternal({
        app: "tickets",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: id,
      })
    }
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    // opts is the 4th enqueueAppJob arg (index 3): { jobId }.
    const jobIds = ticks().map((t) => (t[3] as { jobId?: string } | undefined)?.jobId ?? "")
    expect(jobIds.length).toBe(3)
    // Every jobId distinct AND each carries its entity segment.
    expect(new Set(jobIds).size).toBe(3)
    for (const eid of ["msg-a", "msg-b", "msg-c"]) {
      expect(jobIds.some((j) => j.includes(eid))).toBe(true)
    }
  })

  // §9 #8 (the one hard end-to-end timing target): leading-edge debounce
  // enqueues the FIRST event's tick immediately (≪ 5s), NOT after the full
  // coalesce window. The prior trailing-edge debounce waited ~30s. We assert
  // the tick is observed within 1s of the publish — well inside the 5s budget
  // and independent of EVENT_ROUTINE_COALESCE_MS.
  test("§9 #8: the first event enqueues the tick within 1s (leading edge, not after the coalesce window)", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    const started = Date.now()
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
    })
    await flushEventHandlers()
    // No window wait: the tick must already be enqueued (leading edge).
    const elapsed = Date.now() - started
    expect(ticks().length).toBe(1)
    expect(elapsed).toBeLessThan(1000)
  })

  // SELF-CASCADE GUARD (BL-275): a kind:'event' routine that MUTATES the entity it watches (a
  // WIP-limit routine on projects:task:moved that itself calls projects:move) must NOT re-trigger
  // itself on its OWN moves — queue-event stamps metadata.firedByRoutineId with the firing routine's
  // id, and the subscriber drops any event THIS routine fired. Without the guard the cascade re-fires
  // and over-trims the column past the limit (7→5→3).
  test("an event THIS routine itself fired (metadata.firedByRoutineId === self) does NOT re-trigger it", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    // Settle any delayed dispatch from a prior test, then baseline the tick count so this assertion
    // measures only the NEW ticks from THIS publish (test-isolation: async dispatch + the coalesce
    // timer from an earlier test can land after beforeEach's reset).
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    const before = ticks().length
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
      metadata: { firedByRoutineId: "R1" },
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length - before).toBe(0) // self-emitted move never feeds back into the routine
  })

  test("an event fired by a DIFFERENT routine still triggers this routine (guard is self-only)", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    const before = ticks().length
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
      metadata: { firedByRoutineId: "SOME_OTHER_ROUTINE" },
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length - before).toBe(1) // a different routine's mutation is a legitimate trigger
  })

  test("events for a different org do not trigger another org's routine", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits("00000000-0000-0000-0000-0000000000e2", "social", new Set(["finding:created"]))
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: "00000000-0000-0000-0000-0000000000e2",
      entityId: "f1",
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(0)
  })

  test("registering the same routineId twice yields one active subscription (one tick per event)", async () => {
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    await registerEventRoutineSubscription({
      routineId: "R1",
      orgId: ORG,
      event: "social:finding:created",
    })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(1)
  })

  test("a malformed event string is skipped without crashing", async () => {
    await registerEventRoutineSubscription({ routineId: "R2", orgId: ORG, event: "bad" })
    setDeclaredEmits(ORG, "social", new Set(["finding:created"]))
    await _publishEventInternal({
      app: "social",
      entity: "finding",
      action: "created",
      orgId: ORG,
      entityId: "f1",
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks().length).toBe(0)
  })
})
