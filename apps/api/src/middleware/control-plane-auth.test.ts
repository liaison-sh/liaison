// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { requireControlPlaneAuth } from "./control-plane-auth"

function makeApp(apiKey: string | undefined) {
  const app = new Hono()
  app.use("/x", requireControlPlaneAuth(apiKey))
  app.get("/x", (c) => c.json({ data: "ok" }))
  return app
}

describe("requireControlPlaneAuth", () => {
  test("404s when apiKey is undefined", async () => {
    const app = makeApp(undefined)
    const r = await app.request("/x", { headers: { authorization: "Bearer anything" } })
    expect(r.status).toBe(404)
  })

  test("401 when Authorization header missing", async () => {
    const app = makeApp("secret")
    const r = await app.request("/x")
    expect(r.status).toBe(401)
    const body = await r.json()
    expect(body).toEqual({ error: { message: "unauthorized", code: "unauthorized" } })
  })

  test("401 when bearer mismatched", async () => {
    const app = makeApp("secret")
    const r = await app.request("/x", { headers: { authorization: "Bearer wrong" } })
    expect(r.status).toBe(401)
  })

  test("200 with correct bearer", async () => {
    const app = makeApp("secret")
    const r = await app.request("/x", { headers: { authorization: "Bearer secret" } })
    expect(r.status).toBe(200)
  })

  test("case-insensitive bearer scheme", async () => {
    const app = makeApp("secret")
    const r = await app.request("/x", { headers: { authorization: "bearer secret" } })
    expect(r.status).toBe(200)
  })

  test("401 leaks no body detail (consistent on mismatch and missing)", async () => {
    const app = makeApp("secret")
    const r1 = await app.request("/x")
    const r2 = await app.request("/x", { headers: { authorization: "Bearer wrong" } })
    expect(await r1.json()).toEqual(await r2.json())
  })

  test("logs non-reversible token fingerprint on mismatch (Amendment 4)", async () => {
    let captured: unknown
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      captured = args
    }
    const app = makeApp("secret")
    await app.request("/x", { headers: { authorization: "Bearer abcdefghij1234567890" } })
    console.warn = orig
    const serialized = JSON.stringify(captured)
    expect(serialized).toMatch(/tokenFingerprint/)
    expect(serialized).toMatch(/[0-9a-f]{8}/)
    expect(serialized).not.toMatch(/abcdefghij/)
    expect(serialized).not.toMatch(/ij1234567890/)
  })
})
