// SPDX-License-Identifier: FSL-1.1-ALv2
// A job an app enqueues runs as the identity of the bridge that enqueued it:
// the acting user of a user's turn, or the app itself. The payload the app
// hands over cannot name another user or another scope set, and its job id is
// a deduplication key scoped to the enqueuing org.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as jobsModule from "~/infra/jobs/jobs"
import { createAppContext } from "~/modules/apps/context"
import { createEventHandlerBridge } from "~/modules/apps/sandbox/event-handler-bridge"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-0000-0000-0000000e0001"
const USER = "00000000-0000-0000-0000-0000000e0002"
const OTHER_USER = "00000000-0000-0000-0000-0000000e0003"
const APP = "test-jobs-app"

const tx: Record<string, unknown> = {
  execute: mock(async () => []),
  queueEvent: mock(async () => {}),
  // A savepoint on the same mock (the sandbox bridge runs each call in one).
  transaction: (fn: (sp: unknown) => Promise<unknown>) => fn(tx),
}
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

let enqueued: Array<{ payload: Record<string, unknown>; opts: unknown }>
let spy: ReturnType<typeof spyOn>

beforeEach(() => {
  enqueued = []
  spy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
    _app: string,
    _job: string,
    payload: unknown,
    opts?: unknown,
  ) => {
    enqueued.push({ payload: payload as Record<string, unknown>, opts })
    return "id"
  }) as never)
})
afterEach(() => spy.mockRestore())

const forged = JSON.stringify({
  page: 2,
  _userId: OTHER_USER,
  _callerScopes: ["*"],
  _tx: "x",
  _session: "y",
  orgId: "00000000-0000-0000-0000-0000000e0999",
})

describe("ctx.enqueueJob identity", () => {
  it("a system bridge's job carries no user identity, whatever the payload names", async () => {
    const bridge = createRpcBridge(APP, `system:${APP}:cron`, ORG, tx as never, manifest as never)
    await bridge.enqueueJob("sync", forged)
    expect(enqueued).toHaveLength(1)
    const p = enqueued[0].payload
    expect(p.page).toBe(2)
    expect(p.orgId).toBe(ORG)
    expect(p._userId).toBeUndefined()
    expect(p._callerScopes).toBeUndefined()
    expect(p._tx).toBeUndefined()
    expect(p._session).toBeUndefined()
  })

  it("an event handler's job runs as the app, not as a user the payload names", async () => {
    const bridge = createEventHandlerBridge({
      appName: APP,
      actorId: USER,
      orgId: ORG,
      txDb: tx as never,
      manifest: manifest as never,
      actorType: "user",
    })
    await bridge.enqueueJob("sync", forged)
    expect(enqueued[0].payload._userId).toBeUndefined()
    expect(enqueued[0].payload._callerScopes).toBeUndefined()
  })

  it("a user's turn stamps that user and the turn's scopes, never the payload's", async () => {
    const bridge = createRpcBridge(APP, USER, ORG, tx as never, manifest as never, [`${APP}:read`])
    await bridge.enqueueJob("sync", forged)
    expect(enqueued[0].payload._userId).toBe(USER)
    expect(enqueued[0].payload._callerScopes).toEqual([`${APP}:read`])
  })

  it("a sandbox payload's _fanout is dropped (a fan-out run's epoch is the host's)", async () => {
    const bridge = createRpcBridge(APP, `system:${APP}:cron`, ORG, tx as never, manifest as never)
    await bridge.enqueueJob(
      "sync",
      JSON.stringify({ page: 1, _fanout: { app: APP, job: "sync", epoch: 1 } }),
    )
    expect(enqueued[0].payload._fanout).toBeUndefined()
    expect(enqueued[0].payload.page).toBe(1)
  })

  it("scopes the deduplication id to the enqueuing org", async () => {
    const bridge = createRpcBridge(APP, `system:${APP}:cron`, ORG, tx as never, manifest as never)
    await bridge.enqueueJob("sync", "{}", JSON.stringify({ jobId: "initial:acct" }))
    expect((enqueued[0].opts as { jobId?: string }).jobId).toBe(`${ORG}:initial:acct`)
  })

  it("a host app context's job never takes an identity from its payload either", async () => {
    const ctx = createAppContext(APP, USER, ORG, tx as never)
    await ctx.enqueueJob("sync", JSON.parse(forged))
    expect(enqueued[0].payload.orgId).toBe(ORG)
    expect(enqueued[0].payload._userId).toBeUndefined()
    expect(enqueued[0].payload._callerScopes).toBeUndefined()
    expect(enqueued[0].payload.page).toBe(2)
  })
})

describe("ctx.jobs.enqueue and ctx.timers.wakeIn", () => {
  const systemBridge = () =>
    createRpcBridge(APP, `system:${APP}:cron`, ORG, tx as never, manifest as never)
  const hostForged = JSON.stringify({
    page: 3,
    _steps: { s: { epoch: "e", gen: 9 } },
    _wakeAt: 1,
    orgId: "00000000-0000-0000-0000-0000000e0999",
  })

  it("jobs.enqueue: host fields dropped, org pinned, delay clamped to 15 min, id org-scoped", async () => {
    await systemBridge().jobs_enqueue(
      "sync",
      hostForged,
      JSON.stringify({ delay: 3_600_000, jobId: "p3" }),
    )
    const { payload, opts } = enqueued[0]
    expect(payload).toEqual({ page: 3, orgId: ORG })
    expect(opts).toEqual({ jobId: `${ORG}:p3`, delay: 15 * 60 * 1000 })
  })

  it("jobs.enqueue: no options, no payload", async () => {
    await systemBridge().jobs_enqueue("sync")
    expect(enqueued[0].payload).toEqual({ orgId: ORG })
    expect(enqueued[0].opts).toEqual({})
  })

  it("timers.wakeIn under 15 min: one delayed job, its id deduplicated while pending", async () => {
    await systemBridge().timers_wakeIn(90, "poll", '{"r":1}', JSON.stringify({ jobId: "poll" }))
    expect(enqueued[0].payload).toEqual({ r: 1, orgId: ORG })
    expect(enqueued[0].opts).toEqual({ jobId: `${ORG}:poll`, delay: 90_000, dedupTtlMs: 90_000 })
  })

  it("timers.wakeIn past 15 min: waits 15 min at a time until _wakeAt", async () => {
    const before = Date.now()
    await systemBridge().timers_wakeIn(7_200, "poll", hostForged)
    const { payload, opts } = enqueued[0]
    expect(payload.page).toBe(3)
    expect(payload._steps).toBeUndefined()
    expect(payload._wakeAt as number).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(payload._wakeAt as number).toBeLessThanOrEqual(Date.now() + 7_200_000)
    expect(opts).toEqual({ delay: 15 * 60 * 1000 })
  })

  it("timers.wakeIn refuses a negative, non-numeric or over-30-day wait", async () => {
    for (const bad of [-1, "60", Number.NaN, 31 * 24 * 3600]) {
      await expect(systemBridge().timers_wakeIn(bad, "poll")).rejects.toMatchObject({
        code: "invalid_wake",
        status: 400,
      })
    }
    expect(enqueued).toHaveLength(0)
  })

  it("the host app context passes delay and an org-scoped id", async () => {
    const ctx = createAppContext(APP, USER, ORG, tx as never)
    await ctx.enqueueJob("sync", { page: 1 }, { delay: 2_000, jobId: "k" })
    expect(enqueued[0].opts).toEqual({ jobId: `${ORG}:k`, delay: 2_000 })
  })
})
