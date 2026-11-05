// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import {
  isManifestHandler,
  resetAppRegistries,
  toolRegistry,
  webhookHandlers,
} from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-0000000b0001"

describe("registry dual-format support", () => {
  afterEach(() => resetAppRegistries())

  it("toolRegistry accepts manifest-format handler tuple", () => {
    toolRegistry.set([ORG, "myapp", "search"], {
      appName: "myapp",
      name: "search",
      description: "Search items",
      requiredScopes: ["myapp:items:read"],
      handler: { bundlePath: "/apps/myapp/handlers.js", exportName: "search" } as any,
    })
    const tool = toolRegistry.get([ORG, "myapp", "search"])!
    expect(tool.handler).toEqual({ bundlePath: "/apps/myapp/handlers.js", exportName: "search" })
  })

  it("toolRegistry still accepts legacy function handler", () => {
    const fn = async () => ({})
    toolRegistry.set([ORG, "myapp", "legacy"], {
      appName: "myapp",
      name: "legacy",
      description: "Legacy tool",
      requiredScopes: ["myapp:items:read"],
      handler: fn,
    })
    const tool = toolRegistry.get([ORG, "myapp", "legacy"])!
    expect(typeof tool.handler).toBe("function")
  })

  it("isManifestHandler detects handler format correctly", () => {
    const manifestHandler = { bundlePath: "/path", exportName: "fn" }
    const functionHandler = async () => ({})
    expect(isManifestHandler(manifestHandler)).toBe(true)
    expect(isManifestHandler(functionHandler)).toBe(false)
  })

  it("webhookHandlers accepts manifest-format tuples", () => {
    webhookHandlers.set([ORG, "myapp", "hook"], {
      handler: { bundlePath: "/path", exportName: "handleWebhook" } as any,
      verify: { bundlePath: "/path", exportName: "verifyWebhook" } as any,
      appName: "myapp",
      orgId: ORG,
    })
    const wh = webhookHandlers.get([ORG, "myapp", "hook"])!
    expect(wh.handler).toEqual({ bundlePath: "/path", exportName: "handleWebhook" })
  })
})
