// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import {
  bindingCookie,
  connectBindingMatches,
  setConnectBindingCookie,
} from "~/lib/oauth-browser-binding"
import { redis } from "~/lib/redis"
import { handleOAuthCallback, OAuthBrowserMismatchError } from "~/modules/apps/connections/service"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
/** The per-flow cookie name: the base name and a short hash of the state. */
const named = (base: string, state: string) => `${base}_${sha(state).slice(0, 16)}`

describe("connect-flow browser binding", () => {
  it("sets an HttpOnly cookie scoped to the callback path, holding a hash of the state", async () => {
    const app = new Hono().get("/start", (c) => {
      setConnectBindingCookie(c, "__connect_state", "/api/connections/callback", "state-abc")
      return c.text("ok")
    })
    const res = await app.request("/start")
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain(`${named("__connect_state", "state-abc")}=${sha("state-abc")}`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/api/connections/callback")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).not.toContain("state-abc;")
  })

  it("matches only the cookie derived from the same state", () => {
    const good = `a=b; ${named("__connect_state", "s1")}=${sha("s1")}; c=d`
    expect(connectBindingMatches(good, "__connect_state", "s1")).toBe(true)
    expect(connectBindingMatches(good, "__connect_state", "s2")).toBe(false)
    expect(connectBindingMatches(undefined, "__connect_state", "s1")).toBe(false)
    expect(
      connectBindingMatches(`${named("__connect_state", "s1")}=zzzz`, "__connect_state", "s1"),
    ).toBe(false)
    expect(connectBindingMatches(`__other=${sha("s1")}`, "__connect_state", "s1")).toBe(false)
    // The old shared name is not a binding any more.
    expect(connectBindingMatches(`__connect_state=${sha("s1")}`, "__connect_state", "s1")).toBe(
      false,
    )
  })

  it("two flows in one browser keep their own cookies: the second does not overwrite the first", async () => {
    const app = new Hono().get("/start/:s", (c) => {
      setConnectBindingCookie(c, "__connect_state", "/api/connections/callback", c.req.param("s"))
      return c.text("ok")
    })
    const a = ((await app.request("/start/card")).headers.get("set-cookie") ?? "").split(";")[0]
    const b = ((await app.request("/start/settings")).headers.get("set-cookie") ?? "").split(";")[0]
    expect(a?.split("=")[0]).not.toBe(b?.split("=")[0])
    const jar = `${a}; ${b}`
    expect(connectBindingMatches(jar, "__connect_state", "card")).toBe(true)
    expect(connectBindingMatches(jar, "__connect_state", "settings")).toBe(true)
    expect(connectBindingMatches(b, "__connect_state", "card")).toBe(false)
  })

  it("in production reads only a __Host- cookie, which a sibling subdomain cannot plant", () => {
    expect(bindingCookie("__connect_state", "/api/connections/callback", true, "s1")).toEqual({
      name: `__Host-${named("connect_state", "s1")}`,
      path: "/",
    })
    const planted = `${named("__connect_state", "s1")}=${sha("s1")}`
    expect(connectBindingMatches(planted, "__connect_state", "s1", true)).toBe(false)
    const real = `__Host-${named("connect_state", "s1")}=${sha("s1")}`
    expect(connectBindingMatches(real, "__connect_state", "s1", true)).toBe(true)
    expect(connectBindingMatches(`x${real}`, "__connect_state", "s1", true)).toBe(false)
  })

  it("refuses a callback from another browser, and still consumes the state", async () => {
    const state = `bind-test-${crypto.randomUUID()}`
    await redis.set(
      `oauth:state:${state}`,
      JSON.stringify({
        orgId: "o",
        userId: "u",
        appName: "mail",
        connectionName: "gmail",
        codeVerifier: "v",
        tokenUrl: "https://example.invalid/token",
        browserBound: true,
      }),
      "EX",
      60,
    )
    // A colleague opening a forwarded authorize link: no cookie from the initiator.
    await expect(handleOAuthCallback("code", state, undefined, undefined)).rejects.toBeInstanceOf(
      OAuthBrowserMismatchError,
    )
    expect(await redis.get(`oauth:state:${state}`)).toBeNull()

    // A different browser's cookie for a different state is no better.
    const state2 = `bind-test-${crypto.randomUUID()}`
    await redis.set(
      `oauth:state:${state2}`,
      JSON.stringify({
        orgId: "o",
        userId: "u",
        appName: "mail",
        connectionName: "gmail",
        codeVerifier: "v",
        tokenUrl: "https://example.invalid/token",
        browserBound: true,
      }),
      "EX",
      60,
    )
    await expect(
      handleOAuthCallback("code", state2, undefined, `__connect_state=${sha("someone-else")}`),
    ).rejects.toBeInstanceOf(OAuthBrowserMismatchError)
  })
})
