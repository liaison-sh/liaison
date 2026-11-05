// SPDX-License-Identifier: FSL-1.1-ALv2
// Request-duration window behind the managed /diag `http` field.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { _setEdition } from "~/lib/edition"
import {
  _resetLatencyWindow,
  latencySnapshot,
  latencyWindowMiddleware,
  recordRequestDuration,
  WINDOW_MS,
} from "~/lib/latency-window"

beforeEach(() => _resetLatencyWindow())
afterEach(() => _setEdition(null))

describe("latency window", () => {
  it("p95 of a known series (nearest rank)", () => {
    const now = 1_000_000
    for (let i = 1; i <= 100; i++) recordRequestDuration(i, now)
    expect(latencySnapshot(now)).toEqual({ p95Ms: 95, count: 100, windowS: WINDOW_MS / 1000 })
  })

  it("empty window -> p95 null, count 0", () => {
    expect(latencySnapshot(5)).toEqual({ p95Ms: null, count: 0, windowS: 900 })
  })

  it("samples older than the window expire", () => {
    recordRequestDuration(9000, 0)
    for (let i = 0; i < 10; i++) recordRequestDuration(10, WINDOW_MS + 1)
    expect(latencySnapshot(WINDOW_MS + 1)).toMatchObject({ p95Ms: 10, count: 10 })
    expect(latencySnapshot(2 * WINDOW_MS + 5)).toMatchObject({ p95Ms: null, count: 0 })
  })

  it("memory is fixed: the ring keeps only the newest samples", () => {
    for (let i = 0; i < 20_000; i++) recordRequestDuration(1, 100)
    expect(latencySnapshot(100).count).toBeLessThanOrEqual(4096)
  })

  it("records what says something about the cell, not a wait on a model or on a provider's call", async () => {
    const app = new Hono()
    app.use("*", latencyWindowMiddleware())
    app.all("*", (c) => c.text("ok"))
    _setEdition("managed")
    for (const path of [
      "/api/agent/chat",
      "/api/assist/transcribe",
      "/api/assist/proofread",
      "/api/cloud/orgs",
      "/webhooks/org/stripe",
      "/mcp",
    ]) {
      await app.request(path, { method: "POST" })
    }
    expect(latencySnapshot().count).toBe(0)
    await app.request("/api/threads/t/messages", { method: "POST" })
    await app.request("/api/assistant-notes")
    await app.request("/mcpish")
    expect(latencySnapshot().count).toBe(3)
    _setEdition(null)
  })

  it("middleware records in the managed edition only, and skips probe paths", async () => {
    const app = new Hono()
    app.use("*", latencyWindowMiddleware())
    app.get("/x", (c) => c.text("ok"))
    app.get("/healthz", (c) => c.text("ok"))
    _setEdition("managed")
    await app.request("/x")
    await app.request("/healthz")
    expect(latencySnapshot().count).toBe(1)
    _resetLatencyWindow()
    _setEdition("self_hosted")
    await app.request("/x")
    expect(latencySnapshot().count).toBe(0)
  })
})
