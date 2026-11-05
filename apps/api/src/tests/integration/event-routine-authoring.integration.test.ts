// SPDX-License-Identifier: FSL-1.1-ALv2
//
// End-to-end reachability (spec B(1)(a)): the agent authoring path
// `create_routine(kind:'event')` persists the `event` column (the B1 fix), and
// the already-built dispatcher then subscribes that routine so publishing the
// named event enqueues exactly one `kernel:routine-tick`. The subscriber-level
// matching/coalesce is covered by event-routine-subscriber.test.ts; this covers
// the create→DB→scheduleRoutineJobs→registerEventRoutineSubscription→publish→
// enqueue chain via the recorder seam (no live BullMQ worker required).

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { handleCreateRoutine } from "~/modules/agent/tools/skills-routines-tools"
import { setDeclaredEmits } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Capture routine-tick enqueues without touching real BullMQ/Redis.
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

const { EventRoutineSubscriberTestAccess, __resetEventRoutineSubscriber } = await import(
  "~/infra/jobs/event-routine-subscriber"
)

// Pin a short coalesce window for this file. The subscriber reads its env once at
// module load, and another file in the same bun process may have loaded it first
// with the 30s default, so the env alone cannot set it.
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

let orgId: string
let userId: string
beforeAll(async () => {
  await acquireTestLock()
  const u = await minimal.orgAdmin((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
  await minimal.thread(orgId, userId)
  enqueued.length = 0
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("event-routine authoring is reachable end to end", () => {
  test("create_routine(kind:'event') persists the event column and subscribes", async () => {
    // create_routine validates kind:'event' against the org's DECLARED-EMITS catalog (the
    // "fabricated event trigger" guard) — in production the app is registered (emits declared) at
    // org init, BEFORE any agent authors a routine, so declare the shopify emit first here too.
    setDeclaredEmits(orgId, "shopify", new Set(["order:fulfilled"]))
    const res = await handleCreateRoutine(
      {
        name: `autoship-${Date.now()}`,
        description: "d",
        kind: "event",
        event: "shopify:order:fulfilled",
        prompt: "Prepare a Boxtal shipment for the fulfilled order.",
        scopes: ["boxtal:shipments:write"],
        visibility: "personal",
        enabled: true,
      },
      {
        orgId,
        userId,
        actorType: "user",
        scopes: ["boxtal:shipments:write", "kernel:routines:write"],
        approverUserId: userId,
      } as never, // AppContext shape — mirror existing routine-tool tests' ctx
    )
    const routine = (res as { routine: { id: string; event: string | null } }).routine
    expect(routine.event).toBe("shopify:order:fulfilled") // B1 fix: column is persisted

    // Publish the event → the subscriber must enqueue exactly one routine-tick.
    setDeclaredEmits(orgId, "shopify", new Set(["order:fulfilled"]))
    await _publishEventInternal({
      app: "shopify",
      entity: "order",
      action: "fulfilled",
      orgId,
      entityId: "ord_42",
      data: { orderId: "ord_42" },
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 100))
    expect(ticks().length).toBe(1)
    expect(ticks()[0][2]).toMatchObject({ routineId: routine.id, orgId })
  })
})
