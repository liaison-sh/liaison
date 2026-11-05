// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { computeSchemaHash } from "~/modules/apps/ddl"

describe("computeSchemaHash", () => {
  it("produces identical hash regardless of key order", () => {
    const a = { fields: { name: "text", age: "integer" }, meta: { version: 1 } }
    const b = { meta: { version: 1 }, fields: { age: "integer", name: "text" } }
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b))
  })

  it("produces different hash for different values", () => {
    const a = { fields: { name: "text" } }
    const b = { fields: { name: "integer" } }
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b))
  })

  it("produces identical hash for deeply nested objects with different key order", () => {
    const a = { entities: { user: { fields: { b: "text", a: "int" } } } }
    const b = { entities: { user: { fields: { a: "int", b: "text" } } } }
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b))
  })

  it("returns empty string for undefined schema", () => {
    expect(computeSchemaHash(undefined)).toBe("")
  })
})
