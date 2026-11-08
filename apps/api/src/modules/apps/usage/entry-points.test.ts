// SPDX-License-Identifier: FSL-1.1-ALv2
// What an entry point does at an app day cap, for the ones that need no
// running sandbox: search answers no hits and a typed reason; a held event
// runs its own handler once the job finds the org under its caps, waits again
// while it is not, and is dropped when its subscription is gone.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"
import { appDayKey, CapLimitError, utcDay } from "~/modules/org/caps"
import { makeSandboxSearchHandler } from "~/modules/search/external-bridge"
import { AppDayCapHeldJobError, type AppDayCaps, AppDayCapTestAccess } from "./app-day-cap"
import {
  DeferredEventTestAccess,
  deferEventIfCapped,
  registerDeferrableEventHandler,
  runDeferredAppEvent,
} from "./deferred-event"

const ORG = randomUUID()
const NO_CAPS: AppDayCaps = {
  appRunsPerDay: null,
  appBridgeCallsPerDay: null,
  appCpuMsPerDay: null,
}
let caps: AppDayCaps = NO_CAPS

async function atCap(): Promise<void> {
  caps = { ...NO_CAPS, appRunsPerDay: 1 }
  AppDayCapTestAccess.clearCache()
  await redis.set(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())), "1", "EX", 600)
}

beforeAll(() => {
  AppDayCapTestAccess.setReader(async () => caps)
})
afterEach(async () => {
  caps = NO_CAPS
  AppDayCapTestAccess.clearCache()
  DeferredEventTestAccess.clear()
  await redis.del(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())))
})
afterAll(() => {
  AppDayCapTestAccess.setReader(null)
})

describe("search at an app day cap", () => {
  it("answers no hits and the typed reason; other errors still throw", async () => {
    const handler = makeSandboxSearchHandler({
      appName: "shopify",
      handlerName: "search",
      timeoutMs: 1000,
      dispatch: async () => {
        throw new CapLimitError("appRunsPerDay", 10, 10)
      },
    } as never)
    const res = await handler({ orgId: ORG, userId: "u", query: "q" } as never)
    expect(res.hits).toEqual([])
    expect(res.refused?.code).toBe("APP_RUNS_LIMIT_REACHED")
    expect(res.refused?.message).toContain("10 app runs")
    const failing = makeSandboxSearchHandler({
      appName: "shopify",
      handlerName: "search",
      timeoutMs: 1000,
      dispatch: async () => {
        throw new Error("boom")
      },
    } as never)
    await expect(failing({ orgId: ORG, userId: "u", query: "q" } as never)).rejects.toThrow("boom")
  })
})

describe("an event held at an app day cap", () => {
  const job = (event: unknown) => ({
    orgId: ORG,
    appName: "shopify",
    eventType: "kernel/contact:updated",
    exportName: "onContact",
    event,
  })

  it("under the caps: never held", async () => {
    expect(await deferEventIfCapped(job({ id: 1 }))).toBe(false)
  })

  it("the job runs the same handler once the org is under its caps, without holding it again", async () => {
    const seen: unknown[] = []
    registerDeferrableEventHandler(
      ORG,
      "shopify",
      "kernel/contact:updated",
      "onContact",
      async (e) => {
        // The handler's own check: the event the job runs is never held again.
        expect(await deferEventIfCapped(job(e))).toBe(false)
        seen.push(e)
      },
    )
    await runDeferredAppEvent(job({ id: 7 }))
    expect(seen).toEqual([{ id: 7 }])
  })

  it("still at the cap: the job waits again, the handler does not run", async () => {
    const seen: unknown[] = []
    registerDeferrableEventHandler(
      ORG,
      "shopify",
      "kernel/contact:updated",
      "onContact",
      async (e) => {
        seen.push(e)
      },
    )
    await atCap()
    const err = await runDeferredAppEvent(job({ id: 8 })).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AppDayCapHeldJobError)
    expect(seen).toEqual([])
  })

  it("a subscription that is gone drops the event; bad job data is dropped", async () => {
    const off = registerDeferrableEventHandler(
      ORG,
      "shopify",
      "kernel/contact:updated",
      "onContact",
      async () => {
        throw new Error("must not run")
      },
    )
    off()
    let setups = 0
    DeferredEventTestAccess.setOrgSetup(async () => {
      setups++
    })
    expect(DeferredEventTestAccess.has(ORG, "shopify", "kernel/contact:updated", "onContact")).toBe(
      false,
    )
    await runDeferredAppEvent(job({ id: 9 }))
    expect(setups).toBe(1)
    await runDeferredAppEvent({ orgId: ORG, appName: "../x" })
  })
})
