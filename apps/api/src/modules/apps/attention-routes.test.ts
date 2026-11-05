// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { z } from "zod"

// The route's body validator is the same shape we test directly to keep this
// suite free of full HTTP/RLS bootstrapping. Integration coverage lives in
// `tests/integration/attention.feed.integration.test.ts`.
const markReadEntitySchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
})
const markReadAllSchema = z.object({ all: z.literal(true) })
const markReadGroupSchema = z
  .object({
    app: z.string().min(1),
    kinds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
const markReadSchema = z.union([markReadEntitySchema, markReadAllSchema, markReadGroupSchema])

describe("mark-read body schema", () => {
  it("accepts {app, entityType, entityId}", () => {
    const out = markReadSchema.safeParse({
      app: "kernel",
      entityType: "thread",
      entityId: "t1",
    })
    expect(out.success).toBe(true)
  })

  it("accepts {all: true}", () => {
    const out = markReadSchema.safeParse({ all: true })
    expect(out.success).toBe(true)
  })

  it("rejects empty object", () => {
    const out = markReadSchema.safeParse({})
    expect(out.success).toBe(false)
  })

  it("rejects {all: false}", () => {
    const out = markReadSchema.safeParse({ all: false })
    expect(out.success).toBe(false)
  })

  it("accepts group form {app}", () => {
    const out = markReadSchema.safeParse({ app: "shopify" })
    expect(out.success).toBe(true)
  })

  it("accepts group form {app, kinds}", () => {
    const out = markReadSchema.safeParse({
      app: "shopify",
      kinds: ["shopify:order.unfulfilled", "shopify:order.created"],
    })
    expect(out.success).toBe(true)
  })

  it("rejects group form with empty kinds array", () => {
    const out = markReadSchema.safeParse({ app: "shopify", kinds: [] })
    expect(out.success).toBe(false)
  })

  it("rejects missing entityId (must not degrade into app-wide group mark-read)", () => {
    const out = markReadSchema.safeParse({ app: "kernel", entityType: "thread" })
    expect(out.success).toBe(false)
  })

  it("rejects empty strings", () => {
    const out = markReadSchema.safeParse({ app: "", entityType: "thread", entityId: "x" })
    expect(out.success).toBe(false)
  })
})
