// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { bulkDispatchRequestSchema, bulkDispatchResponseSchema } from "./bulk"

const UUID = "11111111-1111-4111-8111-111111111111"

describe("bulkDispatchRequestSchema", () => {
  it("requires uuid idempotencyKey", () => {
    const r = bulkDispatchRequestSchema.safeParse({
      ids: ["a"],
      params: {},
      idempotencyKey: "not-uuid",
    })
    expect(r.success).toBe(false)
  })
  it("rejects empty ids", () => {
    const r = bulkDispatchRequestSchema.safeParse({
      ids: [],
      params: {},
      idempotencyKey: UUID,
    })
    expect(r.success).toBe(false)
  })
  it("rejects ids.length > 100", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`)
    const r = bulkDispatchRequestSchema.safeParse({
      ids,
      params: {},
      idempotencyKey: UUID,
    })
    expect(r.success).toBe(false)
  })
  it("rejects duplicate ids", () => {
    const r = bulkDispatchRequestSchema.safeParse({
      ids: ["a", "a"],
      params: {},
      idempotencyKey: UUID,
    })
    expect(r.success).toBe(false)
  })
  it("accepts valid request", () => {
    const r = bulkDispatchRequestSchema.safeParse({
      ids: ["a", "b"],
      params: { closedReason: "resolved" },
      idempotencyKey: UUID,
    })
    expect(r.success).toBe(true)
  })
  it("response shape includes errors[] and items[]", () => {
    const r = bulkDispatchResponseSchema.safeParse({
      bulkRequestId: UUID,
      total: 1,
      succeeded: 1,
      failed: 0,
      approvalsCreated: 0,
      errors: [],
      items: [{ id: "x", status: "succeeded" }],
    })
    expect(r.success).toBe(true)
  })
})
