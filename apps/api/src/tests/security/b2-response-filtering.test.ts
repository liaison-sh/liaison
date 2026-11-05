// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedExternalApiMockOver10Rows } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B2 — Path B response filtering preserves no count metadata", () => {
  test("external-API mock returns 10 rows; user with 3 visible markets receives exactly 3 with no count leak", async () => {
    const { mockProvider, tokenB } = await seedExternalApiMockOver10Rows(3)
    const app = await buildTestApp()
    const r = await app.request(mockProvider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      body: JSON.stringify({ params: { query: "" } }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: unknown; meta?: { total?: number } }
    const items = (Array.isArray(body.data) ? body.data : []) as Array<{ market: string }>
    expect(items.length).toBe(3)
    expect(items.every((i) => i.market === "us")).toBe(true)
    // No-count-leak: if the envelope carries `meta.total`, it must reflect
    // the *filtered* count (3), never the underlying provider count (10).
    if (body.meta?.total !== undefined) {
      expect(body.meta.total).toBe(3)
    }
  })

  test("user with 0 visible markets receives an empty list and no metadata about underlying rows", async () => {
    const { mockProvider, tokenB } = await seedExternalApiMockOver10Rows(0)
    const app = await buildTestApp()
    const r = await app.request(mockProvider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      body: JSON.stringify({ params: { query: "" } }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: unknown; meta?: { total?: number } }
    const items = (Array.isArray(body.data) ? body.data : []) as unknown[]
    expect(items.length).toBe(0)
    if (body.meta?.total !== undefined) {
      expect(body.meta.total).toBe(0)
    }
  })
})
