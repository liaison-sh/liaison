// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { asSchema } from "ai"
import { z } from "zod"
import {
  findProviderSchemaViolations,
  sanitizeJsonSchemaForProviders,
  toModelInputSchema,
  toProviderSafeInputSchema,
} from "./provider-schema"

describe("provider schema normalization", () => {
  it("rewrites a tuple property into a single-schema array", () => {
    const schema = z.object({
      path: z.string(),
      viewRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    })
    const raw = asSchema(schema as never).jsonSchema as Record<string, any>
    // The defect, pinned: the AI SDK's draft-07 projection emits a LIST.
    expect(Array.isArray(raw.properties.viewRange.items)).toBe(true)

    const safe = sanitizeJsonSchemaForProviders(raw) as Record<string, any>
    expect(findProviderSchemaViolations(safe)).toEqual([])
    expect(safe.properties.viewRange.type).toBe("array")
    expect(safe.properties.viewRange.items.type).toBe("integer")
    expect(safe.properties.viewRange.minItems).toBe(2)
    expect(safe.properties.viewRange.maxItems).toBe(2)
  })

  it("collapses a heterogeneous tuple to anyOf, never a list", () => {
    const raw = asSchema(z.object({ pair: z.tuple([z.string(), z.number()]) }) as never)
      .jsonSchema as Record<string, any>
    const safe = sanitizeJsonSchemaForProviders(raw) as Record<string, any>
    expect(findProviderSchemaViolations(safe)).toEqual([])
    expect(safe.properties.pair.items.anyOf.map((s: any) => s.type)).toEqual(["string", "number"])
  })

  it("normalizes tuples nested in arrays, unions and objects", () => {
    const raw = asSchema(
      z.object({
        rows: z.array(z.tuple([z.string(), z.string()])),
        either: z.union([z.tuple([z.number(), z.number()]), z.string()]),
        nested: z.object({ span: z.tuple([z.number(), z.number()]) }),
      }) as never,
    ).jsonSchema
    expect(findProviderSchemaViolations(sanitizeJsonSchemaForProviders(raw))).toEqual([])
  })

  it("drops an items that hangs off a non-array node", () => {
    const safe = sanitizeJsonSchemaForProviders({
      type: "object",
      properties: { odd: { type: "string", items: { type: "string" } } },
    }) as Record<string, any>
    expect(findProviderSchemaViolations(safe)).toEqual([])
    expect("items" in safe.properties.odd).toBe(false)
  })

  it("keeps accepting and rejecting exactly what the Zod schema did", async () => {
    const schema = z.object({
      path: z.string(),
      viewRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    })
    const safe = toProviderSafeInputSchema(schema as never)
    const validator = asSchema(safe as never)
    expect(findProviderSchemaViolations(validator.jsonSchema)).toEqual([])
    expect((await validator.validate?.({ path: "a.md", viewRange: [1, 9] }))?.success).toBe(true)
    expect((await validator.validate?.({ path: "a.md" }))?.success).toBe(true)
    expect((await validator.validate?.({ path: "a.md", viewRange: "nope" }))?.success).toBe(false)
    expect((await validator.validate?.({ viewRange: [1, 9] }))?.success).toBe(false)
  })

  it("passes a schema that is already provider-safe through untouched", () => {
    const schema = z.object({ q: z.string(), tags: z.array(z.string()) })
    expect(toProviderSafeInputSchema(schema as never)).toBe(schema as never)
  })
})

describe("the schema a model is sent", () => {
  const schema = z.object({
    id: z.uuid(),
    email: z.email().optional(),
    sku: z.string().regex(/^[A-Z]{3}$/),
    pattern: z.string().describe("a property that happens to be called pattern"),
    rows: z.array(z.object({ ownerId: z.uuid() })),
    either: z.union([z.uuid(), z.number()]).optional(),
    pair: z.tuple([z.string(), z.string()]).optional(),
  })
  const VALID = {
    id: "3f2b8c1e-6a4d-4e9b-8f10-2c7d5e9a1b34",
    email: "a@example.com",
    sku: "ABC",
    pattern: "x",
    rows: [{ ownerId: "3f2b8c1e-6a4d-4e9b-8f10-2c7d5e9a1b34" }],
  }
  const projected = asSchema(toModelInputSchema(schema) as never)
  const json = projected.jsonSchema as Record<string, any>

  it("carries no $schema and no pattern beside a uuid or an email, all the way down", () => {
    expect("$schema" in json).toBe(false)
    expect(json.properties.id).toEqual({ type: "string", format: "uuid" })
    expect(json.properties.email).toEqual({ type: "string", format: "email" })
    expect(json.properties.rows.items.properties.ownerId).toEqual({
      type: "string",
      format: "uuid",
    })
    expect(json.properties.either.anyOf[0]).toEqual({ type: "string", format: "uuid" })
  })

  it("keeps every other pattern, a property called pattern, and the provider rewrites", () => {
    expect(json.properties.sku.pattern).toBe("^[A-Z]{3}$")
    expect(json.properties.pattern.description).toContain("happens to be called")
    expect(findProviderSchemaViolations(json)).toEqual([])
    expect(json.required).toEqual(["id", "sku", "pattern", "rows"])
  })

  it("accepts and refuses exactly what the Zod schema does", async () => {
    const check = async (value: unknown) => ({
      projected: (await projected.validate?.(value))?.success,
      zod: schema.safeParse(value).success,
    })
    expect(await check(VALID)).toEqual({ projected: true, zod: true })
    for (const bad of [
      { ...VALID, id: "not-a-uuid" },
      { ...VALID, email: "not-an-email" },
      { ...VALID, sku: "abc" },
      { ...VALID, rows: [{ ownerId: "not-a-uuid" }] },
      { ...VALID, either: "not-a-uuid" },
    ]) {
      expect(await check(bad)).toEqual({ projected: false, zod: false })
    }
  })

  it("does not touch the form an external client reads", () => {
    const full = asSchema(toProviderSafeInputSchema(schema as never) as never).jsonSchema as Record<
      string,
      any
    >
    expect(typeof full.$schema).toBe("string")
    expect(typeof full.properties.id.pattern).toBe("string")
  })
})
