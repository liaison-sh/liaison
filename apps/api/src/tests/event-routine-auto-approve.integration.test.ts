// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Modules A+B join (B7). Proves two independent capabilities are reachable from
// the seams the deep-week-sim loop later exercises:
//  - an enabled kind='event' routine, once subscribed, enqueues a routine-tick
//    when its event publishes (and a disabled/un-subscribed one does not); and
//  - the auto-approve eval flips under/over its threshold at the real eval path.
//
// The routine-tick BullMQ worker is not auto-booted under the unit harness, so
// the event cases assert the ENQUEUE via the `enqueueAppJob` recorder (the same
// fallback event-routine-subscriber.test.ts uses). The auto-approve cases are
// worker-independent and always run via the real eval path.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { withSystemDb } from "~/db/privileged"
import { autoApprovePolicies, routines } from "~/db/schema/kernel"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { setDeclaredEmits } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

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
  EventRoutineSubscriberTestAccess,
  __resetEventRoutineSubscriber,
  registerEventRoutineSubscription,
} = await import("~/infra/jobs/event-routine-subscriber")

// Pin a short coalesce window for this file. The subscriber reads its env once at
// module load, and another file in the same bun process may have loaded it first
// with the 30s default, so the env alone cannot set it.
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

const ticksFor = (routineId: string) =>
  enqueued.filter(
    ([app, job, data]) =>
      app === "kernel" &&
      job === "routine-tick" &&
      (data as { routineId?: string })?.routineId === routineId,
  )

let orgId: string
let userId: string
let threadId: string
beforeAll(async () => {
  await acquireTestLock()
  const u = await minimal.orgAdmin((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
  threadId = await minimal.thread(orgId, userId)
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
})
afterAll(async () => {
  // NOTE, and the reason this file has a suite to itself: the `mock.module`
  // above replaces `~/infra/jobs/jobs` for the whole bun PROCESS, and putting
  // the real module back here does not undo it for a file bun has already
  // imported. Sharing a process with any file that asserts on the real
  // `enqueueAppJob` makes that file pass or fail on which one bun loaded
  // first. See the `integration-mocked` suite in scripts/test-run.ts.
  await releaseTestLock()
})

describe("Modules A+B wiring", () => {
  test("an enabled kind='event' routine enqueues a tick on its event", async () => {
    enqueued.length = 0
    const [r] = await withSystemDb("t", (db) =>
      db
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name: `autoship-${Date.now()}`,
          description: "d",
          kind: "event",
          event: "shopify:order:fulfilled",
          prompt: "Prepare a Boxtal shipment.",
          scopes: ["boxtal:shipments:write"],
          outputThreadId: threadId,
          createdByActorType: "user",
          createdByUserId: userId,
        })
        .returning(),
    )
    await registerEventRoutineSubscription({ routineId: r.id, orgId, event: r.event! })
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
    await new Promise((res) => setTimeout(res, COALESCE_MS + 100))
    expect(ticksFor(r.id).length).toBe(1)
  })

  test("auto-approve lets a gated refund fall through under threshold; over-threshold gates", async () => {
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId,
        toolName: "shopify:refund_create",
        enabled: true,
        conditions: [{ path: "params.amount.minor", op: "lte", value: 5000 }],
        limits: { windowSeconds: 86400, windowMax: 100000 },
        requiresScope: "shopify:approve",
        createdBy: userId,
      }),
    )
    const { evaluateAutoApprove } = await import("~/modules/approvals/auto-approve")
    const actor = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes: ["shopify:approve"],
      dimensionGrants: {},
    }
    expect(
      (
        await evaluateAutoApprove({
          orgId,
          toolName: "shopify:refund_create",
          params: { amount: { minor: 4000, currency: "EUR" } },
          actor,
          appName: "shopify",
        })
      ).decision,
    ).toBe("auto_approve")
    expect(
      (
        await evaluateAutoApprove({
          orgId,
          toolName: "shopify:refund_create",
          params: { amount: { minor: 9000, currency: "EUR" } },
          actor,
          appName: "shopify",
        })
      ).decision,
    ).toBe("gate")
  })

  test("a disabled/un-subscribed event routine does NOT enqueue a tick on its event", async () => {
    enqueued.length = 0
    const [r] = await withSystemDb("t", (db) =>
      db
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name: `disabled-evt-${Date.now()}`,
          description: "d",
          kind: "event",
          event: "shopify:order:fulfilled",
          prompt: "should not run",
          scopes: ["boxtal:shipments:write"],
          enabled: false,
          outputThreadId: threadId,
          createdByActorType: "user",
          createdByUserId: userId,
        })
        .returning(),
    )
    // A disabled routine is never subscribed — do NOT register it. Publish and assert no tick.
    setDeclaredEmits(orgId, "shopify", new Set(["order:fulfilled"]))
    await _publishEventInternal({
      app: "shopify",
      entity: "order",
      action: "fulfilled",
      orgId,
      entityId: "ord_99",
      data: { orderId: "ord_99" },
    })
    await flushEventHandlers()
    await new Promise((res) => setTimeout(res, COALESCE_MS + 100))
    expect(ticksFor(r.id).length).toBe(0)
  })
})
