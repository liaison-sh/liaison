// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import type { Context } from "hono"
import { env } from "~/lib/env"
import {
  buildTrustedProxyList,
  effectiveRequestFromRaw,
  getClientIp,
  isTrustedProxyAddress,
  signEdgeHeaders,
} from "~/lib/request-context"

// Minimal mock of Hono Context
function mockContext(headers: Record<string, string>) {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()]
      },
      raw: { headers: new Headers(headers) },
    },
    env: { remoteAddr: headers.__remote_addr },
  } as any
}

describe("getClientIp — behind proxy (TRUSTED_PROXY_HOPS=1)", () => {
  const hops = 1

  it("takes the entry the trusted proxy appended (rightmost), never a client-supplied one", () => {
    // nginx $proxy_add_x_forwarded_for: "<client-sent>, <real peer>"
    const c = mockContext({ "x-forwarded-for": "1.2.3.4, 203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("is not moved by a spoofed leading chain", () => {
    const c = mockContext({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("returns the single entry of an overwriting proxy (Caddy default)", () => {
    const c = mockContext({ "x-forwarded-for": "203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("ignores x-real-ip and falls back to the socket peer without x-forwarded-for", () => {
    const c = mockContext({ "x-real-ip": "203.0.113.50", "x-bun-socket-ip": "10.0.0.9" })
    expect(getClientIp(c, hops)).toBe("10.0.0.9")
  })

  it("returns 'unknown-ip' fallback when no headers present", () => {
    const c = mockContext({})
    const ip = getClientIp(c, hops)
    expect(ip).toBe("unknown-ip")
  })

  it("trims whitespace from IP addresses", () => {
    const c = mockContext({ "x-forwarded-for": "  10.0.0.1 , 203.0.113.1  " })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("refuses an oversized junk entry rather than keying a limiter on it", () => {
    const c = mockContext({
      "x-forwarded-for": `1.1.1.1, ${"a".repeat(200)}`,
      "x-bun-socket-ip": "10.0.0.9",
    })
    expect(getClientIp(c, hops)).toBe("10.0.0.9")
  })
})

describe("getClientIp — two trusted proxies (TRUSTED_PROXY_HOPS=2)", () => {
  it("skips the inner proxy's entry and takes the client the outer one appended", () => {
    const c = mockContext({ "x-forwarded-for": "6.6.6.6, 203.0.113.1, 172.16.0.5" })
    expect(getClientIp(c, 2)).toBe("203.0.113.1")
  })

  it("uses the leftmost entry when the chain is shorter than configured", () => {
    const c = mockContext({ "x-forwarded-for": "203.0.113.1" })
    expect(getClientIp(c, 2)).toBe("203.0.113.1")
  })
})

describe("getClientIp — direct connection (TRUSTED_PROXY_HOPS=0)", () => {
  const hops = 0

  it("returns x-bun-socket-ip when available", () => {
    const c = mockContext({ "x-bun-socket-ip": "127.0.0.1" })
    expect(getClientIp(c, hops)).toBe("127.0.0.1")
  })

  it("ignores x-forwarded-for and uses socket IP", () => {
    const c = mockContext({
      "x-forwarded-for": "203.0.113.1",
      "x-bun-socket-ip": "10.0.0.5",
    })
    expect(getClientIp(c, hops)).toBe("10.0.0.5")
  })

  it("returns 'unknown-ip' fallback when no socket IP header", () => {
    const c = mockContext({})
    const ip = getClientIp(c, hops)
    expect(ip).toBe("unknown-ip")
  })
})

describe("getClientIp — only a trusted proxy peer may forward", () => {
  it("ignores X-Forwarded-For from a public socket peer (the app port reached directly)", () => {
    const c = mockContext({ "x-forwarded-for": "1.2.3.4", "x-bun-socket-ip": "198.51.100.7" })
    expect(getClientIp(c, 1)).toBe("198.51.100.7")
  })

  it("reads it from a private or loopback peer, including a v4-mapped v6 address", () => {
    for (const peer of ["172.18.0.3", "127.0.0.1", "::ffff:10.1.2.3", "::1"]) {
      const c = mockContext({ "x-forwarded-for": "203.0.113.1", "x-bun-socket-ip": peer })
      expect(getClientIp(c, 1)).toBe("203.0.113.1")
    }
  })

  it("trusts operator-listed CIDRs on top of the private ranges", () => {
    const list = buildTrustedProxyList("198.51.100.0/24, not-a-cidr")
    expect(isTrustedProxyAddress(list, "198.51.100.7")).toBe(true)
    expect(isTrustedProxyAddress(list, "198.51.101.7")).toBe(false)
    expect(isTrustedProxyAddress(list, "10.0.0.1")).toBe(true)
    expect(isTrustedProxyAddress(list, "garbage")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// effectiveRequest: the edge seam (LIAISON_EDGE_MODE). Each mode is exercised
// on raw requests, as both the Hono path and the WebSocket upgrade read it.
// ---------------------------------------------------------------------------

describe("effectiveRequestFromRaw", () => {
  const SECRET = "edge-secret-for-tests-0123456789abcdef"
  const saved = { mode: env.LIAISON_EDGE_MODE, secret: env.LIAISON_EDGE_SECRET }
  afterEach(() => {
    env.LIAISON_EDGE_MODE = saved.mode
    env.LIAISON_EDGE_SECRET = saved.secret
  })
  const req = (headers: Record<string, string>, path = "/api/x?q=1", method = "GET") =>
    new Request(`http://cell-1-origin.example.com${path}`, { method, headers })

  it("unset: the Host header, and CF-Connecting-IP is never read", () => {
    env.LIAISON_EDGE_MODE = undefined
    const r = effectiveRequestFromRaw(
      req({ host: "acme.example.com", "cf-connecting-ip": "203.0.113.9" }),
      "127.0.0.1",
    )
    expect(r.host).toBe("acme.example.com")
    expect(r.clientIp).not.toBe("203.0.113.9")
  })

  it("direct: Host header; CF-Connecting-IP only from a loopback peer", () => {
    env.LIAISON_EDGE_MODE = "direct"
    const headers = { host: "Acme.Example.com", "cf-connecting-ip": "203.0.113.9" }
    const viaTunnel = effectiveRequestFromRaw(req(headers), "127.0.0.1")
    expect(viaTunnel).toEqual({ host: "acme.example.com", clientIp: "203.0.113.9" })
    expect(effectiveRequestFromRaw(req(headers), "::1").clientIp).toBe("203.0.113.9")
    // From anywhere else the header is the client's own claim.
    expect(effectiveRequestFromRaw(req(headers), "198.51.100.7").clientIp).toBe("198.51.100.7")
    // Junk in the header is not an address.
    expect(
      effectiveRequestFromRaw(
        req({ host: "a.example.com", "cf-connecting-ip": "nope" }),
        "127.0.0.1",
      ).clientIp,
    ).not.toBe("nope")
  })

  function signed(
    over: Partial<{ host: string; ip: string; ts: number; sigHost: string; method: string }> = {},
  ) {
    const host = over.host ?? "acme.example.com"
    const ip = over.ip ?? "203.0.113.9"
    const ts = over.ts ?? Math.floor(Date.now() / 1000)
    const sig = signEdgeHeaders(SECRET, {
      host: over.sigHost ?? host,
      ts,
      method: over.method ?? "GET",
      path: "/api/x",
      clientIp: ip,
    })
    return {
      host: "cell-1-origin.example.com",
      "x-liaison-host": host,
      "x-liaison-client-ip": ip,
      "x-liaison-ts": String(ts),
      "x-liaison-host-sig": sig,
    }
  }

  it("signed: a valid, fresh signature gives the edge's host and client address", () => {
    env.LIAISON_EDGE_MODE = "signed"
    env.LIAISON_EDGE_SECRET = SECRET
    expect(effectiveRequestFromRaw(req(signed()), "127.0.0.1")).toEqual({
      host: "acme.example.com",
      clientIp: "203.0.113.9",
    })
  })

  it("signed: a forged, stale or replayed-elsewhere signature gives no host", () => {
    env.LIAISON_EDGE_MODE = "signed"
    env.LIAISON_EDGE_SECRET = SECRET
    const peer = "127.0.0.1"
    // Signed for another host.
    expect(effectiveRequestFromRaw(req(signed({ sigHost: "evil.example.com" })), peer)).toEqual({
      host: null,
      clientIp: peer,
    })
    // Outside the ±60 s window.
    const stale = signed({ ts: Math.floor(Date.now() / 1000) - 120 })
    expect(effectiveRequestFromRaw(req(stale), peer).host).toBeNull()
    // Signed for another method.
    expect(effectiveRequestFromRaw(req(signed({ method: "POST" })), peer).host).toBeNull()
    // Signed for another path.
    expect(effectiveRequestFromRaw(req(signed(), "/api/other"), peer).host).toBeNull()
    // Missing headers: the raw Host is never trusted in this mode.
    expect(effectiveRequestFromRaw(req({ host: "acme.example.com" }), peer).host).toBeNull()
    // Wrong secret.
    env.LIAISON_EDGE_SECRET = "another-secret-entirely-0123456789abcd"
    expect(effectiveRequestFromRaw(req(signed()), peer).host).toBeNull()
  })

  it("getClientIp reads the seam when an edge mode is set", () => {
    env.LIAISON_EDGE_MODE = "direct"
    const raw = req({ host: "a.example.com", "cf-connecting-ip": "203.0.113.9" })
    const c = {
      req: {
        raw,
        header: (name: string) =>
          name.toLowerCase() === "x-bun-socket-ip"
            ? "127.0.0.1"
            : (raw.headers.get(name) ?? undefined),
      },
    } as unknown as Context
    expect(getClientIp(c)).toBe("203.0.113.9")
  })
})
