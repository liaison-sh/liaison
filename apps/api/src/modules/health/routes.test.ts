// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env } from "~/lib/env"

describe("GET /api/health", () => {
  it("returns 200 with ok status", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body).toEqual({
      data: { status: "ok" },
    })
  })

  it("does not require authentication", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
  })
})

describe("GET /api/health/ready", () => {
  const LOCAL = { "x-bun-socket-ip": "127.0.0.1" }

  it("gives a local operator the db and redis detail", async () => {
    const res = await app.request("/api/health/ready", { headers: LOCAL })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.db).toBe("ok")
    expect(body.data.redis).toBe("ok")
    expect(body.data.status).toBe("ready")
  })

  // Same rule as /healthz: dependency detail is reconnaissance, so the public
  // internet (no private socket peer, or any proxy trace) gets the bare verdict.
  const publicCallers: Record<string, Record<string, string>> = {
    "no socket peer": {},
    "public peer": { "x-bun-socket-ip": "203.0.113.9" },
    "private peer behind a proxy": {
      "x-bun-socket-ip": "127.0.0.1",
      "x-forwarded-for": "203.0.113.9",
    },
    "wrong bearer token": { "x-bun-socket-ip": "203.0.113.9", authorization: "Bearer nope" },
  }
  for (const [name, headers] of Object.entries(publicCallers)) {
    it(`answers only ready/not-ready to a public caller (${name})`, async () => {
      const res = await app.request("/api/health/ready", { headers })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { status: "ready" } })
    })
  }

  it("gives the monitor token holder the detail from a public address", async () => {
    const prev = env.MONITOR_TOKEN
    ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = "monitor-secret-for-ready-test"
    try {
      const res = await app.request("/api/health/ready", {
        headers: {
          "x-bun-socket-ip": "203.0.113.9",
          authorization: "Bearer monitor-secret-for-ready-test",
        },
      })
      const body = (await res.json()) as any
      expect(body.data.db).toBe("ok")
      expect(body.data.redis).toBe("ok")
    } finally {
      ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = prev
    }
  })
})
