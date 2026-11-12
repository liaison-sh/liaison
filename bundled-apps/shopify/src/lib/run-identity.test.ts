// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { runOrgId, runUserId } from "./run-identity"

describe("run identity", () => {
  it("reads the sandbox getters when the context has no fields (the sandbox's shape)", async () => {
    const ctx = { getOrgId: () => "org-1", getUserId: () => "user-1" } as unknown as AppContext
    expect(await runOrgId(ctx)).toBe("org-1")
    expect(await runUserId(ctx)).toBe("user-1")
  })

  it("awaits a getter that answers through a bridge call (the Workers executor)", async () => {
    const ctx = { getOrgId: async () => "org-2", getUserId: async () => "user-2" } as unknown as AppContext
    expect(await runOrgId(ctx)).toBe("org-2")
    expect(await runUserId(ctx)).toBe("user-2")
  })

  it("prefers the fields a test context sets, and is empty when neither exists", async () => {
    expect(await runOrgId({ orgId: "o", getOrgId: () => "x" } as unknown as AppContext)).toBe("o")
    expect(await runUserId({} as AppContext)).toBe("")
  })
})
