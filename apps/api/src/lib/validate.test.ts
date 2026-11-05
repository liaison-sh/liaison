// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "~/lib/validate"

describe("zValidator envelope", () => {
  const app = new Hono()
  app.post(
    "/test",
    zValidator("json", z.object({ name: z.string().min(1), age: z.number().int() })),
    (c) => {
      return c.json({ data: c.req.valid("json") })
    },
  )

  it("returns standard error envelope on validation failure", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", age: "not-a-number" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    // Must match { error: { message, code } } envelope
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(typeof body.error.message).toBe("string")
    expect(body.error.message.length).toBeGreaterThan(0)
    // Must NOT contain raw Zod error fields
    expect(body.issues).toBeUndefined()
    expect(body.error.issues).toBeUndefined()
  })

  it("includes field paths in error message", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: 3.5 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    // Should mention the field names that failed
    expect(body.error.message).toContain("name")
    expect(body.error.message).toContain("age")
  })

  it("passes valid input through", async () => {
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", age: 30 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ name: "Alice", age: 30 })
  })
})
