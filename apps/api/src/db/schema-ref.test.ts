// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { schemaRef } from "~/db/schema-ref"

describe("schemaRef", () => {
  const originalPrefix = process.env.SCHEMA_PREFIX

  afterEach(() => {
    if (originalPrefix === undefined) delete process.env.SCHEMA_PREFIX
    else process.env.SCHEMA_PREFIX = originalPrefix
  })

  it("returns name unchanged when SCHEMA_PREFIX is unset", async () => {
    delete process.env.SCHEMA_PREFIX
    const { schemaRef: ref } = await import("~/db/schema-ref")
    expect(ref("kernel")).toBe("kernel")
    expect(ref("app_crm")).toBe("app_crm")
  })

  it("prepends SCHEMA_PREFIX when set", async () => {
    process.env.SCHEMA_PREFIX = "w3_"
    const { schemaRef: ref } = await import("~/db/schema-ref")
    expect(ref("kernel")).toBe("w3_kernel")
    expect(ref("app_crm")).toBe("w3_app_crm")
  })

  it("handles empty string prefix as no prefix", async () => {
    process.env.SCHEMA_PREFIX = ""
    const { schemaRef: ref } = await import("~/db/schema-ref")
    expect(ref("kernel")).toBe("kernel")
  })

  it("reads SCHEMA_PREFIX at call time", () => {
    process.env.SCHEMA_PREFIX = "test_"
    expect(schemaRef("kernel")).toBe("test_kernel")
    delete process.env.SCHEMA_PREFIX
    expect(schemaRef("kernel")).toBe("kernel")
  })
})
