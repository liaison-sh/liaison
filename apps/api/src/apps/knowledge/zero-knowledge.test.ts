// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Zero-knowledge HTTP collapse — byte-equality contract for the route helper.
 *
 * The route handlers route both FORBIDDEN (caller cannot see this row) and
 * NOT_FOUND (no such row) through `zeroKnowledgeResponse`. The contract is
 * that an unauthorized caller poking at a real-but-forbidden id sees the
 * *exact same* response body and status as a random UUID — bytes, status,
 * headers (BS-cross-cutting, IT-6, BC-6).
 *
 * A full HTTP-fetch test would require booting the app + auth flow + scope
 * grants + an isolated DB schema. The byte-equality property lives in the
 * helper itself; mutating the helper to vary the message between branches
 * would be immediately caught here without the harness cost.
 */

import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { zeroKnowledgeResponse } from "~/apps/knowledge/routes"
import { KnowledgeError } from "~/apps/knowledge/service"

function mountProbe() {
  const app = new Hono()
  app.get("/forbidden", (c) =>
    zeroKnowledgeResponse(c as never, new KnowledgeError("FORBIDDEN", "actually forbidden")),
  )
  app.get("/not-found", (c) =>
    zeroKnowledgeResponse(c as never, new KnowledgeError("NOT_FOUND", "no such row")),
  )
  return app
}

describe("zero-knowledge HTTP collapse", () => {
  it("FORBIDDEN and NOT_FOUND return byte-identical 404 responses", async () => {
    const app = mountProbe()
    const r1 = await app.request("/forbidden")
    const r2 = await app.request("/not-found")
    expect(r1.status).toBe(404)
    expect(r2.status).toBe(404)
    const b1 = await r1.text()
    const b2 = await r2.text()
    expect(b1).toBe(b2)
    expect(JSON.parse(b1)).toEqual({
      error: { message: "Knowledge item not found", code: "NOT_FOUND" },
    })
  })

  it("body never leaks the original FORBIDDEN/NOT_FOUND message", async () => {
    const app = mountProbe()
    const text = await (await app.request("/forbidden")).text()
    expect(text).not.toContain("actually forbidden")
    const text2 = await (await app.request("/not-found")).text()
    expect(text2).not.toContain("no such row")
  })
})
