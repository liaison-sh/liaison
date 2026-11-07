// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import type { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"

type Tool = NonNullable<ReturnType<typeof toolRegistry.get>>

function read(extra: Partial<Tool> = {}): Tool {
  return {
    appName: "shop",
    name: "orders_list",
    description: "List the shop's orders",
    requiredScopes: ["shop:orders:read"],
    readOnly: true,
    params: z.object({}),
    handler: async () => ({ orders: [] }),
    ...extra,
  }
}

describe("dashboardSourceRefusal", () => {
  it("a plain read is a source", () => {
    expect(dashboardSourceRefusal(read())).toBeNull()
  })

  it("a read people and agents both call (trustBoundary user, e.g. a connector read) is a source", () => {
    expect(dashboardSourceRefusal(read({ trustBoundary: "user" }))).toBeNull()
  })

  it("internal and agent-only tools are not", () => {
    expect(dashboardSourceRefusal(read({ trustBoundary: "internal" }))).toBe("it crosses a trust boundary")
    expect(dashboardSourceRefusal(read({ trustBoundary: "agent" }))).toBe("it crosses a trust boundary")
  })

  it("a write or a gated read is not", () => {
    expect(dashboardSourceRefusal(read({ readOnly: false }))).toBe("it is not a read")
    expect(dashboardSourceRefusal(read({ gated: true }))).toBe("it needs an approval")
  })
})
