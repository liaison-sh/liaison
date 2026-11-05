// SPDX-License-Identifier: FSL-1.1-ALv2
// A request body array with a length cap must be refused on its length, not
// after one validation issue per element: a 1 MB body of 500 000 wrong-typed
// elements would otherwise allocate hundreds of MB of issue objects.
import { describe, expect, it } from "bun:test"
import { z } from "zod"

describe("zod: capped arrays are refused on length first", () => {
  it("a 500 000-element bad array against .max(n) yields a bounded issue list", () => {
    const body = JSON.parse(`{"ids":[${Array(500_000).fill("0").join(",")}]}`)
    const schema = z.object({ ids: z.array(z.string().uuid()).max(10) })
    const result = schema.safeParse(body)
    expect(result.success).toBe(false)
    expect(result.error?.issues.length ?? 0).toBeLessThanOrEqual(10)
  })
})
