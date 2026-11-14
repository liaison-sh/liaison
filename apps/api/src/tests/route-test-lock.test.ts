// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The route test lock never leaves a later file waiting on a holder that is
// gone. bun runs a process's test files one after another, so a lock still held
// when a file asks for it was leaked by a file that has finished: its afterAll
// threw before releaseTestLock. The next file takes it over and says so, whether
// or not the holder's file name could be read from its stack.
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { DbAcquireTimeoutError } from "~/db/acquire-timeout"
import { poolPlan } from "~/db/process-pool-plan"
import { RouteTestLockTestAccess, releaseTestLock } from "~/tests/route-test-setup"

const within = <T>(ms: number, work: Promise<T>): Promise<T | "timed out"> =>
  Promise.race([work, Bun.sleep(ms).then(() => "timed out" as const)])

describe("route test lock takeover", () => {
  afterAll(async () => {
    await releaseTestLock()
  })

  it("a file takes over a lock leaked by a file it can name", async () => {
    await RouteTestLockTestAccess.acquireAs("/repo/leaker-one.test.ts")
    expect(await within(10_000, RouteTestLockTestAccess.acquireAs("/repo/next-one.test.ts"))).toBe(
      undefined,
    )
    expect(RouteTestLockTestAccess.holder()).toBe("/repo/next-one.test.ts")
  })

  it("a file takes over a lock leaked by a holder whose file is unknown", async () => {
    await RouteTestLockTestAccess.acquireAs(null)
    expect(await within(10_000, RouteTestLockTestAccess.acquireAs("/repo/next-two.test.ts"))).toBe(
      undefined,
    )
    expect(RouteTestLockTestAccess.holder()).toBe("/repo/next-two.test.ts")
  })
})

describe("route test lock connection", () => {
  it("fails within its wait when no connection of the pool comes free, and gives back the late one", async () => {
    const held = await Promise.all(Array.from({ length: poolPlan.pools.main }, () => sql.reserve()))
    let outcome: unknown
    try {
      outcome = await within(
        10_000,
        RouteTestLockTestAccess.reserveLockConnection(300).catch((error: unknown) => error),
      )
    } finally {
      for (const conn of held) conn.release()
    }
    expect(outcome).toBeInstanceOf(DbAcquireTimeoutError)
    // The reserve that timed out got its connection once one came free and
    // released it: the pool still serves every slot.
    await Bun.sleep(50)
    const again = await within(
      10_000,
      Promise.all(Array.from({ length: poolPlan.pools.main }, () => sql.reserve())),
    )
    expect(again).not.toBe("timed out")
    if (again !== "timed out") for (const conn of again) conn.release()
  })
})
