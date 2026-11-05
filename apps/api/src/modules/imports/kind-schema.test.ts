// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  compileKindSchema,
  type ImportKindDecl,
  kindRecordError,
} from "~/modules/imports/kind-schema"

const schema = {
  type: "object",
  required: ["email"],
  properties: { email: { type: "string" }, id: { type: "string", format: "uuid" } },
  additionalProperties: false,
}

const decl: ImportKindDecl = {
  schema,
  handler: "importPeople",
  dedupKey: "email",
  tables: ["app_x.people"],
  writeScopes: ["x:write"],
}

describe("compileKindSchema", () => {
  it("compiles a schema object once", () => {
    expect(compileKindSchema(schema)).toBe(compileKindSchema(schema))
  })

  it("accepts descriptive keywords and the uuid format", () => {
    const fn = compileKindSchema({ type: "object", description: "d", examples: [{}] })
    expect(fn({})).toBe(true)
  })

  it("refuses a schema that is not a valid JSON Schema with Ajv's own message", () => {
    expect(() => compileKindSchema({ type: "nope" })).toThrow(/^schema is invalid: /)
  })
})

describe("kindRecordError", () => {
  it("is null for a valid record", () => {
    expect(kindRecordError(decl, { email: "a@b.c" })).toBeNull()
  })

  it("joins every error, naming an extra property", () => {
    expect(kindRecordError(decl, { id: "nope", extra: 1 })).toBe(
      "/: must have required property 'email'; /: must NOT have additional properties (extra); /id: must match format \"uuid\"",
    )
  })
})
