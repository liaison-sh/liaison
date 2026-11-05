// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { asSchema } from "ai"
import { z } from "zod"
import {
  findProviderSchemaViolations,
  sanitizeJsonSchemaForProviders,
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
