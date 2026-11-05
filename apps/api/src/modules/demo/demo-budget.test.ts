// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visitor budget engine against real Redis and the real ledger.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Drop the charge from one budget in RESERVE_LUA: the 10-concurrent test
//    ends above cap + one step.
//  * Settle into the CURRENT bucket instead of the reservation's: "settle lands
//    in the reservation's bucket" fails across the boundary.
//  * Remove the rehydrate (return 0 on a missing key): "a Redis flush does not
//    reset a budget" admits a full budget again.
//  * Skip the ledger write at reserve: the expired-hold and failed-settle
//    tests lose the step after a Redis flush.
//  * Skip the counter reset after a failed Redis settle: the "Redis half of a
//    settle fails" test still refuses on the stale counter.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  acquireTurnSlot,
  DemoBudgetRefusal,
  DemoBudgetTestAccess,
  type DemoSpendIdentity,
  isLive,
  RESERVATION_TTL_MS,
  releaseReservation,
  releaseTurnSlot,
  reserveStep,
  settleStep,
  snapshot,
  takeWebSearch,
} from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { DemoSpendLedgerTestAccess, demoLedgerRead } from "~/modules/demo/demo-spend"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

type EnvKey = keyof typeof env
function setEnv<K extends EnvKey>(key: K, value: (typeof env)[K]): () => void {
  const target = env as Record<K, (typeof env)[K]>
  const saved = target[key]
  target[key] = value
  return () => {
    target[key] = saved
  }
}

const ORG = "00000000-0000-4000-8000-0000000000b1"
const MODEL = "deepseek/deepseek-v4.1-flash"
let seq = 0
function who(network = `198.51.100.0/24-${seq}`): DemoSpendIdentity {
  seq += 1
  return { emailNormalized: `visitor${seq}-${Date.now()}@example.com`, network }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "admitted"
  } catch (err) {
    if (err instanceof DemoBudgetRefusal) return err.code
    throw err
  }
}

describe("visitor budget engine", () => {
  const restores: Array<() => void> = []
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
  })
  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })
  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.()
    DemoBudgetTestAccess.setNow(null)
    DemoSpendLedgerTestAccess.failWrites(false)
    await sql`DELETE FROM kernel.demo_spend`
    await clearRedisPatterns(["demo:*"])
  })

  it("admits a step at the email budget minus epsilon and refuses one past it", async () => {
    const id = who()
    const cap = 200_000
    const first = await reserveStep(id, MODEL, cap - 1, ORG)
    expect(await code(reserveStep(id, MODEL, 2, ORG))).toBe("demo_budget_exhausted")
    await settleStep(first, cap - 1)
    expect(await code(reserveStep(id, MODEL, 1, ORG))).toBe("admitted")
    expect(await code(reserveStep(id, MODEL, 1, ORG))).toBe("demo_budget_exhausted")
  })

  it("caps a client network across emails at its daily budget", async () => {
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", 1))
    const net = "203.0.113.0/24"
    const a = who(net)
    const b = who(net)
    const r = await reserveStep(a, MODEL, 400_000, ORG)
    await settleStep(r, 400_000)
    // 0.60 EUR - epsilon admits, + epsilon refuses, from another email.
    expect(await code(reserveStep(b, MODEL, 199_999, ORG))).toBe("admitted")
    expect(await code(reserveStep(b, MODEL, 2, ORG))).toBe("demo_network_exhausted")
    // Another network is unaffected.
    expect(await code(reserveStep(who(), MODEL, 2, ORG))).toBe("admitted")
  })

  it("refuses everyone past the box's daily ceiling", async () => {
    restores.push(setEnv("LIAISON_DEMO_BOX_DAILY_EUR", 0.3))
    restores.push(setEnv("LIAISON_DEMO_BOX_HOURLY_EUR", 1))
    const r = await reserveStep(who(), MODEL, 150_000, ORG)
    await settleStep(r, 150_000)
    const r2 = await reserveStep(who(), MODEL, 149_999, ORG)
    await settleStep(r2, 149_999)
    expect(await code(reserveStep(who(), MODEL, 2, ORG))).toBe("demo_box_exhausted")
    expect((await snapshot(who())).boxExhausted).toBe(false)
    await settleStep(await reserveStep(who(), MODEL, 1, ORG), 1)
    expect((await snapshot(who())).boxExhausted).toBe(true)
  })

  it("rolls the hourly window by bucket and settles into the reservation's own bucket", async () => {
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", 10))
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_NETWORK_EUR", 10))
    restores.push(setEnv("LIAISON_DEMO_BOX_HOURLY_EUR", 0.1))
    const base = Date.UTC(2026, 9, 23, 10, 4, 0) // 10:04, bucket 10:00
    let now = base
    DemoBudgetTestAccess.setNow(() => now)
    const r = await reserveStep(who(), MODEL, 60_000, ORG)
    now = base + 2 * 60_000 // 10:06, the next bucket
    await settleStep(r, 60_000)
    const [inHoldBucket, inNowBucket] = await demoLedgerRead([
      { budget: "boxhour", key: "box", period: String(Date.UTC(2026, 9, 23, 10, 0, 0)) },
      { budget: "boxhour", key: "box", period: String(Date.UTC(2026, 9, 23, 10, 5, 0)) },
    ])
    expect(inHoldBucket).toBe(60_000)
    expect(inNowBucket).toBe(0)
    // Inside the hour the window still counts it.
    expect(await code(reserveStep(who(), MODEL, 40_001, ORG))).toBe("demo_box_exhausted")
    // An hour after the bucket it rolled out.
    now = Date.UTC(2026, 9, 23, 11, 1, 0)
    expect(await code(reserveStep(who(), MODEL, 90_000, ORG))).toBe("admitted")
  })

  it("does not reset a budget when Redis is flushed: counters come back from the ledger", async () => {
    const id = who()
    await settleStep(await reserveStep(id, MODEL, 150_000, ORG), 150_000)
    await clearRedisPatterns(["demo:*"])
    expect(await code(reserveStep(id, MODEL, 50_001, ORG))).toBe("demo_budget_exhausted")
    expect(await code(reserveStep(id, MODEL, 50_000, ORG))).toBe("admitted")
  })

  it("two concurrent rehydrates end at one value", async () => {
    const id = who()
    await settleStep(await reserveStep(id, MODEL, 100_000, ORG), 100_000)
    await clearRedisPatterns(["demo:*"])
    await Promise.all([reserveStep(id, MODEL, 10, ORG), reserveStep(id, MODEL, 10, ORG)])
    const keys = await redis.keys(`*demo:b:s:email:${id.emailNormalized}`)
    expect(keys.length).toBe(1)
    const raw = await redis.get(`demo:b:s:email:${id.emailNormalized}`)
    // The ledger's 100,000, then each admitted step's hold of 10.
    expect(Number(raw)).toBe(100_020)
  })

  it("a ledger failure at settle leaves the step counted at its max, durably", async () => {
    const id = who()
    const r = await reserveStep(id, MODEL, 150_000, ORG)
    DemoSpendLedgerTestAccess.failWrites(true)
    await settleStep(r, 10_000)
    DemoSpendLedgerTestAccess.failWrites(false)
    // The ledger still holds the reserved max (the pending record written at reserve).
    expect(
      (await demoLedgerRead([{ budget: "email", key: id.emailNormalized, period: "life" }]))[0],
    ).toBe(150_000)
    expect(await code(reserveStep(id, MODEL, 50_001, ORG))).toBe("demo_budget_exhausted")
    // Things recover (a Redis flush on top): the spend is still counted.
    await clearRedisPatterns(["demo:*"])
    expect(await code(reserveStep(id, MODEL, 50_001, ORG))).toBe("demo_budget_exhausted")
    expect(await code(reserveStep(id, MODEL, 50_000, ORG))).toBe("admitted")
  })

  it("the Redis half of a settle failing resets the counters to the ledger", async () => {
    const id = who()
    const r = await reserveStep(id, MODEL, 150_000, ORG)
    DemoBudgetTestAccess.failCounterAdjust(true)
    try {
      await settleStep(r, 10_000)
    } finally {
      DemoBudgetTestAccess.failCounterAdjust(false)
    }
    expect(
      (await demoLedgerRead([{ budget: "email", key: id.emailNormalized, period: "life" }]))[0],
    ).toBe(10_000)
    // Rehydrated from the ledger (10,000), not left at the stale 150,000.
    expect(await code(reserveStep(id, MODEL, 190_000, ORG))).toBe("admitted")
    expect(await code(reserveStep(id, MODEL, 1, ORG))).toBe("demo_budget_exhausted")
  })

  it("a ledger failure at reserve refuses the step and holds nothing", async () => {
    const id = who()
    DemoSpendLedgerTestAccess.failWrites(true)
    expect(await code(reserveStep(id, MODEL, 150_000, ORG))).toBe("demo_unavailable")
    DemoSpendLedgerTestAccess.failWrites(false)
    expect(await code(reserveStep(id, MODEL, 200_000, ORG))).toBe("admitted")
  })

  it("a hold that expires unsettled stays counted at its max", async () => {
    const id = who()
    let now = Date.now()
    DemoBudgetTestAccess.setNow(() => now)
    await settleStep(await reserveStep(id, MODEL, 50_000, ORG), 50_000)
    const lost = await reserveStep(id, MODEL, 100_000, ORG) // never settled
    now += RESERVATION_TTL_MS + 1
    expect(await isLive(lost, ORG)).toBe(false)
    expect(await code(reserveStep(id, MODEL, 50_001, ORG))).toBe("demo_budget_exhausted")
    expect((await snapshot(id)).usedMicroEur).toBe(150_000)
    // A late settle of the expired hold hands nothing back.
    await settleStep(lost, 1)
    expect((await snapshot(id)).usedMicroEur).toBe(150_000)
  })

  it("10 concurrent steps at the budget minus epsilon end at most one step over the cap", async () => {
    // C6 discriminator. Each step is reserved at its max and the provider then
    // bills MORE than reserved (the estimate-error case the bound allows).
    const id = who()
    const cap = 200_000
    const stepMax = 20_349
    await settleStep(await reserveStep(id, MODEL, cap - stepMax - 1, ORG), cap - stepMax - 1)
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveStep(id, MODEL, stepMax, ORG)),
    )
    const admitted = results.filter((r) => r.status === "fulfilled")
    expect(admitted.length).toBe(1)
    for (const r of admitted) {
      if (r.status === "fulfilled") await settleStep(r.value, stepMax * 2)
    }
    const spent = (await snapshot(id)).usedMicroEur
    expect(spent).toBeLessThanOrEqual(cap + stepMax)
    expect(await code(reserveStep(id, MODEL, 1, ORG))).toBe("demo_budget_exhausted")
  })

  it("a released hold spends nothing", async () => {
    const id = who()
    const r = await reserveStep(id, MODEL, 200_000, ORG)
    await releaseReservation(r)
    expect(await isLive(r, ORG)).toBe(false)
    expect(await code(reserveStep(id, MODEL, 200_000, ORG))).toBe("admitted")
  })

  describe("turn slots", () => {
    it("refuses a 3rd concurrent turn for one email, and frees it on release", async () => {
      const id = who()
      const a = await acquireTurnSlot(id)
      await acquireTurnSlot(id)
      expect(await code(acquireTurnSlot(id))).toBe("demo_busy")
      await releaseTurnSlot(a)
      expect(await code(acquireTurnSlot(id))).toBe("admitted")
    })

    it("refuses the 9th concurrent turn box-wide", async () => {
      for (let i = 0; i < 8; i++) await acquireTurnSlot(who())
      expect(await code(acquireTurnSlot(who()))).toBe("demo_busy")
    })

    it("admits any number of turns of one email in a row: the budget is the limit", async () => {
      const id = who()
      for (let i = 0; i < 20; i++) await releaseTurnSlot(await acquireTurnSlot(id))
      expect(await code(acquireTurnSlot(id))).toBe("admitted")
    })
  })

  describe("web search allowance", () => {
    it("allows 2 per turn and 15 per email per day", async () => {
      const id = who()
      for (let i = 0; i < 2; i++) expect(await takeWebSearch(id, "turn-1")).toBe("ok")
      expect(await takeWebSearch(id, "turn-1")).toBe("turn")
      for (let t = 2; t <= 7; t++) {
        for (let i = 0; i < 2; i++) expect(await takeWebSearch(id, `turn-${t}`)).toBe("ok")
      }
      // 14 taken: one more fits the day, then the day is spent.
      expect(await takeWebSearch(id, "turn-8")).toBe("ok")
      expect(await takeWebSearch(id, "turn-9")).toBe("day")
    })
  })
})
