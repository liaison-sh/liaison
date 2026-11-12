// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildParams, paramFields } from "./params-form"

const schema = {
  type: "object" as const,
  properties: {
    email: { type: "string" as const, description: "Contact email" },
    limit: { type: "integer" as const },
    minTotal: { type: "number" as const },
    open: { type: "boolean" as const },
    stage: { type: "string" as const, enum: ["lead", "won", "lost"] },
    tags: { type: "array" as const, items: { type: "string" as const } },
    ids: { type: "array" as const, items: { type: "integer" as const } },
  },
  required: ["email"],
}

describe("paramFields", () => {
  it("derives one field per supported property, with its kind and required flag", () => {
    const fields = paramFields(schema)
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["email", "string", true],
      ["limit", "integer", false],
      ["minTotal", "number", false],
      ["open", "boolean", false],
      ["stage", "enum", false],
      ["tags", "array", false],
      ["ids", "array", false],
    ])
    expect(fields.find((f) => f.name === "stage")?.options).toEqual(["lead", "won", "lost"])
    expect(fields.find((f) => f.name === "ids")?.itemType).toBe("integer")
    expect(fields.find((f) => f.name === "email")?.description).toBe("Contact email")
  })

  it("is empty without a schema", () => {
    expect(paramFields(undefined)).toEqual([])
  })
})

describe("buildParams", () => {
  const fields = paramFields(schema)

  it("types every value and leaves empty optional fields out", () => {
    const out = buildParams(fields, {
      email: " buyer@acme.example ",
      limit: "5",
      minTotal: "12.5",
      open: true,
      stage: "won",
      tags: "vip, eu ,",
      ids: "1,2",
    })
    expect(out).toEqual({
      ok: true,
      params: {
        email: "buyer@acme.example",
        limit: 5,
        minTotal: 12.5,
        open: true,
        stage: "won",
        tags: ["vip", "eu"],
        ids: [1, 2],
      },
    })
    expect(buildParams(fields, { email: "a@b.c" })).toEqual({
      ok: true,
      params: { email: "a@b.c" },
    })
  })

  it("names the field a value is wrong for, instead of sending it", () => {
    const out = buildParams(fields, { email: "", limit: "2.5", minTotal: "abc", ids: "1,x" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors).toEqual({
      email: "required",
      limit: "integer",
      minTotal: "number",
      ids: "integer",
    })
  })

  it("refuses an enum value the schema does not list", () => {
    const out = buildParams(fields, { email: "a@b.c", stage: "maybe" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors).toEqual({ stage: "enum" })
  })
})
