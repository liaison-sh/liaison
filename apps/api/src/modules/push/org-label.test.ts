// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createOrgLabels, ORG_LABEL_TTL_MS } from "~/modules/push/org-label"

describe("push organisation label", () => {
  it("reads a name once per organisation within the window, then again after it", async () => {
    let reads = 0
    let clock = 0
    const labels = createOrgLabels(
      async (orgId) => {
        reads += 1
        return orgId === "a" ? "  Acme  " : null
      },
      () => clock,
    )
    expect(await labels("a")).toBe("Acme")
    expect(await labels("a")).toBe("Acme")
    expect(reads).toBe(1)
    expect(await labels("b")).toBeUndefined()
    clock = ORG_LABEL_TTL_MS + 1
    await labels("a")
    expect(reads).toBe(3)
  })

  it("a failed read costs the label, never the push", async () => {
    const labels = createOrgLabels(async () => {
      throw new Error("db down")
    })
    expect(await labels("a")).toBeUndefined()
  })
})
