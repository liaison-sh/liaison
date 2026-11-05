// SPDX-License-Identifier: FSL-1.1-ALv2
// The committed adapter.schema.json is the published form of the zod schema.
// Drift fails here: regenerate with `bun run gen:schema` in this package.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROLE_REGISTRY, toJsonSchema } from "./index"

describe("adapter.schema.json", () => {
  it("matches toJsonSchema()", () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "adapter.schema.json"), "utf8"),
    )
    expect(committed).toEqual(JSON.parse(JSON.stringify(toJsonSchema())))
  })

  it("is draft 2020-12 and lists every role", () => {
    const schema = toJsonSchema()
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    const text = JSON.stringify(schema)
    for (const role of Object.keys(ROLE_REGISTRY)) expect(text).toContain(role)
  })
})
