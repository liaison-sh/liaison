// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The provisioning context's default DB seams look the real handles up at
// call time. A copy taken when the module was first imported keeps whatever
// stood in for the handle then: a test wrapper that is later removed leaves
// every later provisioning in the process with a seam that returns nothing.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as privilegedModule from "~/db/privileged"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("provisioning context default seams", () => {
  it("still reach the real handle after a wrapper present at first import is removed", async () => {
    const real = privilegedModule.withPrivilegedDb
    const wrapper = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(((
      orgId: string,
      reason: string,
      fn: (tx: never) => Promise<unknown>,
    ) => real(orgId, reason, fn as never)) as never)
    // First import of the context module while the wrapper stands in.
    const { buildProvisionContext } = await import("./types")
    wrapper.mockRestore()
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    expect(await ctx.priv("provision-seam-test", async () => "ran")).toBe("ran")
  })

  it("go through whatever stands in for the handle when they are called", async () => {
    const { buildProvisionContext } = await import("./types")
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    const seen: string[] = []
    const wrapper = spyOn(privilegedModule, "withSystemDb").mockImplementation((async (
      reason: string,
    ) => {
      seen.push(reason)
      return "stood in"
    }) as never)
    try {
      expect(await ctx.sys("provision-seam-test", async () => "real")).toBe("stood in")
      expect(seen).toEqual(["provision-seam-test"])
    } finally {
      wrapper.mockRestore()
    }
  })
})
