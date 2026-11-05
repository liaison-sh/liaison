// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { app } from "~/app"

describe("auth middleware covers root routes", () => {
  it("GET /api/contacts requires auth (root path, not just wildcard)", async () => {
    const res = await app.request("/api/contacts")
    expect(res.status).toBe(401)
  })

  it("GET /api/org requires auth", async () => {
    const res = await app.request("/api/org")
    expect(res.status).toBe(401)
  })

  it("GET /api/audit requires auth", async () => {
    const res = await app.request("/api/audit")
    expect(res.status).toBe(401)
  })

  it("GET /api/search requires auth", async () => {
    const res = await app.request("/api/search")
    expect(res.status).toBe(401)
  })

  it("GET /api/mentions requires auth", async () => {
    const res = await app.request("/api/mentions")
    expect(res.status).toBe(401)
  })

  it("GET /api/references requires auth", async () => {
    const res = await app.request("/api/references")
    expect(res.status).toBe(401)
  })

  it("GET /api/users requires auth", async () => {
    const res = await app.request("/api/users")
    expect(res.status).toBe(401)
  })

  it("GET /api/timeline requires auth", async () => {
    const res = await app.request("/api/timeline")
    expect(res.status).toBe(401)
  })

  it("GET /api/apps requires auth", async () => {
    const res = await app.request("/api/apps")
    expect(res.status).toBe(401)
  })
})
