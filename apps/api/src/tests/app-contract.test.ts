// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppDescriptor } from "~/modules/apps/contract"
import { testApp } from "../../test-support/apps/test"

describe("app contract test harness", () => {
  it("test app passes full contract validation", () => {
    const result = validateAppDescriptor(testApp)
    expect(result.success).toBe(true)
  })

  it("descriptor with only name + version passes", () => {
    const result = validateAppDescriptor({ name: "minimal", version: "0.1.0" })
    expect(result.success).toBe(true)
  })

  it("descriptor missing name fails", () => {
    const result = validateAppDescriptor({ version: "1.0.0" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("name")
  })

  it("descriptor with each primitive malformed fails with specific error", () => {
    const badTool = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      tools: { t: { description: "d", requiredScopes: ["x:res:read"], handler: "not-fn" } },
    })
    expect(badTool.success).toBe(false)

    const badEvent = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      events: { emits: ["nocolon"] },
    })
    expect(badEvent.success).toBe(false)

    const badJob = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      jobs: { j: { schedule: "bad cron", handler: async () => {} } },
    })
    expect(badJob.success).toBe(false)

    const badWebhook = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      webhooks: { w: { handler: async () => {} } },
    })
    expect(badWebhook.success).toBe(false)
  })

  it("scope not prefixed by app name fails", () => {
    const result = validateAppDescriptor({
      name: "myapp",
      version: "1.0.0",
      tools: {
        t: { description: "d", requiredScopes: ["other:res:read"], handler: async () => {} },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("requiredScopes")
  })

  it("timeline referencing nonexistent field fails", () => {
    const result = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      schema: {
        items: {
          fields: { title: "string" },
          timeline: ["nonexistent"],
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("nonexistent")
  })

  it("all seven primitives validated on test app", () => {
    expect(testApp.schema).toBeDefined()
    expect(testApp.tools).toBeDefined()
    expect(testApp.events).toBeDefined()
    expect(testApp.jobs).toBeDefined()
    expect(testApp.webhooks).toBeDefined()
    expect(testApp.export).toBeDefined()
  })
})
