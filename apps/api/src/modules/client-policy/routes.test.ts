// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client version policy (S4). The desktop and phone shells call this
// public route once after connecting, and only a server that answers it gets
// the `X-Liaison-Client` header afterwards; so the server has to (1) let that
// header through a cross-origin preflight one release BEFORE any shell sends
// it, and (2) publish per-platform minimums and nothing else.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env, envSchema } from "~/lib/env"
import { CLIENT_POLICY_RATE_LIMIT } from "~/middleware/public-surface-limits"
import { CLIENT_HEADER } from "~/modules/client-policy/routes"

const octet = () => Math.floor(Math.random() * 250) + 1
const randomIp = () => `198.51.${octet()}.${octet()}`

describe("client policy: CORS", () => {
  it("a shell's preflight may carry the X-Liaison-Client header", async () => {
    const res = await app.request("/api/client-policy", {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type,x-liaison-client",
      },
    })
    expect(res.status).toBeLessThan(300)
    const allowed = (res.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim())
    expect(CLIENT_HEADER).toBe("X-Liaison-Client")
    expect(allowed).toContain("x-liaison-client")
  })
})

describe("GET /api/client-policy", () => {
  const saved = {
    desktop: env.LIAISON_MIN_CLIENT_DESKTOP,
    ios: env.LIAISON_MIN_CLIENT_IOS,
    android: env.LIAISON_MIN_CLIENT_ANDROID,
  }
  afterEach(() => {
    env.LIAISON_MIN_CLIENT_DESKTOP = saved.desktop
    env.LIAISON_MIN_CLIENT_IOS = saved.ios
    env.LIAISON_MIN_CLIENT_ANDROID = saved.android
  })

  it("defaults the minimums when unset or empty, and refuses a non-semver value", () => {
    const parsed = envSchema.parse({
      ...process.env,
      LIAISON_MIN_CLIENT_DESKTOP: undefined,
      LIAISON_MIN_CLIENT_IOS: "",
      LIAISON_MIN_CLIENT_ANDROID: " ",
    })
    expect(parsed.LIAISON_MIN_CLIENT_DESKTOP).toBe("0.1.33")
    expect(parsed.LIAISON_MIN_CLIENT_IOS).toBe("1.0.34")
    expect(parsed.LIAISON_MIN_CLIENT_ANDROID).toBe("0.0.0")
    const bad = envSchema.safeParse({ ...process.env, LIAISON_MIN_CLIENT_DESKTOP: "v0.1" })
    expect(bad.success).toBe(false)
  })

  it("answers without a credential with exactly the three minimums", async () => {
    const res = await app.request("/api/client-policy", {
      headers: { [CLIENT_HEADER]: "desktop/0.1.35" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    // A public answer: the key set is pinned so a later field is a failing test.
    expect(Object.keys(body).sort()).toEqual(["data"])
    expect(Object.keys(body.data).sort()).toEqual(["android", "desktop", "ios"])
    expect(body.data).toEqual({
      desktop: env.LIAISON_MIN_CLIENT_DESKTOP,
      ios: env.LIAISON_MIN_CLIENT_IOS,
      android: env.LIAISON_MIN_CLIENT_ANDROID,
    })
  })

  it("publishes the operator's minimums from the environment", async () => {
    env.LIAISON_MIN_CLIENT_DESKTOP = "0.2.0"
    env.LIAISON_MIN_CLIENT_IOS = "1.0.40"
    env.LIAISON_MIN_CLIENT_ANDROID = "0.1.0"
    const res = await app.request("/api/client-policy")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual({ desktop: "0.2.0", ios: "1.0.40", android: "0.1.0" })
  })

  it("never uses the client header for access: a garbage value changes nothing", async () => {
    const res = await app.request("/api/client-policy", {
      headers: { [CLIENT_HEADER]: "x".repeat(500) },
    })
    expect(res.status).toBe(200)
  })
})

describe("GET /api/client-policy rate limit", () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.RATE_LIMIT_FORCE_ENABLED
    process.env.RATE_LIMIT_FORCE_ENABLED = "true"
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = prev
  })

  it("is throttled per address by its own budget", async () => {
    const ip = randomIp()
    const statuses: number[] = []
    for (let i = 0; i < CLIENT_POLICY_RATE_LIMIT + 2; i++) {
      const res = await app.request("/api/client-policy", {
        headers: { "x-forwarded-for": ip },
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, CLIENT_POLICY_RATE_LIMIT).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(CLIENT_POLICY_RATE_LIMIT).every((s) => s === 429)).toBe(true)
  })
})
