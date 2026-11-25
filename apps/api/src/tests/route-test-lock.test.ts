// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The route test lock never leaves a later file waiting on a holder that is
// gone. bun runs a process's test files one after another, so a lock still held
// when a file asks for it was leaked by a file that has finished: its afterAll
// threw before releaseTestLock. The next file takes it over and says so, whether
// or not the holder's file name could be read from its stack. The database
// lock holds a connection of its own, so it never waits on the main pool.
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
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
  it("takes the database lock with every connection of the main pool busy", async () => {
    const held = await Promise.all(Array.from({ length: poolPlan.pools.main }, () => sql.reserve()))
    try {
      expect(await within(10_000, RouteTestLockTestAccess.lockSession())).toBe(undefined)
      expect(await within(10_000, RouteTestLockTestAccess.unlockSession())).toBe(undefined)
    } finally {
      for (const conn of held) conn.release()
    }
  })
})
