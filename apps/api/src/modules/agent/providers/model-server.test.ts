// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3 / A4: an org's own model server is reached only through the outbound
// guards. Private and loopback addresses need the operator's explicit setting,
// link-local and metadata addresses are never reachable, and a demo box takes
// no custom server at all.
import { afterEach, describe, expect, it } from "bun:test"
import { validateModelServerUrl } from "~/modules/agent/providers/model-server"
import { resolveModel } from "~/modules/agent/providers/provider"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"

afterEach(() => {
  delete process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS
  DemoModeTestAccess.set(null)
})

function custom(baseURL: string) {
  return resolveModel({ provider: "custom", modelId: "llama", apiKey: "", baseURL })
}

describe("custom model servers", () => {
  it("refuses a private address unless the operator allows private model servers", async () => {
    await expect(custom("http://192.168.1.20:11434/v1")).rejects.toThrow(
      "This address is on a private network",
    )
    await expect(custom("http://127.0.0.1:8080/v1")).rejects.toThrow(
      "This address is on a private network",
    )
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    await expect(custom("http://192.168.1.20:11434/v1")).resolves.toBeDefined()
    await expect(custom("http://127.0.0.1:8080/v1")).resolves.toBeDefined()
  })

  it("never reaches a metadata address, even with private servers allowed", async () => {
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    await expect(custom("http://169.254.169.254/v1")).rejects.toThrow(
      "This address cannot be used for a model server",
    )
  })

  it("refuses every custom server on a demo box", async () => {
    DemoModeTestAccess.set(true)
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    await expect(validateModelServerUrl("https://example.com/v1")).rejects.toThrow("demo")
    await expect(custom("https://example.com/v1")).rejects.toThrow("demo")
  })

  it("rejects an address that is not a URL with a plain message", async () => {
    await expect(validateModelServerUrl("my-server:8000")).rejects.toThrow("not a valid address")
  })
})
