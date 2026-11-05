// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A test file whose afterAll throws before releaseTestLock leaves the route-test
// lock held. bun runs files one after another, so the next file used to wait on
// it until its beforeAll timed out, and so did every file after it. The next
// file now takes the lock over (route-test-setup.ts, `_holderFile`).
import { describe, expect, it } from "bun:test"
import {
  RouteTestLockTestAccess,
  releaseTestLock,
  testFileFromStack,
} from "~/tests/route-test-setup"

describe("route-test lock", () => {
  it("names the test file that asks for it", () => {
    const stack = [
      "Error",
      "    at acquireTestLock (/r/apps/api/src/tests/route-test-setup.ts:210:40)",
      "    at <anonymous> (/r/apps/api/src/modules/x/y.test.ts:12:11)",
    ].join("\n")
    expect(testFileFromStack(stack)).toBe("/r/apps/api/src/modules/x/y.test.ts")
    expect(testFileFromStack("Error\n    at f (/r/lib.ts:1:1)")).toBeNull()
  })

  it("is taken over by the next file when a finished file never released it", async () => {
    // The leaker: acquires and never releases, as an afterAll that threw does.
    await RouteTestLockTestAccess.acquireAs("/r/leaker.test.ts")
    const next = RouteTestLockTestAccess.acquireAs("/r/next.test.ts")
    const outcome = await Promise.race([
      next.then(() => "acquired"),
      new Promise((r) => setTimeout(() => r("still waiting"), 10_000)),
    ])
    expect(outcome).toBe("acquired")
    expect(RouteTestLockTestAccess.holder()).toBe("/r/next.test.ts")
    await releaseTestLock()
    expect(RouteTestLockTestAccess.holder()).toBeNull()
  })
})
